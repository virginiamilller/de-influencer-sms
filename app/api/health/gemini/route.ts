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

/**
 * This route spends Gemini quota on every call, so it is closed in production unless
 * HEALTH_CHECK_TOKEN is set and the caller sends `Authorization: Bearer <token>`.
 */
function isAuthorized(req: Request) {
  const token = process.env.HEALTH_CHECK_TOKEN;
  if (!token) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${token}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new Response("Not found", { status: 404 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ ok: false, error: "Missing GEMINI_API_KEY" }, { status: 500 });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent("Reply with exactly: GEMINI_OK");
    const text = result.response.text().trim();
    return Response.json({ ok: true, text });
  } catch (error) {
    const message = toErrorMessage(error);
    console.error("[gemini health] error", { message });
    return Response.json({ ok: false, error: "Gemini call failed", message }, { status: 500 });
  }
}
