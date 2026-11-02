import twilio from "twilio";

/**
 * The public URL Twilio signed. Behind Vercel the request URL can be internal, so prefer
 * PUBLIC_WEBHOOK_URL when set, then the forwarded host/proto headers.
 */
export function publicWebhookUrl(req: Request): string {
  const override = process.env.PUBLIC_WEBHOOK_URL;
  if (override) return override;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}${url.pathname}${url.search}`;
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing-token" | "missing-signature" | "bad-signature" };

/**
 * Verifies the X-Twilio-Signature header against the POST params.
 *
 * Local curl testing can bypass this with TWILIO_SKIP_SIGNATURE_CHECK=1. That bypass is
 * ignored when NODE_ENV=production, so it cannot disable verification in a deployment.
 */
export function checkTwilioSignature(req: Request, params: Record<string, string>): SignatureCheck {
  if (process.env.TWILIO_SKIP_SIGNATURE_CHECK === "1" && process.env.NODE_ENV !== "production") {
    return { ok: true };
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return { ok: false, reason: "missing-token" };

  const signature = req.headers.get("x-twilio-signature");
  if (!signature) return { ok: false, reason: "missing-signature" };

  const valid = twilio.validateRequest(authToken, signature, publicWebhookUrl(req), params);
  return valid ? { ok: true } : { ok: false, reason: "bad-signature" };
}
