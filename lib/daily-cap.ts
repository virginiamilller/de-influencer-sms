import type { KeyValueStore } from "./store";

const WINDOW_SECONDS = 2 * 24 * 60 * 60; // keep yesterday's key briefly, then let it expire

export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Counts one processed inbound message against today's cap.
 * `allowed` is false once the count goes above `cap`.
 */
export async function consumeDailyQuota(
  store: KeyValueStore,
  cap: number,
  now: Date = new Date(),
): Promise<{ allowed: boolean; count: number; cap: number }> {
  const count = await store.incr(`cap:${utcDayKey(now)}`, WINDOW_SECONDS);
  return { allowed: count <= cap, count, cap };
}
