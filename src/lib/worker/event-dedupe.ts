import { createTtlCache } from "../ttl-cache.ts";

export interface EventDedupeStore {
  /**
   * Begin handling an event.
   * - completed: already finished successfully (ack without re-running)
   * - in_flight: currently being handled
   * - accept: first observation; caller must process then markCompleted/release
   */
  begin(eventId: string): "completed" | "in_flight" | "accept";
  markCompleted(eventId: string): void;
  release(eventId: string): void;
  hasCompleted(eventId: string): boolean;
  size(): number;
  clear(): void;
}

export function createEventDedupe(limit: number, ttlMs: number, now?: () => number): EventDedupeStore {
  const completed = createTtlCache<true>(
    now === undefined ? { limit, ttlMs } : { limit, ttlMs, now },
  );
  const inFlight = new Set<string>();

  return {
    begin(eventId) {
      if (completed.has(eventId)) return "completed";
      if (inFlight.has(eventId)) return "in_flight";
      inFlight.add(eventId);
      return "accept";
    },
    markCompleted(eventId): void {
      inFlight.delete(eventId);
      completed.set(eventId, true);
    },
    release(eventId): void {
      inFlight.delete(eventId);
    },
    hasCompleted(eventId): boolean {
      return completed.has(eventId);
    },
    size(): number {
      return completed.size() + inFlight.size;
    },
    clear(): void {
      completed.clear();
      inFlight.clear();
    },
  };
}
