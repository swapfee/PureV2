import type { VoiceDailyStatsRecord } from "../../models/voice-daily-stats.ts";
import type { VoiceMemberStatsRecord } from "../../models/voice-member-stats.ts";
import type { VoiceStatsSessionRecord } from "../../models/voice-stats-session.ts";
import { splitDurationByUtcDay, utcDayStart, type VoiceStatsRepository } from "./repositories.ts";

function memberKey(guildId: string, userId: string): string { return `${guildId}:${userId}`; }
function dailyKey(guildId: string, userId: string, day: Date): string { return `${guildId}:${userId}:${day.toISOString()}`; }

export function createMemoryVoiceStatsRepository(): VoiceStatsRepository & {
  readonly sessions: Map<string, VoiceStatsSessionRecord>;
  readonly members: Map<string, VoiceMemberStatsRecord>;
  readonly daily: Map<string, VoiceDailyStatsRecord>;
} {
  const sessions = new Map<string, VoiceStatsSessionRecord>();
  const members = new Map<string, VoiceMemberStatsRecord>();
  const daily = new Map<string, VoiceDailyStatsRecord>();
  const events = new Map<string, {
    guildId: string;
    status: "processing" | "completed" | "failed";
    processingOwner: string;
  }>();
  const findActive = (guildId: string, userId: string) =>
    [...sessions.values()].find((entry) => entry.guildId === guildId && entry.userId === userId && entry.status === "active");
  return {
    sessions, members, daily,
    async acquireEvent(eventId, guildId, _userId, _at, processingOwner) {
      const event = events.get(eventId);
      if (event?.status === "completed") return false;
      if (event?.status === "processing" && event.processingOwner === processingOwner) return false;
      events.set(eventId, { guildId, status: "processing", processingOwner });
      return true;
    },
    async completeEvent(eventId) {
      const event = events.get(eventId);
      if (event) events.set(eventId, { ...event, status: "completed" });
    },
    async failEvent(eventId) {
      const event = events.get(eventId);
      if (event) events.set(eventId, { ...event, status: "failed" });
    },
    async findActive(guildId, userId) { return findActive(guildId, userId); },
    async listActiveByGuild(guildId) { return [...sessions.values()].filter((entry) => entry.guildId === guildId && entry.status === "active"); },
    async listGuildSessionsOverlapping(guildId, from, to) {
      return [...sessions.values()].filter((entry) =>
        entry.guildId === guildId && entry.startedAt < to &&
        (entry.status === "active" || (entry.endedAt !== undefined && entry.endedAt > from)),
      ).toSorted((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
    },
    async listMemberSessionsOverlapping(guildId, userId, from, to) {
      return [...sessions.values()].filter((entry) =>
        entry.guildId === guildId && entry.userId === userId && entry.startedAt < to &&
        (entry.status === "active" || (entry.endedAt !== undefined && entry.endedAt > from)),
      ).toSorted((left, right) => left.startedAt.getTime() - right.startedAt.getTime());
    },
    async open(input) {
      const existing = findActive(input.guildId, input.userId);
      if (existing) throw new Error("active_voice_stats_session_exists");
      const record: VoiceStatsSessionRecord = {
        sessionId: input.sessionId, guildId: input.guildId, userId: input.userId, channelId: input.channelId,
        status: "active", startedAt: input.at, lastConfirmedAt: input.at, durationSeconds: 0, joinEventId: input.eventId,
      };
      sessions.set(record.sessionId, record);
      const key = memberKey(input.guildId, input.userId);
      const previous = members.get(key);
      members.set(key, {
        guildId: input.guildId, userId: input.userId, totalSeconds: previous?.totalSeconds ?? 0,
        sessionCount: (previous?.sessionCount ?? 0) + 1, firstTrackedAt: previous?.firstTrackedAt ?? input.at,
        lastActivityAt: input.at,
        ...(input.displayName ? { lastKnownDisplayName: input.displayName } : previous?.lastKnownDisplayName ? { lastKnownDisplayName: previous.lastKnownDisplayName } : {}),
      });
      const day = utcDayStart(input.at);
      const dayKey = dailyKey(input.guildId, input.userId, day);
      const oldDay = daily.get(dayKey);
      daily.set(dayKey, { guildId: input.guildId, userId: input.userId, day, durationSeconds: oldDay?.durationSeconds ?? 0, sessionCount: (oldDay?.sessionCount ?? 0) + 1 });
      return record;
    },
    async close(guildId, userId, eventId, at) {
      const existing = findActive(guildId, userId);
      if (!existing) return undefined;
      const durationSeconds = Math.max(0, Math.floor((at.getTime() - existing.startedAt.getTime()) / 1_000));
      const closed: VoiceStatsSessionRecord = { ...existing, status: "completed", endedAt: at, lastConfirmedAt: at, durationSeconds, leaveEventId: eventId, expiresAt: new Date(at.getTime() + 90 * 86_400_000) };
      sessions.set(existing.sessionId, closed);
      const key = memberKey(guildId, userId);
      const oldMember = members.get(key);
      if (oldMember) members.set(key, { ...oldMember, totalSeconds: oldMember.totalSeconds + durationSeconds, lastActivityAt: at });
      for (const part of splitDurationByUtcDay(existing.startedAt, at)) {
        const keyForDay = dailyKey(guildId, userId, part.day);
        const oldDay = daily.get(keyForDay);
        daily.set(keyForDay, { guildId, userId, day: part.day, durationSeconds: (oldDay?.durationSeconds ?? 0) + part.seconds, sessionCount: oldDay?.sessionCount ?? 0 });
      }
      return closed;
    },
    async checkpoint(guildId, userId, at) {
      const active = findActive(guildId, userId);
      if (active) sessions.set(active.sessionId, { ...active, lastConfirmedAt: at });
    },
    async getMember(guildId, userId) { return members.get(memberKey(guildId, userId)); },
    async getDaily(guildId, userId, from, to) { return [...daily.values()].filter((entry) => entry.guildId === guildId && entry.userId === userId && entry.day >= from && entry.day <= to).toSorted((a, b) => a.day.getTime() - b.day.getTime()); },
    async countActiveDays(guildId, userId) { return [...daily.values()].filter((entry) => entry.guildId === guildId && entry.userId === userId && (entry.durationSeconds > 0 || entry.sessionCount > 0)).length; },
    async getLeaderboard(guildId, limit) { return [...members.values()].filter((entry) => entry.guildId === guildId).toSorted((a, b) => b.totalSeconds - a.totalSeconds || a.userId.localeCompare(b.userId)).slice(0, limit); },
    async purgeGuild(guildId) {
      let sessionCount = 0;
      let memberCount = 0;
      let dailyCount = 0;
      for (const [key, entry] of sessions) {
        if (entry.guildId === guildId) { sessions.delete(key); sessionCount += 1; }
      }
      for (const [key, entry] of members) {
        if (entry.guildId === guildId) { members.delete(key); memberCount += 1; }
      }
      for (const [key, entry] of daily) {
        if (entry.guildId === guildId) { daily.delete(key); dailyCount += 1; }
      }
      let eventCount = 0;
      for (const [key, entry] of events) {
        if (entry.guildId === guildId) { events.delete(key); eventCount += 1; }
      }
      return { sessions: sessionCount, members: memberCount, daily: dailyCount, events: eventCount };
    },
  };
}
