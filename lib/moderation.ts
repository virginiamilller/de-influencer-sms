/** CONTENT MODERATION: profanity and rude tone. */
const PROFANITY_PATTERNS = [
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

const RUDE_PATTERNS = [
  /you suck/i,
  /you're stupid/i,
  /you're dumb/i,
  /i hate you/i,
  /go away/i,
  /screw you/i,
  /f\*\*\* off/i,
  /f\*\*\* you/i,
];

export function containsInappropriateContent(text: string): boolean {
  return [...PROFANITY_PATTERNS, ...RUDE_PATTERNS].some((pattern) => pattern.test(text));
}

/** Short greetings and test pings that should get the "ask about a purchase" nudge, not a roast. */
export function isOffTopicGreeting(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  const patterns = [
    /^(hi|hello|hey|what's up|yo|sup)$/,
    /^test/,
    /^does this work/,
    /^help/,
    /^spam|test|random/,
  ];
  return trimmed.length < 10 && patterns.some((pattern) => pattern.test(trimmed));
}
