import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDailyMessageCap, DEFAULT_DAILY_MESSAGE_CAP, repliesPaused } from "../lib/config";
import { consumeDailyQuota, utcDayKey } from "../lib/daily-cap";
import { normalizePracticalQuestion, parseGeminiJson } from "../lib/gemini-parse";
import { parseKeyword } from "../lib/keywords";
import { containsInappropriateContent, isOffTopicGreeting } from "../lib/moderation";
import { getSubscriptionStatus, setSubscriptionStatus } from "../lib/subscribers";
import { checkTwilioSignature, publicWebhookUrl } from "../lib/twilio-signature";
import { escapeXml, twimlMessageResponse } from "../lib/twiml";
import { getKvStore } from "../lib/store";
import { withTimeout } from "../lib/with-timeout";

const KV_GLOBAL = "__deInfluencerKv";

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[KV_GLOBAL];
});

afterEach(() => {
  delete process.env.DAILY_MESSAGE_CAP;
  delete process.env.PAUSE_REPLIES;
});

describe("keywords", () => {
  it("maps Twilio/carrier keywords regardless of case and punctuation", () => {
    expect(parseKeyword("start")).toBe("START");
    expect(parseKeyword("  Stop. ")).toBe("STOP");
    expect(parseKeyword("UNSUBSCRIBE")).toBe("STOP");
    expect(parseKeyword("help!")).toBe("HELP");
    expect(parseKeyword("unstop")).toBe("START");
  });

  it("returns null for ordinary messages", () => {
    expect(parseKeyword("should I buy this blazer")).toBeNull();
    expect(parseKeyword("starting to think")).toBeNull();
  });
});

describe("moderation", () => {
  it("flags profanity and rude phrases", () => {
    expect(containsInappropriateContent("this is crap")).toBe(true);
    expect(containsInappropriateContent("you suck")).toBe(true);
  });

  it("does not flag normal shopping messages", () => {
    expect(containsInappropriateContent("should I buy this dress for a wedding?")).toBe(false);
  });

  it("treats short greetings as off-topic but not real questions", () => {
    expect(isOffTopicGreeting("hi")).toBe(true);
    expect(isOffTopicGreeting("hello there friend, is this a good coat")).toBe(false);
  });
});

describe("gemini parsing", () => {
  it("extracts JSON wrapped in prose or code fences", () => {
    const parsed = parseGeminiJson('```json\n{"item":"Dress","sandra":"x"}\n```');
    expect(parsed).toEqual({ item: "Dress", sandra: "x" });
  });

  it("returns null for non-JSON output", () => {
    expect(parseGeminiJson("no braces here")).toBeNull();
    expect(parseGeminiJson("{not json}")).toBeNull();
  });

  it("forces a valid practical question", () => {
    expect(normalizePracticalQuestion("Can you rent this?")).toBe("Can you rent this?");
    expect(normalizePracticalQuestion("something else")).toBe("Does a friend have one you can borrow?");
    expect(normalizePracticalQuestion(undefined)).toBe("Does a friend have one you can borrow?");
  });
});

