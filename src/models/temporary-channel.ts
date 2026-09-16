import { Schema, model, type InferSchemaType, type Model } from "mongoose";

import { SNOWFLAKE_PATTERN } from "./snowflake.ts";

export const TEMPORARY_CHANNEL_STATUSES = ["creating", "active", "deleting", "stale"] as const;
export type TemporaryChannelStatus = (typeof TEMPORARY_CHANNEL_STATUSES)[number];

const snowflakeString = {
  type: String,
  required: true,
  trim: true,
  match: SNOWFLAKE_PATTERN,
} as const;

const temporaryChannelSchema = new Schema(
  {
    guildId: { ...snowflakeString, index: true },
    channelId: { ...snowflakeString, unique: true },
    ownerId: { ...snowflakeString, index: true },
    lobbyChannelId: { ...snowflakeString },
    status: {
      type: String,
      required: true,
      enum: TEMPORARY_CHANNEL_STATUSES,
      index: true,
    },
    reservationId: { type: String, required: true, trim: true, maxlength: 80 },
    creationRequestId: { type: String, required: true, trim: true, maxlength: 80 },
    occupantIds: {
      type: [String],
      required: true,
      default: [],
      validate: {
        validator: (values: string[]) => values.every((value) => SNOWFLAKE_PATTERN.test(value)),
        message: "occupantIds must contain Discord snowflakes",
      },
    },
    emptySince: { type: Date, required: false },
    deletionAttemptedAt: { type: Date, required: false },
    deletionRequestId: { type: String, required: false, trim: true, maxlength: 80 },
    lastError: { type: String, required: false, maxlength: 2_000 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "temporary_channels",
    autoIndex: false,
  },
);

temporaryChannelSchema.index({ channelId: 1 }, { unique: true, name: "temporary_channels_channelId_unique" });
temporaryChannelSchema.index(
  { guildId: 1, ownerId: 1 },
  {
    unique: true,
    name: "temporary_channels_one_active_owner",
    // deleting continues to block replacement until Discord confirms cleanup
    partialFilterExpression: { status: { $in: ["creating", "active", "deleting"] } },
  },
);
temporaryChannelSchema.index({ status: 1, updatedAt: 1 }, { name: "temporary_channels_status_updatedAt" });
temporaryChannelSchema.index({ guildId: 1, status: 1 }, { name: "temporary_channels_guild_status" });

export type TemporaryChannelDocument = InferSchemaType<typeof temporaryChannelSchema> & {
  createdAt: Date;
  updatedAt: Date;
};

export type TemporaryChannelModelType = Model<TemporaryChannelDocument>;

export const TemporaryChannelModel: TemporaryChannelModelType = model<TemporaryChannelDocument>(
  "TemporaryChannel",
  temporaryChannelSchema,
);

export interface TemporaryChannelRecord {
  readonly guildId: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly lobbyChannelId: string;
  readonly status: TemporaryChannelStatus;
  readonly reservationId: string;
  readonly creationRequestId: string;
  readonly occupantIds: readonly string[];
  readonly emptySince?: Date;
  readonly deletionAttemptedAt?: Date;
  readonly deletionRequestId?: string;
  readonly lastError?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
