/** Hard daily cap on processed inbound messages (UTC day). Override with DAILY_MESSAGE_CAP. */
export const DEFAULT_DAILY_MESSAGE_CAP = 50;

/** Gemini calls slower than this get a fallback reply, so Twilio's ~15s webhook window is not missed. */
export const GEMINI_TIMEOUT_MS = 12_000;

export function getDailyMessageCap(): number {
  const raw = process.env.DAILY_MESSAGE_CAP;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_MESSAGE_CAP;
}

/** Kill switch: when PAUSE_REPLIES=1 the webhook accepts messages but sends nothing back. */
export function repliesPaused(): boolean {
  return process.env.PAUSE_REPLIES === "1";
}
