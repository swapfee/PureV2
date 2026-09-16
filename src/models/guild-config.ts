import { Schema, model, type InferSchemaType, type Model } from "mongoose";

import { CHANNEL_NAME_TEMPLATE_MAX, CHANNEL_NAME_TEMPLATE_MIN, DEFAULT_CHANNEL_NAME_TEMPLATE, SNOWFLAKE_PATTERN } from "./snowflake.ts";

const snowflakeString = {
  type: String,
  required: true,
  trim: true,
  match: SNOWFLAKE_PATTERN,
} as const;

const guildConfigSchema = new Schema(
  {
    guildId: { ...snowflakeString, unique: true, index: true },
    enabled: { type: Boolean, required: true, default: false },
    lobbyChannelId: { ...snowflakeString },
    categoryId: { ...snowflakeString },
    channelNameTemplate: {
      type: String,
      required: true,
      trim: true,
      minlength: CHANNEL_NAME_TEMPLATE_MIN,
      maxlength: CHANNEL_NAME_TEMPLATE_MAX,
      default: DEFAULT_CHANNEL_NAME_TEMPLATE,
    },
    defaultUserLimit: {
      type: Number,
      required: false,
      min: 0,
      max: 99,
    },
    moderatorRoleIds: {
      type: [String],
      required: true,
      default: [],
      validate: {
        validator: (values: string[]) => values.every((value) => SNOWFLAKE_PATTERN.test(value)),
        message: "moderatorRoleIds must contain Discord snowflakes",
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "guild_configs",
    autoIndex: false,
  },
);

guildConfigSchema.index({ guildId: 1 }, { unique: true, name: "guild_configs_guildId_unique" });

export type GuildConfigDocument = InferSchemaType<typeof guildConfigSchema> & {
  createdAt: Date;
  updatedAt: Date;
};

export type GuildConfigModel = Model<GuildConfigDocument>;

export const GuildConfigModel: GuildConfigModel = model<GuildConfigDocument>(
  "GuildConfig",
  guildConfigSchema,
);

export interface GuildConfigRecord {
  readonly guildId: string;
  readonly enabled: boolean;
  readonly lobbyChannelId: string;
  readonly categoryId: string;
  readonly channelNameTemplate: string;
  readonly defaultUserLimit?: number;
  readonly moderatorRoleIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertGuildConfigInput {
  readonly guildId: string;
  readonly enabled: boolean;
  readonly lobbyChannelId: string;
  readonly categoryId: string;
  readonly channelNameTemplate: string;
  readonly defaultUserLimit?: number;
  readonly moderatorRoleIds?: readonly string[];
}
