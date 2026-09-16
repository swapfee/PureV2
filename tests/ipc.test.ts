import { describe, expect, test } from "bun:test";

import { parseIpcMessage, assertIpcMessage } from "../src/lib/ipc/messages.ts";

describe("parseIpcMessage", () => {
  test("accepts a valid gateway event with attempt", () => {
    const parsed = parseIpcMessage({
      type: "gatewayEvent",
      eventId: "11111111-1111-4111-8111-111111111111",
      shardId: 0,
      payload: { op: 0, t: "READY", s: 1, d: {} },
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      attempt: 1,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.type === "gatewayEvent") {
      expect(parsed.message.attempt).toBe(1);
    }
  });

  test("accepts heartbeat and ready messages", () => {
    expect(
      parseIpcMessage({
        type: "heartbeat",
        workerId: 0,
        sequence: 1,
        at: "2026-01-01T00:00:00.000Z",
        inFlightCount: 0,
        mongoReady: true,
      }).ok,
    ).toBe(true);

    expect(
      parseIpcMessage({
        type: "workerReady",
        workerId: 0,
        mongoReady: true,
        modulesReady: true,
        at: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(true);
  });

  test("rejects malformed and protocol-mismatched messages", () => {
    expect(parseIpcMessage({ type: "gatewayEvent", shardId: -1 }).ok).toBe(false);
    expect(parseIpcMessage({ type: "heartbeat", workerId: 0 }).ok).toBe(false);
    expect(() => assertIpcMessage({ type: "unknown" })).toThrow(/Invalid IPC message/);
  });
});
