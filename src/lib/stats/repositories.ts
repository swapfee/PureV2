import type { VoiceDailyStatsRecord } from "../../models/voice-daily-stats.ts";
import type { VoiceMemberStatsRecord } from "../../models/voice-member-stats.ts";
import type { VoiceStatsSessionRecord } from "../../models/voice-stats-session.ts";

export interface OpenVoiceStatsSessionInput {
  readonly sessionId: string;
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly eventId: string;
  readonly at: Date;
  readonly displayName?: string;
}

export interface VoiceStatsRepository {
  acquireEvent(eventId: string, guildId: string, userId: string, at: Date, processingOwner: string): Promise<boolean>;
  completeEvent(eventId: string): Promise<void>;
  failEvent(eventId: string, reason: string): Promise<void>;
  findActive(guildId: string, userId: string): Promise<VoiceStatsSessionRecord | undefined>;
  listActiveByGuild(guildId: string): Promise<readonly VoiceStatsSessionRecord[]>;
  open(input: OpenVoiceStatsSessionInput): Promise<VoiceStatsSessionRecord>;
  close(guildId: string, userId: string, eventId: string, at: Date): Promise<VoiceStatsSessionRecord | undefined>;
  checkpoint(guildId: string, userId: string, at: Date): Promise<void>;
  getMember(guildId: string, userId: string): Promise<VoiceMemberStatsRecord | undefined>;
  getDaily(guildId: string, userId: string, from: Date, to: Date): Promise<readonly VoiceDailyStatsRecord[]>;
  countActiveDays(guildId: string, userId: string): Promise<number>;
  getLeaderboard(guildId: string, limit: number): Promise<readonly VoiceMemberStatsRecord[]>;
}

export function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function splitDurationByUtcDay(start: Date, end: Date): readonly { day: Date; seconds: number }[] {
  if (end.getTime() <= start.getTime()) return [];
  const parts: { day: Date; seconds: number }[] = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const day = utcDayStart(cursor);
    const next = new Date(day.getTime() + 86_400_000);
    const boundary = next < end ? next : end;
    const seconds = Math.max(0, Math.floor((boundary.getTime() - cursor.getTime()) / 1000));
    if (seconds > 0) parts.push({ day, seconds });
    cursor = boundary;
  }
  return parts;
}
