export type GeminiRoastJson = {
  item: string;
  guessedPrice: number; // USD number, no currency symbol
  amountSaved: number; // USD number, no currency symbol
  sandra: string; // Cold logic + existential questioning
  aziz: string; // High-energy, OBSERVATIONAL COMEDY IN CAPS
  practicalQuestion: "Does a friend have one you can borrow?" | "Can you rent this?";
};

function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export function parseGeminiJson(raw: string): Partial<GeminiRoastJson> | null {
  const candidate = extractJson(raw);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as Partial<GeminiRoastJson>;
  } catch {
    return null;
  }
}

export function normalizePracticalQuestion(
  maybeQuestion: unknown,
): GeminiRoastJson["practicalQuestion"] {
  if (maybeQuestion === "Can you rent this?") return "Can you rent this?";
  // Hard fallback to guarantee the required question.
  return "Does a friend have one you can borrow?";
}
