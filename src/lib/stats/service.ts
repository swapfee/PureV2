import { createHash } from "node:crypto";

import type { Logger } from "../logger.ts";
import type { Clock } from "../j2c/time.ts";
import type { TemporaryChannelRepository } from "../j2c/repositories.ts";
import type { VoiceStateUpdatePayload } from "../runtime-types.ts";
import { statsQueryCacheKey, type VoiceStatsCache } from "./cache.ts";
import type { VoiceStatsMetrics } from "./metrics.ts";
import {
  splitDurationByUtcDay,
  utcDayStart,
  type VoiceStatsPurgeResult,
  type VoiceStatsRepository,
} from "./repositories.ts";

export interface VoiceStatsSnapshot {
  readonly guildId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly trackedSince?: Date;
  readonly totalSeconds: number;
  readonly sessionCount: number;
  readonly activeDays: number;
  readonly currentSessionSeconds: number;
  readonly daily: readonly { readonly day: Date; readonly seconds: number }[];
  readonly leaderboard: readonly { readonly userId: string; readonly displayName: string; readonly totalSeconds: number }[];
}

export interface VoiceStatsService {
  handle(payload: VoiceStateUpdatePayload, eventId: string): Promise<void>;
  reconcileGuild(guildId: string, states: readonly VoiceStateUpdatePayload[]): Promise<void>;
  expectGuilds(guildIds: readonly string[]): void;
  checkpointGuild(guildId: string): Promise<void>;
  getSnapshot(guildId: string, userId: string, displayName: string): Promise<VoiceStatsSnapshot>;
  stopGuildTracking(guildId: string, eventId: string): Promise<void>;
  purgeGuild(guildId: string): Promise<VoiceStatsPurgeResult>;
  isReady(): boolean;
}

interface Options {
  readonly repository: VoiceStatsRepository;
  readonly channels: TemporaryChannelRepository;
  readonly cache: VoiceStatsCache;
  readonly metrics: VoiceStatsMetrics;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly processorId?: string;
}

function stableSessionId(eventId: string, guildId: string, userId: string): string {
  return createHash("sha256").update(`${eventId}:${guildId}:${userId}`).digest("hex");
}

function parseCachedSnapshot(value: string): VoiceStatsSnapshot | undefined {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const guildId = Reflect.get(parsed, "guildId");
  const userId = Reflect.get(parsed, "userId");
  const displayName = Reflect.get(parsed, "displayName");
  const totalSeconds = Reflect.get(parsed, "totalSeconds");
  const sessionCount = Reflect.get(parsed, "sessionCount");
  const activeDays = Reflect.get(parsed, "activeDays");
  const currentSessionSeconds = Reflect.get(parsed, "currentSessionSeconds");
  const dailyRaw = Reflect.get(parsed, "daily");
  const leaderboardRaw = Reflect.get(parsed, "leaderboard");
  if (
    typeof guildId !== "string" || typeof userId !== "string" ||
    typeof displayName !== "string" || typeof totalSeconds !== "number" ||
    typeof sessionCount !== "number" || typeof activeDays !== "number" ||
    typeof currentSessionSeconds !== "number" || !Array.isArray(dailyRaw) ||
    !Array.isArray(leaderboardRaw)
  ) return undefined;
  const daily: { day: Date; seconds: number }[] = [];
  for (const item of dailyRaw) {
    if (typeof item !== "object" || item === null) return undefined;
    const day = Reflect.get(item, "day");
    const seconds = Reflect.get(item, "seconds");
    if (typeof day !== "string" || typeof seconds !== "number") return undefined;
    daily.push({ day: new Date(day), seconds });
  }
  const leaderboard: { userId: string; displayName: string; totalSeconds: number }[] = [];
  for (const item of leaderboardRaw) {
    if (typeof item !== "object" || item === null) return undefined;
    const rankedUserId = Reflect.get(item, "userId");
    const rankedName = Reflect.get(item, "displayName");
    const rankedTotalSeconds = Reflect.get(item, "totalSeconds");
    if (typeof rankedUserId !== "string" || typeof rankedName !== "string" || typeof rankedTotalSeconds !== "number") return undefined;
    leaderboard.push({ userId: rankedUserId, displayName: rankedName, totalSeconds: rankedTotalSeconds });
  }
  const trackedSince = Reflect.get(parsed, "trackedSince");
  if (trackedSince !== undefined && typeof trackedSince !== "string") return undefined;
  return {
    guildId, userId, displayName, totalSeconds, sessionCount, activeDays,
    currentSessionSeconds, daily, leaderboard,
    ...(trackedSince ? { trackedSince: new Date(trackedSince) } : {}),
  };
}

