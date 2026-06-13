/**
 * Local test (no Twilio account needed):
 *
 * curl -X POST http://localhost:3000/api/webhook \
 *   -H "Content-Type: application/x-www-form-urlencoded" \
 *   -d "From=+15551234567" \
 *   -d "To=+15557654321" \
 *   -d "MediaUrl0=https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=60"
 */

import { Buffer } from "buffer";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

type ChatTurn = { role: "user" | "model"; text: string; at: number };
type ConversationStore = Map<string, ChatTurn[]>;

const conversationStore: ConversationStore =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((globalThis as any).__deInfluencerConversationStore as ConversationStore) ??
  new Map<string, ChatTurn[]>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__deInfluencerConversationStore = conversationStore;

type GeminiRoastJson = {
  item: string;
  guessedPrice: number; // USD number, no currency symbol
  amountSaved: number; // USD number, no currency symbol
  sandra: string; // Cold logic + existential questioning
  aziz: string; // High-energy, OBSERVATIONAL COMEDY IN CAPS
  practicalQuestion:
    | "Does a friend have one you can borrow?"
    | "Can you rent this?";
};

/**
 * CONTENT MODERATION
 * Check for profanity, inappropriate language, rude tone
 */
function containsInappropriateContent(text: string): boolean {
  const profanityPatterns = [
    /\bf[*u]ck/i,
    /\bsh[*i]t/i,
    /\bass\b/i,
    /\bdamn/i,
    /\bhell\b/i,
    /\bcrap/i,
    /\bpiss/i,
    /\bcock/i,
    /\bslut/i,
    /\bbitch/i,
    /\bwhore/i,
    /\bgodd[*a]mn/i,
  ];

  const rudePatterns = [
    /you suck/i,
    /you're stupid/i,
    /you're dumb/i,
    /i hate you/i,
    /go away/i,
    /screw you/i,
    /f\*\*\* off/i,
    /f\*\*\* you/i,
  ];

  const allPatterns = [...profanityPatterns, ...rudePatterns];
  return allPatterns.some((pattern) => pattern.test(text));
}

function escapeXml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getHistory(from: string) {
  const existing = conversationStore.get(from) ?? [];
  // keep the last 12 turns to limit token usage
  return existing.slice(-12);
}

function setHistory(from: string, turns: ChatTurn[]) {
  conversationStore.set(from, turns.slice(-12));
}

function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function parseGeminiJson(raw: string): Partial<GeminiRoastJson> | null {
  const jsonCandidate = extractJson(raw);
  if (!jsonCandidate) return null;
  try {
    return JSON.parse(jsonCandidate) as Partial<GeminiRoastJson>;
  } catch {
    return null;
  }
}

function normalizePracticalQuestion(
  maybeQuestion: unknown,
): GeminiRoastJson["practicalQuestion"] {
  if (maybeQuestion === "Does a friend have one you can borrow?") {
    return "Does a friend have one you can borrow?";
  }
  if (maybeQuestion === "Can you rent this?") {
    return "Can you rent this?";
  }
  // Hard fallback to guarantee the required question.
  return "Does a friend have one you can borrow?";
}

/** Twilio and some consoles probe the webhook with GET when saving; POST handles real SMS. */
export async function GET() {
  return new Response("ok", { status: 200 });
}

export async function POST(req: Request) {
  const formData = await req.formData();
  const from = formData.get("From")?.toString() ?? "";
  const body = formData.get("Body")?.toString() ?? "";
  const mediaUrl = formData.get("MediaUrl0")?.toString() ?? "";

  if (!from) return new Response("Missing From", { status: 400 });

  // ============================================
  // SAFETY CHECK #1: Profanity/Rude Language
  // ============================================
  if (body && containsInappropriateContent(body)) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml("Try asking me about something you're thinking of buying! 👔")}</Message>
