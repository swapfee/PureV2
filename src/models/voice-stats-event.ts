import { Schema, model, type InferSchemaType, type Model } from "mongoose";
import { SNOWFLAKE_PATTERN } from "./snowflake.ts";

const voiceStatsEventSchema = new Schema(
  {
    eventId: { type: String, required: true, trim: true, maxlength: 100 },
    guildId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    userId: { type: String, required: true, trim: true, match: SNOWFLAKE_PATTERN },
    status: { type: String, required: true, enum: ["processing", "completed", "failed"] },
    processingOwner: { type: String, required: true, trim: true, maxlength: 64 },
    failureReason: { type: String, required: false, maxlength: 500 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, collection: "voice_stats_events", autoIndex: false },
);
voiceStatsEventSchema.index({ eventId: 1 }, { unique: true, name: "voice_stats_events_eventId_unique" });
voiceStatsEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "voice_stats_events_expiresAt_ttl" });

export type VoiceStatsEventDocument = InferSchemaType<typeof voiceStatsEventSchema> & { createdAt: Date; updatedAt: Date };
export const VoiceStatsEventModel: Model<VoiceStatsEventDocument> = model<VoiceStatsEventDocument>("VoiceStatsEvent", voiceStatsEventSchema);