export function createVoiceStatsService(options: Options): VoiceStatsService {
  const processorId = options.processorId ?? crypto.randomUUID();
  const guildQueues = new Map<string, Promise<void>>();
  const lastSequences = new Map<string, number>();
  let gatewayAnnounced = false;
  const pendingGuilds = new Set<string>();
  const serial = async <T>(guildId: string, task: () => Promise<T>): Promise<T> => {
    const prior = guildQueues.get(guildId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => next);
    guildQueues.set(guildId, queued);
    await prior;
    try { return await task(); } finally { release?.(); if (guildQueues.get(guildId) === queued) guildQueues.delete(guildId); }
  };
  const isManaged = async (channelId: string | null): Promise<boolean> => {
    if (!channelId) return false;
    const record = await options.channels.findByChannelId(channelId);
    return !record?.cleanupCategoryId &&
      (record?.status === "active" || record?.status === "creating");
  };
  const cacheFailure = (error: unknown, operation: string) => {
    options.metrics.increment("redisFailures");
    options.logger.warn("Voice stats Redis operation failed", { operation, error });
  };
  const handle = async (payload: VoiceStateUpdatePayload, eventId: string): Promise<void> => serial(payload.guildId, async () => {
    if (payload.isBot) return;
    const sequenceKey = `${payload.guildId}:${payload.userId}`;
    const lastSequence = lastSequences.get(sequenceKey);
    if (payload.gatewaySequence !== undefined && lastSequence !== undefined && payload.gatewaySequence <= lastSequence) {
      options.metrics.increment("deduplicatedEvents");
      return;
    }
    try {
      if (await options.cache.hasRecentEvent(eventId)) {
        options.metrics.increment("deduplicatedEvents");
        if (payload.gatewaySequence !== undefined) lastSequences.set(sequenceKey, payload.gatewaySequence);
        return;
      }
    } catch (error) { cacheFailure(error, "event_dedupe_get"); }
    const now = options.clock.now();
    if (!(await options.repository.acquireEvent(eventId, payload.guildId, payload.userId, now, processorId))) {
      options.metrics.increment("deduplicatedEvents");
      if (payload.gatewaySequence !== undefined) lastSequences.set(sequenceKey, payload.gatewaySequence);
      return;
    }
    try {
      const active = await options.repository.findActive(payload.guildId, payload.userId);
      const managed = await isManaged(payload.channelId);
      if (active && (!managed || active.channelId !== payload.channelId)) {
        await options.repository.close(payload.guildId, payload.userId, eventId, now);
        options.metrics.increment("sessionCloses");
        try { await options.cache.deleteActive(payload.guildId, payload.userId); } catch (error) { cacheFailure(error, "delete_active"); }
      }
      if (managed && payload.channelId && (!active || active.channelId !== payload.channelId)) {
        const opened = await options.repository.open({
          sessionId: stableSessionId(eventId, payload.guildId, payload.userId), guildId: payload.guildId,
          userId: payload.userId, channelId: payload.channelId, eventId, at: now,
          ...(payload.displayName ? { displayName: payload.displayName } : {}),
        });
        options.metrics.increment("sessionOpens");
        try { await options.cache.setActive(opened); } catch (error) { cacheFailure(error, "set_active"); }
      } else if (active && managed && active.channelId === payload.channelId) {
        await options.repository.checkpoint(payload.guildId, payload.userId, now);
      }
      await options.repository.completeEvent(eventId);
      try { await options.cache.markRecentEvent(eventId); } catch (error) { cacheFailure(error, "event_dedupe_set"); }
      if (payload.gatewaySequence !== undefined) lastSequences.set(sequenceKey, payload.gatewaySequence);
    } catch (error) {
      await options.repository.failEvent(eventId, error instanceof Error ? error.message : "unknown_error");
      throw error;
    }
  });

  return {
    handle,
    async reconcileGuild(guildId, states) {
      await serial(guildId, async () => {
        const humans = states.filter((state) => !state.isBot && state.guildId === guildId);
        const authoritative = new Map(humans.filter((state) => state.channelId).map((state) => [state.userId, state]));
        const active = await options.repository.listActiveByGuild(guildId);
        for (const session of active) {
          const current = authoritative.get(session.userId);
          if (!current || current.channelId !== session.channelId || !(await isManaged(current.channelId))) {
            await options.repository.close(guildId, session.userId, `reconcile-close:${session.sessionId}`, session.lastConfirmedAt);
            options.metrics.increment("reconciliationFindings");
            try { await options.cache.deleteActive(guildId, session.userId); } catch (error) { cacheFailure(error, "reconcile_delete"); }
          } else {
            try { await options.cache.setActive(session); } catch (error) { cacheFailure(error, "reconcile_set"); }
            authoritative.delete(session.userId);
          }
        }
        for (const state of authoritative.values()) {
          if (!state.channelId || !(await isManaged(state.channelId))) continue;
          const eventId = `reconcile-open:${guildId}:${state.userId}:${state.channelId}`;
          const now = options.clock.now();
          const opened = await options.repository.open({ sessionId: stableSessionId(eventId, guildId, state.userId), guildId, userId: state.userId, channelId: state.channelId, eventId, at: now, ...(state.displayName ? { displayName: state.displayName } : {}) });
          options.metrics.increment("reconciliationFindings");
          try { await options.cache.setActive(opened); } catch (error) { cacheFailure(error, "reconcile_open"); }
        }
        pendingGuilds.delete(guildId);
      });
    },
    expectGuilds(guildIds) {
      gatewayAnnounced = true;
      for (const guildId of guildIds) pendingGuilds.add(guildId);
    },
    async checkpointGuild(guildId) {
      const now = options.clock.now();
      for (const session of await options.repository.listActiveByGuild(guildId)) {
        await options.repository.checkpoint(guildId, session.userId, now);
        try { await options.cache.setActive({ ...session, lastConfirmedAt: now }); } catch (error) { cacheFailure(error, "checkpoint_set"); }
      }
    },
    async getSnapshot(guildId, userId, displayName) {
      const key = statsQueryCacheKey(guildId, userId);
      if (options.cache.isReady()) {
        try {
          const cached = await options.cache.getJson(key);
          if (cached) {
            const parsed = parseCachedSnapshot(cached);
            if (parsed) return parsed;
          }
        } catch (error) { cacheFailure(error, "query_get"); }
      }
      const now = options.clock.now();
      const from = new Date(utcDayStart(now).getTime() - 6 * 86_400_000);
      const member = await options.repository.getMember(guildId, userId);
      const active = await options.repository.findActive(guildId, userId);
      const dailyRows = await options.repository.getDaily(guildId, userId, from, utcDayStart(now));
      const byDay = new Map(dailyRows.map((row) => [row.day.toISOString(), row.durationSeconds]));
      if (active) {
        for (const part of splitDurationByUtcDay(active.startedAt, now)) {
          byDay.set(part.day.toISOString(), (byDay.get(part.day.toISOString()) ?? 0) + part.seconds);
        }
      }
      const daily = Array.from({ length: 7 }, (_, index) => {
        const day = new Date(from.getTime() + index * 86_400_000);
        return { day, seconds: byDay.get(day.toISOString()) ?? 0 };
      });
      const leaderboard = (await options.repository.getLeaderboard(guildId, 5)).map((row) => ({ userId: row.userId, displayName: row.lastKnownDisplayName ?? `Member ${row.userId.slice(-4)}`, totalSeconds: row.totalSeconds }));
      const currentSessionSeconds = active ? Math.max(0, Math.floor((now.getTime() - active.startedAt.getTime()) / 1_000)) : 0;
      const snapshot: VoiceStatsSnapshot = {
        guildId, userId, displayName, ...(member ? { trackedSince: member.firstTrackedAt } : {}),
        totalSeconds: (member?.totalSeconds ?? 0) + currentSessionSeconds,
        sessionCount: member?.sessionCount ?? 0, activeDays: await options.repository.countActiveDays(guildId, userId),
        currentSessionSeconds, daily, leaderboard,
      };
      try { await options.cache.setJson(key, JSON.stringify(snapshot), 30); } catch (error) { cacheFailure(error, "query_set"); }
      return snapshot;
    },
    async stopGuildTracking(guildId, eventId) {
      await serial(guildId, async () => {
        const now = options.clock.now();
        for (const session of await options.repository.listActiveByGuild(guildId)) {
          await options.repository.close(guildId, session.userId, eventId, now);
          options.metrics.increment("sessionCloses");
          try {
            await options.cache.deleteActive(guildId, session.userId);
          } catch (error) {
            cacheFailure(error, "reset_delete_active");
          }
        }
      });
    },
    async purgeGuild(guildId) {
      return serial(guildId, async () => {
        const result = await options.repository.purgeGuild(guildId);
        try {
          await options.cache.purgeGuild(guildId);
        } catch (error) {
          // MongoDB is authoritative. Cache failure makes stats unready, but it
          // must not turn a completed durable purge into a misleading failure.
          cacheFailure(error, "purge_guild");
        }
        for (const key of lastSequences.keys()) {
          if (key.startsWith(`${guildId}:`)) lastSequences.delete(key);
        }
        options.logger.info("Voice statistics deleted for guild", {
          guildId,
          deletedSessions: result.sessions,
          deletedMembers: result.members,
          deletedDailyRows: result.daily,
          deletedEvents: result.events,
        });
        return result;
      });
    },
    isReady: () => gatewayAnnounced && pendingGuilds.size === 0 && options.cache.isReady(),
  };
}
