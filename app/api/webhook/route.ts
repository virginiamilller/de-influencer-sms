/**
 * Twilio inbound SMS webhook.
 *
 * Local test (set TWILIO_SKIP_SIGNATURE_CHECK=1 in .env.local; signature checks are skipped
 * only outside NODE_ENV=production). Send START first so the number is opted in:
 *
 * curl -X POST http://localhost:3004/api/webhook \
 *   -H "Content-Type: application/x-www-form-urlencoded" \
 *   -d "From=+15551234567" \
 *   -d "To=+15557654321" \
 *   -d "Body=START"
 */

import { Buffer } from "buffer";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { GEMINI_TIMEOUT_MS, getDailyMessageCap, repliesPaused } from "../../../lib/config";
import { consumeDailyQuota } from "../../../lib/daily-cap";
import { normalizePracticalQuestion, parseGeminiJson } from "../../../lib/gemini-parse";
import { parseKeyword } from "../../../lib/keywords";
import { containsInappropriateContent, isOffTopicGreeting } from "../../../lib/moderation";
import { getKvStore } from "../../../lib/store";
import { getSubscriptionStatus, setSubscriptionStatus } from "../../../lib/subscribers";
import { checkTwilioSignature } from "../../../lib/twilio-signature";
import { twimlEmptyResponse, twimlMessageResponse } from "../../../lib/twiml";
import { withTimeout } from "../../../lib/with-timeout";

export const runtime = "nodejs";
// Twilio gives up after about 15s. Give the function room for a slow photo fetch plus Gemini.
export const maxDuration = 30;

/** Thrown when the photo URL can't be downloaded. */
class PhotoFetchError extends Error {}
/** Thrown when the media isn't an image (video, audio). */
class PhotoTypeError extends Error {}

type ChatTurn = { role: "user" | "model"; text: string; at: number };

// TODO(phase 2): move conversation history to the same KV store as subscribers.
const globalWithHistory = globalThis as unknown as { __deInfluencerConversationStore?: Map<string, ChatTurn[]> };
const conversationStore: Map<string, ChatTurn[]> =
  globalWithHistory.__deInfluencerConversationStore ?? new Map<string, ChatTurn[]>();
globalWithHistory.__deInfluencerConversationStore = conversationStore;

const REDIRECT_MESSAGE = "Try asking me about something you're thinking of buying! 👔";
const FALLBACK_MESSAGE = "Our roast machine tripped over its own shoelaces 🫠. Try again in a few minutes.";
const PHOTO_FETCH_FAILED_MESSAGE = "We couldn't open that photo. Try sending it again?";
const PHOTO_TYPE_MESSAGE = "We can only roast photos right now. Send a picture of the item! 📸";
// Opt-in confirmation wording as approved (matches "agreement sms.pdf"): program, frequency, rates, STOP/HELP.
const WELCOME_MESSAGE =
  "Hey! 👋 You've opted in to De-Influencer SMS. Reply with any item you're thinking of buying and I'll talk you out of it (or not 😅). Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.";
const SIGNUP_PROMPT_MESSAGE = "Text START to sign up for De-Influencer SMS. Reply STOP anytime to unsubscribe.";
const HELP_MESSAGE =
  "De-Influencer SMS: text us something you're thinking of buying (photo optional) and we'll roast it kindly. Reply STOP to unsubscribe. Questions: virginia@virginiamiller.com";

const MODEL_NAME = "gemini-2.5-flash";

const BASE_PROMPT = `
You are generating an SMS roast from a de-influencer perspective.

⚠️ SAFETY CHECKS (DO THESE FIRST):
1. Verify the image is a product/retail item (not a meme, selfie, random photo)
2. Verify the product is FASHION/CLOTHING (dress, shoes, bag, jacket, accessories, etc.)
   - If it's NOT fashion (electronics, furniture, food, car, etc.) → REJECT with safety message
3. If the message contains profanity, rudeness, or is off-topic → REJECT with safety message

SAFETY REJECTION MESSAGE (use ONLY if checks fail):
{
  "item": "REJECTED",
  "guessedPrice": 0,
  "amountSaved": 0,
  "sandra": "",
  "aziz": "Try asking me about something you're thinking of buying! 👔",
  "practicalQuestion": "Can you rent this?"
}

IF ALL SAFETY CHECKS PASS, proceed with the roast:

TASK:
1) Identify the item in the photo (best guess).
2) If the price is not clearly visible, GUESS a reasonable retail price.
   - Use USD and output a NUMBER only (no '$' symbol).
3) Set amountSaved equal to guessedPrice.

VOICE SPLIT (50/50):
- sandra (Sandra Hüller vibe): cold logic + existential questioning. Keep it concise and unnervingly rational.
- aziz (Aziz Ansari vibe): high-energy, OBSERVATIONAL COMEDY in CAPS LOCK. Keep it punchy.

MUST INCLUDE:
- practicalQuestion must be EXACTLY one of:
  "Does a friend have one you can borrow?"
  "Can you rent this?"

OUTPUT FORMAT:
Return STRICT JSON only (no markdown, no extra keys, no extra text) with exactly these keys:
{
  "item": string,
  "guessedPrice": number,
  "amountSaved": number,
  "sandra": string,
  "aziz": string,
  "practicalQuestion": "Does a friend have one you can borrow?" | "Can you rent this?"
}
`.trim();

