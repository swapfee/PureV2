import { Schema, model, type InferSchemaType, type Model } from "mongoose";
import { SNOWFLAKE_PATTERN } from "./snowflake.ts";

export const VOICE_STATS_SESSION_STATUSES = ["active", "completed"] as const;
export type VoiceStatsSessionStatus = (typeof VOICE_STATS_SESSION_STATUSES)[number];

const voiceStatsSessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, trim: true, maxlength: 80 },
    guildId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    userId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    channelId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    status: { type: String, required: true, enum: VOICE_STATS_SESSION_STATUSES },
    startedAt: { type: Date, required: true },
    lastConfirmedAt: { type: Date, required: true },
    endedAt: { type: Date, required: false },
    durationSeconds: { type: Number, required: true, default: 0, min: 0 },
    joinEventId: { type: String, required: true, trim: true, maxlength: 100 },
    leaveEventId: { type: String, required: false, trim: true, maxlength: 100 },
    expiresAt: { type: Date, required: false },
  },
  { timestamps: true, versionKey: false, collection: "voice_stats_sessions", autoIndex: false },
);

voiceStatsSessionSchema.index({ sessionId: 1 }, { unique: true, name: "voice_stats_sessions_sessionId_unique" });
voiceStatsSessionSchema.index(
  { guildId: 1, userId: 1, status: 1 },
  { unique: true, name: "voice_stats_sessions_one_active_user", partialFilterExpression: { status: "active" } },
);
voiceStatsSessionSchema.index({ guildId: 1, userId: 1, startedAt: -1 }, { name: "voice_stats_sessions_member_startedAt" });
voiceStatsSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "voice_stats_sessions_expiresAt_ttl" });

export type VoiceStatsSessionDocument = InferSchemaType<typeof voiceStatsSessionSchema> & { createdAt: Date; updatedAt: Date };
export const VoiceStatsSessionModel: Model<VoiceStatsSessionDocument> = model<VoiceStatsSessionDocument>("VoiceStatsSession", voiceStatsSessionSchema);

export interface VoiceStatsSessionRecord {
  readonly sessionId: string;
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly status: VoiceStatsSessionStatus;
  readonly startedAt: Date;
  readonly lastConfirmedAt: Date;
  readonly endedAt?: Date;
  readonly durationSeconds: number;
  readonly joinEventId: string;
  readonly leaveEventId?: string;
  readonly expiresAt?: Date;
}
