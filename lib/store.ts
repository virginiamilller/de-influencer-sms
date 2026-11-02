/**
 * Minimal key-value store used for subscriber status and the daily message cap.
 *
 * - With UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API_* names
 *   Vercel's Upstash integration sets), state is shared across instances and survives restarts.
 * - Otherwise an in-memory store is used. That is fine for local dev, but on Vercel each
 *   instance has its own memory, so the cap and opt-outs are NOT reliable. Provision Redis
 *   before inviting testers.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Increments a counter and sets its expiry when it is first created. Returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

type MemoryEntry = { value: string; expiresAt?: number };

class MemoryStore implements KeyValueStore {
  constructor(private readonly data: Map<string, MemoryEntry>) {}

  private read(key: string): MemoryEntry | null {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string) {
    return this.read(key)?.value ?? null;
  }

  async set(key: string, value: string) {
    this.data.set(key, { value });
  }

  async incr(key: string, ttlSeconds: number) {
    const entry = this.read(key);
    if (!entry) {
      this.data.set(key, { value: "1", expiresAt: Date.now() + ttlSeconds * 1000 });
      return 1;
    }
    const next = Number(entry.value) + 1;
    entry.value = String(next);
    return next;
  }
}

class UpstashStore implements KeyValueStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async pipeline(commands: (string | number)[][]): Promise<unknown[]> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`KV request failed with status ${res.status}`);
    const results = (await res.json()) as { result?: unknown; error?: string }[];
    const failed = results.find((r) => r.error);
    if (failed) throw new Error(`KV command failed: ${failed.error}`);
    return results.map((r) => r.result);
  }

  async get(key: string) {
    const [value] = await this.pipeline([["GET", key]]);
    return typeof value === "string" ? value : null;
  }

  async set(key: string, value: string) {
    await this.pipeline([["SET", key, value]]);
  }

  async incr(key: string, ttlSeconds: number) {
    const [count] = await this.pipeline([
      ["INCR", key],
      // NX: only set the expiry if the key has none yet, so the window is fixed from first use.
      ["EXPIRE", key, ttlSeconds, "NX"],
    ]);
    return Number(count);
  }
}

const MEMORY_KEY = "__deInfluencerKv";
let warnedAboutMemory = false;

export function getKvStore(): KeyValueStore {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);

  if (!warnedAboutMemory) {
    warnedAboutMemory = true;
    console.warn(
      "[store] No Redis configured; using in-memory store. Opt-outs and the daily cap are not durable across instances.",
    );
  }
  const g = globalThis as unknown as Record<string, Map<string, MemoryEntry> | undefined>;
  g[MEMORY_KEY] ??= new Map<string, MemoryEntry>();
  return new MemoryStore(g[MEMORY_KEY]);
}
