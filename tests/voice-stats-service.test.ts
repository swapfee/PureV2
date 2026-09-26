import { describe, expect, test } from "bun:test";

import { createMemoryTemporaryChannelRepository } from "../src/lib/j2c/memory-repositories.ts";
import { createLogger } from "../src/lib/logger.ts";
import { createMemoryVoiceStatsCache } from "../src/lib/stats/cache.ts";
import { createMemoryVoiceStatsRepository } from "../src/lib/stats/memory-repository.ts";
import { createVoiceStatsMetrics } from "../src/lib/stats/metrics.ts";
import { splitDurationByUtcDay } from "../src/lib/stats/repositories.ts";
import { createVoiceStatsService } from "../src/lib/stats/service.ts";

const guildId = "123456789012345678";
const userId = "234567890123456789";
const channelA = "345678901234567890";
const channelB = "456789012345678901";

function fixture(start = new Date("2026-09-23T23:59:30.000Z")) {
  let now = start;
  const channels = createMemoryTemporaryChannelRepository();
  const repository = createMemoryVoiceStatsRepository();
  const cache = createMemoryVoiceStatsCache();
  const metrics = createVoiceStatsMetrics();
  const service = createVoiceStatsService({
    repository, channels, cache, metrics,
    logger: createLogger({ service: "test", role: "stats", level: "fatal", write: () => undefined }),
    clock: { now: () => now },
  });
  return { channels, repository, cache, metrics, service, setNow(value: Date) { now = value; } };
}

async function addManagedChannel(fx: ReturnType<typeof fixture>, channelId: string): Promise<void> {
  await fx.channels.create({ guildId, channelId, ownerId: userId, lobbyChannelId: "567890123456789012", status: "active", reservationId: `r-${channelId}`, creationRequestId: `c-${channelId}` });
}

