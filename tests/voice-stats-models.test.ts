import { describe, expect, test } from "bun:test";

import { VoiceDailyStatsModel } from "../src/models/voice-daily-stats.ts";
import { VoiceMemberStatsModel } from "../src/models/voice-member-stats.ts";
import { VoiceStatsEventModel } from "../src/models/voice-stats-event.ts";
import { VoiceStatsSessionModel } from "../src/models/voice-stats-session.ts";

const guildId = "123456789012345678";
const userId = "234567890123456789";
const channelId = "345678901234567890";

describe("voice statistics models", () => {
  test("strictly validates required snowflakes and bounded names", async () => {
    const valid = new VoiceStatsSessionModel({
      sessionId: "session", guildId, userId, channelId, status: "active",
      startedAt: new Date(), lastConfirmedAt: new Date(), durationSeconds: 0, joinEventId: "event",
    });
    await valid.validate();
    await new VoiceStatsEventModel({
      eventId: "event",
      guildId,
      userId,
      status: "completed",
      processingOwner: "worker-test",
      expiresAt: new Date(),
    }).validate();
    const invalid = new VoiceMemberStatsModel({ guildId: "bad", userId, totalSeconds: -1, sessionCount: 0, firstTrackedAt: new Date(), lastActivityAt: new Date() });
    const rejected = await invalid.validate().then(() => false, () => true);
    expect(rejected).toBe(true);
  });

  test("declares structurally matching unique and TTL indexes", () => {
    const sessionIndexes = VoiceStatsSessionModel.schema.indexes();
    const active = sessionIndexes.find(([, options]) => options.name === "voice_stats_sessions_one_active_user");
    expect(active?.[0]).toEqual({ guildId: 1, userId: 1, status: 1 });
    expect(active?.[1]).toMatchObject({ unique: true, partialFilterExpression: { status: "active" } });
    expect(sessionIndexes.some(([keys, options]) =>
      options.name === "voice_stats_sessions_guild_startedAt" &&
      JSON.stringify(keys) === JSON.stringify({ guildId: 1, startedAt: -1 }),
    )).toBe(true);
    expect(VoiceMemberStatsModel.schema.indexes().some(([, options]) => options.name === "voice_member_stats_guild_user_unique" && options.unique === true)).toBe(true);
    expect(VoiceDailyStatsModel.schema.indexes().some(([, options]) => options.name === "voice_daily_stats_guild_user_day_unique" && options.unique === true)).toBe(true);
    expect(VoiceStatsEventModel.schema.indexes().some(([, options]) => options.name === "voice_stats_events_eventId_unique" && options.unique === true)).toBe(true);
    const sessionTtl = VoiceStatsSessionModel.schema.indexes().find(([, options]) => options.name === "voice_stats_sessions_expiresAt_ttl");
    expect(sessionTtl?.[1].expireAfterSeconds).toBe(0);
  });
});