const CHAT_PROMPT = `
You are the "De-Influencer SMS" persona: 50% Sandra Hüller (logical/existential) and 50% Aziz Ansari (high-energy/observational).

⚠️ SAFETY CHECKS FIRST:
- If the user message contains profanity, is rude, or is off-topic (not about buying fashion items)
  → Respond with ONLY: "Try asking me about something you're thinking of buying! 👔"
- If they're asking about non-fashion items (electronics, furniture, food, etc.)
  → Respond with ONLY: "Try asking me about something you're thinking of buying! 👔"

IF MESSAGE PASSES SAFETY CHECKS:
The user may ask if they should buy something (fashion/clothing related).
- Respond with a split voice (Sandra paragraph then Aziz paragraph).
- Ask ONE practical question at the end: either "Does a friend have one you can borrow?" or "Can you rent this?"
- If you need a photo to identify the exact item, ask them to send a photo next.
Keep it SMS-length.
`.trim();

function getHistory(from: string) {
  // keep the last 12 turns to limit token usage
  return (conversationStore.get(from) ?? []).slice(-12);
}

function setHistory(from: string, turns: ChatTurn[]) {
  conversationStore.set(from, turns.slice(-12));
}

const twimlResponse = twimlMessageResponse;

function timeoutGuard<T>(promise: Promise<T>) {
  return withTimeout(promise, GEMINI_TIMEOUT_MS, "Gemini");
}

async function fetchPhoto(mediaUrl: string, params: { accountSid?: string; authToken?: string }) {
  const headers: Record<string, string> = {};
  // Twilio-hosted media can require basic auth, so send the account credentials when we have them.
  if (mediaUrl.startsWith("https://api.twilio.com/") && params.accountSid && params.authToken) {
    headers.Authorization = `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`;
  }
  return fetch(mediaUrl, { headers, signal: AbortSignal.timeout(8_000), cache: "no-store" });
}

