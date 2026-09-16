import { describe, expect, test } from "bun:test";

import { createEventTracker } from "../src/lib/coordinator/event-tracker.ts";
import { computeRestartDelayMs, createRestartBackoff } from "../src/lib/coordinator/restart-backoff.ts";
import { createCooldownStore } from "../src/handlers/cooldowns.ts";
import { createEventDedupe } from "../src/lib/worker/event-dedupe.ts";
import type { GatewayEventMessage } from "../src/lib/ipc/messages.ts";

function gatewayEvent(eventId: string, shardId = 0, attempt = 1): GatewayEventMessage {
  return {
    type: "gatewayEvent",
    eventId,
    shardId,
    payload: { op: 0, t: "READY", s: 1, d: {} },
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    attempt,
  };
}

describe("createEventTracker", () => {
  test("tracks acknowledgments and stable event ids on retry", () => {
    const tracker = createEventTracker(2);
    const first = gatewayEvent("11111111-1111-4111-8111-111111111111");
    tracker.track(0, first);
    expect(tracker.pendingForWorker(0)[0]?.eventId).toBe(first.eventId);

    const retry = tracker.scheduleRetry(first.eventId, 3);
    expect(retry.action).toBe("retry");
    if (retry.action === "retry") {
      expect(retry.message.eventId).toBe(first.eventId);
      expect(retry.message.attempt).toBe(2);
    }
  });

  test("marks poison events after max attempts", () => {
    const tracker = createEventTracker(8);
    const event = gatewayEvent("22222222-2222-4222-8222-222222222222", 0, 3);
    tracker.track(0, event);
    const decision = tracker.scheduleRetry(event.eventId, 3);
    expect(decision.action).toBe("poison");
    expect(tracker.hasPoisonEvents()).toBe(true);
  });

  test("reports buffer overflow without dropping in-flight ownership semantics", () => {
    const tracker = createEventTracker(1);
    const first = gatewayEvent("33333333-3333-4333-8333-333333333333");
    const second = gatewayEvent("44444444-4444-4444-8444-444444444444");
    expect(tracker.track(0, first).overflowed).toBe(false);
    expect(tracker.track(0, second).overflowed).toBe(true);
    expect(tracker.snapshot().overflowed).toBe(true);
  });

  test("exposes timed-out in-flight events with retry or poison", () => {
    const tracker = createEventTracker(8);
    const event = gatewayEvent("55555555-5555-4555-8555-555555555555", 1, 1);
    tracker.track(1, event);
    const timedOut = tracker.takeTimedOut(Date.now() + 20_000, 1_000, 3);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]?.message.eventId).toBe(event.eventId);
    expect(timedOut[0]?.action).toBe("retry");
  });
});

describe("restart backoff", () => {
  test("grows exponentially and caps at max", () => {
    expect(computeRestartDelayMs(0, 500, 30_000)).toBe(500);
    expect(computeRestartDelayMs(1, 500, 30_000)).toBe(1_000);
    expect(computeRestartDelayMs(10, 500, 30_000)).toBe(30_000);

    let backoff = createRestartBackoff(500, 30_000);
    backoff = backoff.failure();
    expect(backoff.nextDelayMs()).toBe(1_000);
    backoff = backoff.success();
    expect(backoff.nextDelayMs()).toBe(500);
  });
});

describe("createCooldownStore", () => {
  test("blocks repeated use until cooldown expires", () => {
    const store = createCooldownStore();
    expect(store.check("ping:1", 3_000, 1_000).allowed).toBe(true);
    expect(store.check("ping:1", 3_000, 2_000).allowed).toBe(false);
    expect(store.check("ping:1", 3_000, 4_000).allowed).toBe(true);
  });
});

describe("createEventDedupe", () => {
  test("acks completed duplicates without re-accepting", () => {
    const dedupe = createEventDedupe(2, 60_000);
    expect(dedupe.begin("a")).toBe("accept");
    expect(dedupe.begin("a")).toBe("in_flight");
    dedupe.markCompleted("a");
    expect(dedupe.begin("a")).toBe("completed");
  });

  test("bounds completed memory", () => {
    const dedupe = createEventDedupe(2, 60_000);
    expect(dedupe.begin("a")).toBe("accept");
    dedupe.markCompleted("a");
    expect(dedupe.begin("b")).toBe("accept");
    dedupe.markCompleted("b");
    expect(dedupe.begin("c")).toBe("accept");
    dedupe.markCompleted("c");
    expect(dedupe.hasCompleted("a")).toBe(false);
  });
});