describe("twiml", () => {
  it("escapes XML special characters in message bodies", () => {
    expect(escapeXml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
  });

  it("wraps text in a Message element", async () => {
    const res = twimlMessageResponse("hi & bye");
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(await res.text()).toContain("<Message>hi &amp; bye</Message>");
  });
});

describe("daily cap", () => {
  it("allows up to the cap and then blocks", async () => {
    const store = getKvStore();
    const now = new Date("2026-11-02T12:00:00Z");
    const results = [];
    for (let i = 0; i < 52; i++) results.push((await consumeDailyQuota(store, 50, now)).allowed);
    expect(results.slice(0, 50).every(Boolean)).toBe(true);
    expect(results.slice(50)).toEqual([false, false]);
  });

  it("resets on a new UTC day", async () => {
    const store = getKvStore();
    for (let i = 0; i < 3; i++) await consumeDailyQuota(store, 2, new Date("2026-11-02T23:59:00Z"));
    const next = await consumeDailyQuota(store, 2, new Date("2026-11-03T00:01:00Z"));
    expect(next.allowed).toBe(true);
    expect(next.count).toBe(1);
  });

  it("buckets by UTC date", () => {
    expect(utcDayKey(new Date("2026-11-02T23:30:00Z"))).toBe("2026-11-02");
  });

  it("defaults to 50 and accepts an env override", () => {
    expect(getDailyMessageCap()).toBe(DEFAULT_DAILY_MESSAGE_CAP);
    expect(DEFAULT_DAILY_MESSAGE_CAP).toBe(50);
    process.env.DAILY_MESSAGE_CAP = "10";
    expect(getDailyMessageCap()).toBe(10);
    process.env.DAILY_MESSAGE_CAP = "nonsense";
    expect(getDailyMessageCap()).toBe(50);
  });

  it("reads the kill switch", () => {
    expect(repliesPaused()).toBe(false);
    process.env.PAUSE_REPLIES = "1";
    expect(repliesPaused()).toBe(true);
  });
});

describe("subscribers", () => {
  it("is null until set, then reflects the latest status", async () => {
    const store = getKvStore();
    expect(await getSubscriptionStatus(store, "+15550000001")).toBeNull();
    await setSubscriptionStatus(store, "+15550000001", "active");
    expect(await getSubscriptionStatus(store, "+15550000001")).toBe("active");
    await setSubscriptionStatus(store, "+15550000001", "stopped");
    expect(await getSubscriptionStatus(store, "+15550000001")).toBe("stopped");
  });
});

describe("twilio signature", () => {
  const TOKEN = "test_token";
  const URL_ = "https://example.test/api/webhook";
  const params = { From: "+15551234567", Body: "START" };

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.PUBLIC_WEBHOOK_URL = URL_;
    delete process.env.TWILIO_SKIP_SIGNATURE_CHECK;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.PUBLIC_WEBHOOK_URL;
    delete process.env.TWILIO_SKIP_SIGNATURE_CHECK;
  });

  function req(headers: Record<string, string> = {}) {
    return new Request(URL_, { method: "POST", headers });
  }

  it("accepts a correctly signed request", () => {
    const signature = twilio.getExpectedTwilioSignature(TOKEN, URL_, params);
    expect(checkTwilioSignature(req({ "x-twilio-signature": signature }), params)).toEqual({ ok: true });
  });

  it("rejects a missing or wrong signature", () => {
    expect(checkTwilioSignature(req(), params)).toEqual({ ok: false, reason: "missing-signature" });
    expect(checkTwilioSignature(req({ "x-twilio-signature": "bogus" }), params)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a signature made for different params", () => {
    const signature = twilio.getExpectedTwilioSignature(TOKEN, URL_, { From: "+15550000000", Body: "START" });
    expect(checkTwilioSignature(req({ "x-twilio-signature": signature }), params).ok).toBe(false);
  });

  it("fails closed when no auth token is configured", () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(checkTwilioSignature(req({ "x-twilio-signature": "x" }), params)).toEqual({
      ok: false,
      reason: "missing-token",
    });
  });

  it("allows the local bypass outside production only", () => {
    process.env.TWILIO_SKIP_SIGNATURE_CHECK = "1";
    vi.stubEnv("NODE_ENV", "development");
    expect(checkTwilioSignature(req(), params).ok).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    expect(checkTwilioSignature(req(), params).ok).toBe(false);
  });

  it("prefers PUBLIC_WEBHOOK_URL, then forwarded headers", () => {
    expect(publicWebhookUrl(req())).toBe(URL_);
    delete process.env.PUBLIC_WEBHOOK_URL;
    const forwarded = new Request("http://internal:3000/api/webhook", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.test" },
    });
    expect(publicWebhookUrl(forwarded)).toBe("https://app.example.test/api/webhook");
  });
});

describe("withTimeout", () => {
  it("rejects when the promise is slower than the limit", async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve("late"), 200));
    await expect(withTimeout(slow, 20, "test")).rejects.toThrow("test timed out after 20ms");
  });

  it("resolves when the promise is fast enough", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });
});
