import { Schema, model, type InferSchemaType, type Model } from "mongoose";
import { SNOWFLAKE_PATTERN } from "./snowflake.ts";

const voiceDailyStatsSchema = new Schema(
  {
    guildId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    userId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    day: { type: Date, required: true },
    durationSeconds: { type: Number, required: true, default: 0, min: 0 },
    sessionCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false, collection: "voice_daily_stats", autoIndex: false },
);
voiceDailyStatsSchema.index({ guildId: 1, userId: 1, day: 1 }, { unique: true, name: "voice_daily_stats_guild_user_day_unique" });
voiceDailyStatsSchema.index({ guildId: 1, day: 1 }, { name: "voice_daily_stats_guild_day" });

export type VoiceDailyStatsDocument = InferSchemaType<typeof voiceDailyStatsSchema> & { createdAt: Date; updatedAt: Date };
export const VoiceDailyStatsModel: Model<VoiceDailyStatsDocument> = model<VoiceDailyStatsDocument>("VoiceDailyStats", voiceDailyStatsSchema);
export interface VoiceDailyStatsRecord {
  readonly guildId: string;
  readonly userId: string;
  readonly day: Date;
  readonly durationSeconds: number;
  readonly sessionCount: number;
}
