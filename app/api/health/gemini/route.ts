import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = "nodejs";

function toErrorMessage(err: unknown) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || err.name;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unstringifiable error";
  }
}

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "Missing GEMINI_API_KEY" },
      { status: 500 },
    );
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(
      "Reply with exactly: GEMINI_OK",
    );

    const text = result.response.text().trim();
    const keySuffix = apiKey.slice(-4);
    console.log("[gemini health] ok", { keySuffix, text });

    return Response.json({ ok: true, text });
  } catch (error) {
    const keySuffix = apiKey.slice(-4);
    const message = toErrorMessage(error);
    console.error("[gemini health] error", { keySuffix, message, error });
    return Response.json(
      { ok: false, error: "Gemini call failed", message },
      { status: 500 },
    );
  }
}

