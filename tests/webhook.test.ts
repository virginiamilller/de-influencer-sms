import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerate = vi.hoisted(() => vi.fn());

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: mockGenerate };
    }
  },
}));

import { POST } from "../app/api/webhook/route";

const TOKEN = "test_token";
const URL_ = "https://example.test/api/webhook";
const PHONE = "+15551230001";

function geminiText(text: string) {
  return { response: { text: () => text } };
}

/** Builds a Twilio-style POST with a valid X-Twilio-Signature unless `sign` is false. */
function twilioRequest(params: Record<string, string>, { sign = true } = {}) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (sign) headers["x-twilio-signature"] = twilio.getExpectedTwilioSignature(TOKEN, URL_, params);
  return new Request(URL_, {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  });
}

async function send(body: string, extra: Record<string, string> = {}) {
  const res = await POST(twilioRequest({ From: PHONE, To: "+15557654321", Body: body, ...extra }));
  return res.text();
}

/** Extracts the SMS body and decodes the XML entities the route escapes. */
const message = (xml: string) =>
  xml
    .match(/<Message>([\s\S]*?)<\/Message>/)?.[1]
    ?.replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__deInfluencerKv;
  delete (globalThis as Record<string, unknown>).__deInfluencerConversationStore;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.PUBLIC_WEBHOOK_URL = URL_;
  process.env.GEMINI_API_KEY = "test-key";
  vi.stubEnv("NODE_ENV", "test");
  mockGenerate.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.PUBLIC_WEBHOOK_URL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.DAILY_MESSAGE_CAP;
  delete process.env.PAUSE_REPLIES;
  vi.unstubAllGlobals();
});

describe("webhook authentication", () => {
  it("rejects unsigned requests before reading the body", async () => {
    const res = await POST(twilioRequest({ From: PHONE, Body: "START" }, { sign: false }));
    expect(res.status).toBe(403);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns 500 when TWILIO_AUTH_TOKEN is missing", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await POST(twilioRequest({ From: PHONE, Body: "START" }));
    expect(res.status).toBe(500);
  });

  it("rejects a request signed with the wrong token", async () => {
    const params = { From: PHONE, Body: "START" };
    const req = new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature("other_token", URL_, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    expect((await POST(req)).status).toBe(403);
  });

  it("requires From", async () => {
    const res = await POST(twilioRequest({ Body: "START" }));
    expect(res.status).toBe(400);
  });
});

describe("opt-in and opt-out", () => {
  it("asks a new number to text START", async () => {
    const xml = await send("should I buy this blazer");
    expect(message(xml)).toContain("Text START to sign up");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("subscribes on START and then roasts", async () => {
    expect(message(await send("START"))).toContain("You've opted in");
    mockGenerate.mockResolvedValueOnce(geminiText("Sandra reply\n\nAziz reply"));
    const xml = await send("should I buy this blazer");
    expect(message(xml)).toContain("Sandra reply");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("answers HELP with contact info", async () => {
    expect(message(await send("HELP"))).toContain("Reply STOP to unsubscribe");
  });

  it("honors STOP with no reply and blocks later messages until START", async () => {
    await send("START");
    expect(await send("STOP")).not.toContain("<Message>");

    expect(await send("should I buy this")).not.toContain("<Message>");
    expect(mockGenerate).not.toHaveBeenCalled();

    expect(message(await send("START"))).toContain("You've opted in");
  });

  it("still honors STOP when the daily cap is exhausted", async () => {
    process.env.DAILY_MESSAGE_CAP = "1";
    await send("START");
    expect(await send("STOP")).not.toContain("<Message>");
  });
});

describe("daily cap", () => {
  it("goes silent after the cap is reached", async () => {
    process.env.DAILY_MESSAGE_CAP = "2";
    mockGenerate.mockResolvedValue(geminiText("A reply"));
    expect(message(await send("START"))).toContain("You've opted in"); // 1
    expect(message(await send("should I buy this coat"))).toContain("A reply"); // 2
    expect(await send("should I buy this other coat")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response/>`,
    ); // 3 over cap
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("defaults to 50 messages per day", async () => {
    await send("START");
    for (let i = 0; i < 49; i++) await send("hello there friend, buy this");
    const over = await send("should I buy this one more time");
    expect(over).not.toContain("<Message>");
  });
});

describe("kill switch", () => {
  it("sends nothing while PAUSE_REPLIES=1", async () => {
    process.env.PAUSE_REPLIES = "1";
    expect(await send("START")).not.toContain("<Message>");
  });
});

describe("roast replies", () => {
  beforeEach(async () => {
    await send("START");
  });

  it("redirects profanity without calling Gemini", async () => {
    expect(message(await send("this is crap"))).toContain("Try asking me");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("redirects short greetings without calling Gemini", async () => {
    expect(message(await send("hi"))).toContain("Try asking me");
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns a friendly fallback when Gemini errors", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("quota exceeded"));
    const xml = await send("should I buy this jacket");
    expect(message(xml)).toContain("tripped over its own shoelaces");
    expect(xml).not.toMatch(/quota exceeded/);
  });

  it("returns a fallback when Gemini is too slow", async () => {
    vi.useFakeTimers();
    try {
      mockGenerate.mockReturnValueOnce(new Promise(() => {}));
      const pending = send("should I buy this jacket");
      await vi.advanceTimersByTimeAsync(13_000);
      expect(message(await pending)).toContain("tripped over its own shoelaces");
    } finally {
      vi.useRealTimers();
    }
  });

  it("roasts a photo and enforces the rejection path for non-fashion items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } })),
    );
    mockGenerate.mockResolvedValueOnce(
      geminiText(
        JSON.stringify({
          item: "Dress",
          guessedPrice: 80,
          amountSaved: 80,
          sandra: "A dress.",
          aziz: "A DRESS!",
          practicalQuestion: "Can you rent this?",
        }),
      ),
    );
    const xml = await send("", { MediaUrl0: "https://api.twilio.com/media/1" });
    expect(message(xml)).toContain("A dress.");
    expect(message(xml)).toContain("Can you rent this?");

    mockGenerate.mockResolvedValueOnce(geminiText(JSON.stringify({ item: "REJECTED" })));
    const rejected = await send("", { MediaUrl0: "https://api.twilio.com/media/2" });
    expect(message(rejected)).toContain("Try asking me");
  });

  it("rejects non-image media with a helpful reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("video", { headers: { "content-type": "video/mp4" } })),
    );
    const xml = await send("", { MediaUrl0: "https://api.twilio.com/media/3" });
    expect(message(xml)).toContain("We can only roast photos");
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
