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
        statsReady: true,
        statsMetrics: { sessionOpens: 0, sessionCloses: 0, deduplicatedEvents: 0, reconciliationFindings: 0, redisFailures: 0, renders: 0, renderFailures: 0 },
      }).ok,
    ).toBe(true);

    expect(
      parseIpcMessage({
        type: "workerReady",
        workerId: 0,
        mongoReady: true,
        modulesReady: true,
        statsReady: true,
        statsMetrics: { sessionOpens: 0, sessionCloses: 0, deduplicatedEvents: 0, reconciliationFindings: 0, redisFailures: 0, renders: 0, renderFailures: 0 },
        at: "2026-01-01T00:00:00.000Z",
      }).ok,
    ).toBe(true);
  });

  test("accepts bounded coordinator voice snapshots and worker acknowledgments", () => {
    const snapshotId = "22222222-2222-4222-8222-222222222222";
    expect(parseIpcMessage({
      type: "voiceStateSnapshot",
      snapshotId,
      workerId: 0,
      guilds: [{
        guildId: "123456789012345678",
        states: [{ userId: "223456789012345678", channelId: "323456789012345678" }],
      }],
      at: "2026-01-01T00:00:00.000Z",
    }).ok).toBe(true);
    expect(parseIpcMessage({
      type: "voiceStateSnapshotAck",
      snapshotId,
      workerId: 0,
      ok: true,
      statsReady: true,
      at: "2026-01-01T00:00:01.000Z",
    }).ok).toBe(true);
    expect(parseIpcMessage({
      type: "voiceStateSnapshot",
      snapshotId,
      workerId: 2,
      guilds: [],
      at: "2026-01-01T00:00:00.000Z",
    }).ok).toBe(false);
  });

  test("rejects malformed and protocol-mismatched messages", () => {
    expect(parseIpcMessage({ type: "gatewayEvent", shardId: -1 }).ok).toBe(false);
    expect(parseIpcMessage({ type: "heartbeat", workerId: 0 }).ok).toBe(false);
    expect(() => assertIpcMessage({ type: "unknown" })).toThrow(/Invalid IPC message/);
  });
});
