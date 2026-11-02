import type { KeyValueStore } from "./store";

export type SubscriptionStatus = "active" | "stopped";

const key = (phone: string) => `sub:${phone}`;

/** Returns null for numbers that have never texted START. */
export async function getSubscriptionStatus(
  store: KeyValueStore,
  phone: string,
): Promise<SubscriptionStatus | null> {
  const value = await store.get(key(phone));
  return value === "active" || value === "stopped" ? value : null;
}

export async function setSubscriptionStatus(
  store: KeyValueStore,
  phone: string,
  status: SubscriptionStatus,
): Promise<void> {
  await store.set(key(phone), status);
}
