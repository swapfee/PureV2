export interface TtlCacheOptions {
  readonly limit: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  has(key: string): boolean;
  delete(key: string): void;
  size(): number;
  clear(): void;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export function createTtlCache<V>(options: TtlCacheOptions): TtlCache<V> {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (!Number.isInteger(options.ttlMs) || options.ttlMs < 1) {
    throw new Error("ttlMs must be a positive integer");
  }

  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<V>>();
  const order: string[] = [];

  const purgeExpired = (): void => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) {
        entries.delete(key);
      }
    }
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const key = order[index];
      if (key === undefined || !entries.has(key)) order.splice(index, 1);
    }
  };

  const enforceLimit = (): void => {
    while (order.length > options.limit) {
      const oldest = order.shift();
      if (oldest) entries.delete(oldest);
    }
  };

  return {
    get(key): V | undefined {
      purgeExpired();
      const entry = entries.get(key);
      return entry?.value;
    },
    set(key, value): void {
      purgeExpired();
      if (!entries.has(key)) order.push(key);
      entries.set(key, { value, expiresAt: now() + options.ttlMs });
      enforceLimit();
    },
    has(key): boolean {
      return this.get(key) !== undefined;
    },
    delete(key): void {
      entries.delete(key);
      const index = order.indexOf(key);
      if (index >= 0) order.splice(index, 1);
    },
    size(): number {
      purgeExpired();
      return entries.size;
    },
    clear(): void {
      entries.clear();
      order.length = 0;
    },
  };
}
