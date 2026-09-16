export interface CooldownDecision {
  readonly allowed: boolean;
  readonly remainingMs: number;
}

export interface CooldownStore {
  /** Returns whether the key is currently cooling down without mutating state. */
  remaining(key: string, now?: number): number;
  /** Start/refresh a cooldown window after a successful operation. */
  touch(key: string, cooldownMs: number, now?: number): void;
  check(key: string, cooldownMs: number, now?: number): CooldownDecision;
  size(): number;
  clear(): void;
  /** Remove expired entries; returns number removed. */
  cleanup(now?: number): number;
}

/**
 * TTL-backed cooldown map with bounded cleanup so entries cannot grow without bound.
 */
export function createCooldownStore(options?: {
  readonly maxEntries?: number;
}): CooldownStore {
  const expiresAt = new Map<string, number>();
  const maxEntries = options?.maxEntries ?? 10_000;

  const cleanup = (now = Date.now()): number => {
    let removed = 0;
    for (const [key, expires] of expiresAt) {
      if (expires <= now) {
        expiresAt.delete(key);
        removed += 1;
      }
    }
    if (expiresAt.size > maxEntries) {
      const overflow = [...expiresAt.entries()].toSorted((a, b) => a[1] - b[1]);
      const toRemove = expiresAt.size - maxEntries;
      for (let i = 0; i < toRemove; i += 1) {
        const entry = overflow[i];
        if (entry) {
          expiresAt.delete(entry[0]);
          removed += 1;
        }
      }
    }
    return removed;
  };

  return {
    remaining(key, now = Date.now()) {
      const current = expiresAt.get(key);
      if (current === undefined || current <= now) return 0;
      return current - now;
    },
    touch(key, cooldownMs, now = Date.now()) {
      if (cooldownMs <= 0) return;
      expiresAt.set(key, now + cooldownMs);
      if (expiresAt.size > maxEntries) cleanup(now);
    },
    check(key, cooldownMs, now = Date.now()): CooldownDecision {
      if (cooldownMs <= 0) return { allowed: true, remainingMs: 0 };
      const remainingMs = this.remaining(key, now);
      if (remainingMs > 0) {
        return { allowed: false, remainingMs };
      }
      this.touch(key, cooldownMs, now);
      return { allowed: true, remainingMs: 0 };
    },
    size() {
      return expiresAt.size;
    },
    clear() {
      expiresAt.clear();
    },
    cleanup,
  };
}
