import { Schema, model, type InferSchemaType, type Model } from "mongoose";
import { SNOWFLAKE_PATTERN } from "./snowflake.ts";

const voiceMemberStatsSchema = new Schema(
  {
    guildId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    userId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    totalSeconds: { type: Number, required: true, default: 0, min: 0 },
    sessionCount: { type: Number, required: true, default: 0, min: 0 },
    firstTrackedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true },
    lastKnownDisplayName: { type: String, required: false, trim: true, maxlength: 100 },
  },
  { timestamps: true, versionKey: false, collection: "voice_member_stats", autoIndex: false },
);
voiceMemberStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true, name: "voice_member_stats_guild_user_unique" });
voiceMemberStatsSchema.index({ guildId: 1, totalSeconds: -1, userId: 1 }, { name: "voice_member_stats_guild_leaderboard" });

export type VoiceMemberStatsDocument = InferSchemaType<typeof voiceMemberStatsSchema> & { createdAt: Date; updatedAt: Date };
export const VoiceMemberStatsModel: Model<VoiceMemberStatsDocument> = model<VoiceMemberStatsDocument>("VoiceMemberStats", voiceMemberStatsSchema);
export interface VoiceMemberStatsRecord {
  readonly guildId: string;
  readonly userId: string;
  readonly totalSeconds: number;
  readonly sessionCount: number;
  readonly firstTrackedAt: Date;
  readonly lastActivityAt: Date;
  readonly lastKnownDisplayName?: string;
}