describe("managed voice statistics", () => {
  test("a replacement worker reclaims incomplete events but not completed events", async () => {
    const fx = fixture();
    const at = new Date("2026-09-24T00:00:00Z");
    expect(await fx.repository.acquireEvent("event-restart", guildId, userId, at, "worker-a")).toBe(true);
    expect(await fx.repository.acquireEvent("event-restart", guildId, userId, at, "worker-a")).toBe(false);
    expect(await fx.repository.acquireEvent("event-restart", guildId, userId, at, "worker-b")).toBe(true);
    await fx.repository.completeEvent("event-restart");
    expect(await fx.repository.acquireEvent("event-restart", guildId, userId, at, "worker-c")).toBe(false);
  });

  test("opens, deduplicates, moves between managed channels, and closes sessions", async () => {
    const fx = fixture();
    await fx.cache.connect();
    fx.service.expectGuilds([guildId]);
    await addManagedChannel(fx, channelA);
    await addManagedChannel(fx, channelB);
    await fx.service.handle({ guildId, userId, channelId: channelA, displayName: "A" }, "event-1");
    await fx.service.handle({ guildId, userId, channelId: channelA, displayName: "A" }, "event-1");
    fx.setNow(new Date("2026-09-24T00:00:30.000Z"));
    await fx.service.handle({ guildId, userId, channelId: channelB }, "event-2");
    fx.setNow(new Date("2026-09-24T00:01:00.000Z"));
    await fx.service.handle({ guildId, userId, channelId: null }, "event-3");
    expect([...fx.repository.sessions.values()]).toHaveLength(2);
    expect((await fx.repository.getMember(guildId, userId))?.totalSeconds).toBe(90);
    const completed = [...fx.repository.sessions.values()].filter((entry) => entry.status === "completed");
    expect(completed.every((entry) => entry.expiresAt !== undefined && entry.expiresAt.getTime() - entry.endedAt!.getTime() === 90 * 86_400_000)).toBe(true);
    expect(fx.metrics.snapshot()).toMatchObject({ sessionOpens: 2, sessionCloses: 2, deduplicatedEvents: 1 });
  });

  test("ignores bots and unmanaged channels", async () => {
    const fx = fixture();
    await fx.cache.connect();
    fx.service.expectGuilds([guildId]);
    await fx.service.handle({ guildId, userId, channelId: channelA }, "unmanaged");
    await fx.service.handle({ guildId, userId, channelId: channelA, isBot: true }, "bot");
    expect(fx.repository.sessions.size).toBe(0);
  });

  test("ignores a stale leave after a newer join sequence", async () => {
    const fx = fixture();
    await fx.cache.connect();
    fx.service.expectGuilds([guildId]);
    await addManagedChannel(fx, channelA);
    await fx.service.handle({ guildId, userId, channelId: channelA, gatewaySequence: 20 }, "new-join");
    await fx.service.handle({ guildId, userId, channelId: null, gatewaySequence: 19 }, "old-leave");
    expect((await fx.repository.findActive(guildId, userId))?.channelId).toBe(channelA);
  });

  test("splits elapsed time across UTC midnight", () => {
    expect(splitDurationByUtcDay(new Date("2026-09-23T23:59:30Z"), new Date("2026-09-24T00:00:30Z"))).toEqual([
      { day: new Date("2026-09-23T00:00:00Z"), seconds: 30 },
      { day: new Date("2026-09-24T00:00:00Z"), seconds: 30 },
    ]);
  });

  test("reconciliation closes stale sessions at the last checkpoint and rebuilds cache", async () => {
    const fx = fixture();
    await fx.cache.connect();
    fx.service.expectGuilds([guildId]);
    await addManagedChannel(fx, channelA);
    await fx.service.handle({ guildId, userId, channelId: channelA }, "join");
    fx.cache.close();
    await fx.cache.connect();
    fx.service.expectGuilds([guildId]);
    fx.setNow(new Date("2026-09-24T01:00:00Z"));
    await fx.service.reconcileGuild(guildId, []);
    expect(await fx.repository.findActive(guildId, userId)).toBeUndefined();
    expect((await fx.repository.getMember(guildId, userId))?.totalSeconds).toBe(0);
    expect(fx.service.isReady()).toBe(true);
    fx.cache.close();
    expect(fx.service.isReady()).toBe(false);
    await fx.cache.connect();
    expect(fx.service.isReady()).toBe(true);
  });

  test("reconciliation opens a missing active session and snapshot includes live time", async () => {
    const fx = fixture(new Date("2026-09-24T10:00:00Z"));
    await fx.cache.connect();
    fx.service.expectGuilds([guildId]);
    await addManagedChannel(fx, channelA);
    await fx.service.reconcileGuild(guildId, [{ guildId, userId, channelId: channelA, displayName: "Member" }]);
    fx.setNow(new Date("2026-09-24T10:02:00Z"));
    const snapshot = await fx.service.getSnapshot(guildId, userId, "Member");
    expect(snapshot.totalSeconds).toBe(120);
    expect(snapshot.sessionCount).toBe(1);
    expect(snapshot.daily).toHaveLength(7);
  });

  test("purges durable and cached statistics for only the selected guild", async () => {
    const fx = fixture(new Date("2026-09-24T10:00:00Z"));
    const otherGuildId = "678901234567890123";
    const otherUserId = "789012345678901234";
    const otherChannelId = "890123456789012345";
    await fx.cache.connect();
    await addManagedChannel(fx, channelA);
    await fx.channels.create({
      guildId: otherGuildId,
      channelId: otherChannelId,
      ownerId: otherUserId,
      lobbyChannelId: "901234567890123456",
      status: "active",
      reservationId: "r-other",
      creationRequestId: "c-other",
    });
    await fx.service.handle({ guildId, userId, channelId: channelA }, "event-target");
    await fx.service.handle(
      { guildId: otherGuildId, userId: otherUserId, channelId: otherChannelId },
      "event-other",
    );
    await fx.service.getSnapshot(guildId, userId, "Target");

    const result = await fx.service.purgeGuild(guildId);

    expect(result).toEqual({ sessions: 1, members: 1, daily: 1, events: 1 });
    expect(await fx.repository.findActive(guildId, userId)).toBeUndefined();
    expect(await fx.repository.getMember(guildId, userId)).toBeUndefined();
    expect(await fx.repository.findActive(otherGuildId, otherUserId)).toBeDefined();
    expect([...fx.cache.values.keys()].some((key) => key.includes(guildId))).toBe(false);
    expect([...fx.cache.values.keys()].some((key) => key.includes(otherGuildId))).toBe(true);
  });

  test("factory-reset finalization closes active sessions and cleanup-only rooms do not reopen", async () => {
    const fx = fixture(new Date("2026-09-24T10:00:00Z"));
    await fx.cache.connect();
    await addManagedChannel(fx, channelA);
    await fx.service.handle({ guildId, userId, channelId: channelA }, "join-before-reset");
    fx.setNow(new Date("2026-09-24T10:05:00Z"));

    await fx.channels.setCleanupCategoryId(channelA, "901234567890123456");
    await fx.service.stopGuildTracking(guildId, "factory-reset:test");
    await fx.service.handle({ guildId, userId, channelId: channelA }, "event-after-reset");

    expect(await fx.repository.findActive(guildId, userId)).toBeUndefined();
    expect((await fx.repository.getMember(guildId, userId))?.totalSeconds).toBe(300);
  });
});
