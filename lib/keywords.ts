/**
 * Keywords that carriers and Twilio treat specially. Matching is case-insensitive and ignores
 * surrounding whitespace and trailing punctuation.
 */
export type Keyword = "START" | "STOP" | "HELP";

const KEYWORDS: Record<string, Keyword> = {
  START: "START",
  UNSTOP: "START",
  STOP: "STOP",
  STOPALL: "STOP",
  UNSUBSCRIBE: "STOP",
  CANCEL: "STOP",
  END: "STOP",
  QUIT: "STOP",
  HELP: "HELP",
  INFO: "HELP",
};

export function parseKeyword(body: string): Keyword | null {
  const word = body.trim().replace(/[.!?]+$/, "").toUpperCase();
  return KEYWORDS[word] ?? null;
}