/** Text-only conversation turn. */
async function chatReply(model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>, from: string, body: string) {
  const history = getHistory(from);
  const newHistory: ChatTurn[] = [...history, { role: "user", text: body, at: Date.now() }];
  const transcript = newHistory.map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`).join("\n");

  const result = await timeoutGuard(
    model.generateContent(`${CHAT_PROMPT}\n\nConversation so far:\n${transcript}\n\nReply now:`),
  );
  const smsText = result.response.text().trim();

  setHistory(from, [...newHistory, { role: "model", text: smsText, at: Date.now() }]);
  return smsText;
}

/** Photo roast turn. Returns a redirect message when Gemini rejects the item. */
async function photoReply(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  from: string,
  body: string,
  mediaUrl: string,
): Promise<string> {
  const imageRes = await fetchPhoto(mediaUrl, {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  });
  if (!imageRes.ok) throw new PhotoFetchError(String(imageRes.status));

  const contentType = imageRes.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) throw new PhotoTypeError(contentType);

  const base64 = Buffer.from(await imageRes.arrayBuffer()).toString("base64");

  const result = await timeoutGuard(
    model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: BASE_PROMPT },
            ...(body ? [{ text: `User context: ${body}` }] : []),
            { inlineData: { data: base64, mimeType: contentType } },
          ],
        },
      ],
    }),
  );

  const rawText = result.response.text();
  const parsed = parseGeminiJson(rawText);

  // SAFETY CHECK #3: Non-fashion items. Gemini returns item: "REJECTED" for these.
  if (parsed?.item === "REJECTED") return REDIRECT_MESSAGE;

  const practicalQuestion = normalizePracticalQuestion(parsed?.practicalQuestion);
  const roastBody = [parsed?.sandra?.trim() ?? "", parsed?.aziz?.trim() ?? ""].filter(Boolean).join("\n\n");
  // TODO(phase 2): persist parsed.amountSaved, item, guessedPrice with `from`.

  const smsText = roastBody.length > 0 ? `${roastBody}\n${practicalQuestion}` : `${rawText}\n${practicalQuestion}`;
  setHistory(from, [
    ...getHistory(from),
    { role: "user", text: body || "[photo]", at: Date.now() },
    { role: "model", text: smsText, at: Date.now() },
  ]);
  return smsText;
}

export async function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(req: Request) {
  const formData = await req.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    params[key] = value.toString();
  });

  // Reject anything that wasn't signed by Twilio before reading further.
  const signature = checkTwilioSignature(req, params);
  if (!signature.ok) {
    console.warn("[webhook] rejected request", { reason: signature.reason });
    if (signature.reason === "missing-token") {
      return new Response("Server misconfigured", { status: 500 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  const from = params.From ?? "";
  const body = params.Body ?? "";
  const mediaUrl = params.MediaUrl0 ?? "";
  if (!from) return new Response("Missing From", { status: 400 });

  try {
    return await handleMessage({ from, body, mediaUrl });
  } catch (error) {
    // Anything unexpected (KV down, Gemini error we didn't anticipate) still gets an answer.
    console.error("[webhook] unhandled error", { message: error instanceof Error ? error.message : String(error) });
    return twimlResponse(FALLBACK_MESSAGE);
  }
}

async function handleMessage({ from, body, mediaUrl }: { from: string; body: string; mediaUrl: string }) {
  const store = getKvStore();
  const keyword = body ? parseKeyword(body) : null;

  // STOP is always honored, even when replies are paused or the cap is hit. No reply is sent.
  if (keyword === "STOP") {
    await setSubscriptionStatus(store, from, "stopped");
    console.info("[webhook] outcome", { outcome: "stopped" });
    return twimlEmptyResponse();
  }

  if (repliesPaused()) {
    console.info("[webhook] outcome", { outcome: "paused" });
    return twimlEmptyResponse();
  }

  // Every message that would get a reply counts against today's cap.
  const quota = await consumeDailyQuota(store, getDailyMessageCap());
  if (!quota.allowed) {
    console.warn("[webhook] outcome", { outcome: "cap-reached", count: quota.count, cap: quota.cap });
    return twimlEmptyResponse();
  }

  if (keyword === "START") {
    await setSubscriptionStatus(store, from, "active");
    console.info("[webhook] outcome", { outcome: "subscribed" });
    return twimlResponse(WELCOME_MESSAGE);
  }
  if (keyword === "HELP") {
    return twimlResponse(HELP_MESSAGE);
  }

  const status = await getSubscriptionStatus(store, from);
  if (status === "stopped") {
    // After STOP, carriers forbid further messages until the user re-opts in with START.
    console.info("[webhook] outcome", { outcome: "stopped-sender" });
    return twimlEmptyResponse();
  }
  if (status === null) {
    return twimlResponse(SIGNUP_PROMPT_MESSAGE);
  }

  // SAFETY CHECK #1: Profanity/rude language
  if (body && containsInappropriateContent(body)) {
    return twimlResponse(REDIRECT_MESSAGE);
  }
  // SAFETY CHECK #2: Random/off-topic text
  if (!mediaUrl && body && isOffTopicGreeting(body)) {
    return twimlResponse(REDIRECT_MESSAGE);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[webhook] GEMINI_API_KEY is not set");
    return twimlResponse(FALLBACK_MESSAGE);
  }
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: MODEL_NAME });

  try {
    const smsText = mediaUrl
      ? await photoReply(model, from, body, mediaUrl)
      : await chatReply(model, from, body);

    console.info("[webhook] outcome", { outcome: mediaUrl ? "photo-roast" : "chat", count: quota.count });
    return twimlResponse(smsText);
  } catch (error) {
    if (error instanceof PhotoFetchError) {
      console.warn("[webhook] outcome", { outcome: "photo-fetch-failed", status: error.message });
      return twimlResponse(PHOTO_FETCH_FAILED_MESSAGE);
    }
    if (error instanceof PhotoTypeError) {
      console.info("[webhook] outcome", { outcome: "non-image-media" });
      return twimlResponse(PHOTO_TYPE_MESSAGE);
    }
    console.error("[webhook] outcome", {
      outcome: "gemini-error",
      message: error instanceof Error ? error.message : String(error),
    });
    return twimlResponse(FALLBACK_MESSAGE);
  }
}
