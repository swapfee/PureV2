import type { GatewayEventMessage } from "../ipc/messages.ts";

/**
 * In-memory event delivery tracker.
 *
 * Survives worker restarts only. Does NOT survive coordinator or VPS restarts.
 */
export interface TrackedEvent {
  readonly message: GatewayEventMessage;
  readonly workerId: number;
  readonly sentAt: number;
  readonly attempts: number;
}

export interface EventTrackerSnapshot {
  readonly inFlight: number;
  readonly buffered: number;
  readonly overflowed: boolean;
  readonly poisonEventIds: readonly string[];
}

export interface EventTracker {
  track(workerId: number, message: GatewayEventMessage): { overflowed: boolean };
  acknowledge(eventId: string): TrackedEvent | undefined;
  scheduleRetry(eventId: string, maxAttempts: number): 
    | { readonly action: "retry"; readonly message: GatewayEventMessage; readonly workerId: number }
    | { readonly action: "poison"; readonly tracked: TrackedEvent }
    | { readonly action: "missing" };
  takeTimedOut(now: number, timeoutMs: number, maxAttempts: number): readonly {
    readonly action: "retry" | "poison";
    readonly tracked: TrackedEvent;
    readonly message: GatewayEventMessage;
  }[];
  pendingForWorker(workerId: number): readonly GatewayEventMessage[];
  inFlightCount(): number;
  snapshot(): EventTrackerSnapshot;
  hasPoisonEvents(): boolean;
  clearPoison(eventId?: string): void;
}

export function createEventTracker(bufferLimit: number): EventTracker {
  if (!Number.isInteger(bufferLimit) || bufferLimit < 1) {
    throw new Error("bufferLimit must be a positive integer");
  }

  const inFlight = new Map<string, TrackedEvent>();
  const perWorkerBuffers = new Map<number, GatewayEventMessage[]>();
  const poisonEventIds = new Set<string>();
  let overflowed = false;

  const pushBuffered = (workerId: number, message: GatewayEventMessage): boolean => {
    const buffer = perWorkerBuffers.get(workerId) ?? [];
    if (buffer.length >= bufferLimit) {
      overflowed = true;
      return false;
    }
    buffer.push(message);
    perWorkerBuffers.set(workerId, buffer);
    return true;
  };

  const removeBuffered = (workerId: number, eventId: string): void => {
    const buffer = perWorkerBuffers.get(workerId);
    if (!buffer) return;
    perWorkerBuffers.set(
      workerId,
      buffer.filter((entry) => entry.eventId !== eventId),
    );
  };

  const bufferedCount = (): number => {
    let count = 0;
    for (const buffer of perWorkerBuffers.values()) count += buffer.length;
    return count;
  };

  return {
    track(workerId, message): { overflowed: boolean } {
      const attempts = message.attempt;
      inFlight.set(message.eventId, {
        message,
        workerId,
        sentAt: Date.now(),
        attempts,
      });
      const accepted = pushBuffered(workerId, message);
      return { overflowed: !accepted };
    },

    acknowledge(eventId): TrackedEvent | undefined {
      const tracked = inFlight.get(eventId);
      if (!tracked) return undefined;
      inFlight.delete(eventId);
      removeBuffered(tracked.workerId, eventId);
      poisonEventIds.delete(eventId);
      return tracked;
    },

    scheduleRetry(eventId, maxAttempts) {
      const tracked = inFlight.get(eventId);
      if (!tracked) return { action: "missing" as const };

      inFlight.delete(eventId);
      removeBuffered(tracked.workerId, eventId);

      if (tracked.attempts >= maxAttempts) {
        poisonEventIds.add(eventId);
        return { action: "poison" as const, tracked };
      }

      const nextMessage: GatewayEventMessage = {
        ...tracked.message,
        attempt: tracked.attempts + 1,
      };
      return { action: "retry" as const, message: nextMessage, workerId: tracked.workerId };
    },

    takeTimedOut(now, timeoutMs, maxAttempts) {
      const results: {
        action: "retry" | "poison";
        tracked: TrackedEvent;
        message: GatewayEventMessage;
      }[] = [];

      for (const [eventId, tracked] of inFlight.entries()) {
        if (now - tracked.sentAt < timeoutMs) continue;
        const decision = this.scheduleRetry(eventId, maxAttempts);
        if (decision.action === "retry") {
          results.push({ action: "retry", tracked, message: decision.message });
        } else if (decision.action === "poison") {
          results.push({ action: "poison", tracked: decision.tracked, message: decision.tracked.message });
        }
      }
      return results;
    },

    pendingForWorker(workerId): readonly GatewayEventMessage[] {
      return [...(perWorkerBuffers.get(workerId) ?? [])];
    },

    inFlightCount(): number {
      return inFlight.size;
    },

    snapshot(): EventTrackerSnapshot {
      return {
        inFlight: inFlight.size,
        buffered: bufferedCount(),
        overflowed,
        poisonEventIds: [...poisonEventIds],
      };
    },

    hasPoisonEvents(): boolean {
      return poisonEventIds.size > 0;
    },

    clearPoison(eventId): void {
      if (eventId) poisonEventIds.delete(eventId);
      else poisonEventIds.clear();
    },
  };
}