</Response>`;
    return new Response(twiml, {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }

  // ============================================
  // SAFETY CHECK #2: Random/Off-Topic Text
  // ============================================
  if (!mediaUrl && body) {
    const trimmedBody = body.trim().toLowerCase();
    const randomTopicPatterns = [
      /^(hi|hello|hey|what's up|yo|sup)$/,
      /^test/,
      /^does this work/,
      /^help/,
      /^spam|test|random/,
    ];

    const isRandomTopic = randomTopicPatterns.some((pattern) =>
      pattern.test(trimmedBody),
    );

    if (isRandomTopic && trimmedBody.length < 10) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml("Try asking me about something you're thinking of buying! 👔")}</Message>
</Response>`;
      return new Response(twiml, {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response("Missing GEMINI_API_KEY", { status: 500 });
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const basePrompt = `
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

  const history = getHistory(from);
  const now = Date.now();
  const newHistory: ChatTurn[] = [
    ...history,
    ...(body ? [{ role: "user" as const, text: body, at: now }] : []),
  ];

  let smsText = "";

  if (!mediaUrl) {
    // Text-only conversation mode (no photo yet).
    const convoPrompt = `
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

    const transcript = newHistory
      .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.text}`)
      .join("\n");

    const result = await model.generateContent(
      `${convoPrompt}\n\nConversation so far:\n${transcript}\n\nReply now:`,
    );
    smsText = result.response.text().trim();

    // Save conversation turn.
    const updated = [
      ...newHistory,
      { role: "model" as const, text: smsText, at: Date.now() },
    ];
    // TODO: Persist conversation + analytics to your database (instead of memory) for Vercel/serverless reliability.
    setHistory(from, updated);
  } else {
    // Photo roast mode.
    // Fetch the image so Gemini can analyze it.
    const imageRes = await fetch(mediaUrl);
    if (!imageRes.ok) {
      return new Response("Failed to fetch MediaUrl0", { status: 400 });
    }

    const arrayBuffer = await imageRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const contentType = imageRes.headers.get("content-type") ?? "image/jpeg";
    const mimeType = contentType.startsWith("image/") ? contentType : "image/jpeg";

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: basePrompt },
            ...(body ? [{ text: `User context: ${body}` }] : []),
            {
              inlineData: {
                data: base64,
                mimeType,
              },
            },
          ],
        },
      ],
    });

    const rawText = result.response.text();
    const parsed = parseGeminiJson(rawText);

    // ============================================
    // SAFETY CHECK #3: Non-Fashion Items
    // ============================================
    // If Gemini detects a REJECTED item, it will return item: "REJECTED"
    if (parsed?.item === "REJECTED") {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml("Try asking me about something you're thinking of buying! 👔")}</Message>
</Response>`;
      return new Response(twiml, {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    const practicalQuestion = normalizePracticalQuestion(
      parsed?.practicalQuestion,
    );
    const sandraPart = parsed?.sandra ?? "";
    const azizPart = parsed?.aziz ?? "";
    const amountSaved =
      typeof parsed?.amountSaved === "number" ? parsed.amountSaved : null;

    // TODO: Persist `amountSaved` (and metadata like `from`, `item`, `guessedPrice`) to your database.
    //       This is intentionally left out until we wire storage.
    void amountSaved;

    const roastBody = [sandraPart.trim(), azizPart.trim()]
      .filter(Boolean)
      .join("\n\n");
    smsText =
      roastBody.length > 0
        ? `${roastBody}\n${practicalQuestion}`
        : `${rawText}\n${practicalQuestion}`;

    const updated = [
      ...newHistory,
      { role: "model" as const, text: smsText, at: Date.now() },
    ];
    // TODO: Persist conversation + analytics to your database (instead of memory) for Vercel/serverless reliability.
    setHistory(from, updated);
  }

  // Twilio Webhooks typically expect TwiML back.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(smsText)}</Message>
</Response>`;

  // Optional logging (safe, remove if noisy).
  // console.log({ from, mediaUrl, body });

  return new Response(twiml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}