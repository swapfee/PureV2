import { Schema, model, type InferSchemaType, type Model } from "mongoose";

import {
  CHANNEL_NAME_TEMPLATE_MAX,
  CHANNEL_NAME_TEMPLATE_MIN,
  DEFAULT_CHANNEL_NAME_TEMPLATE,
  SNOWFLAKE_PATTERN,
} from "./snowflake.ts";

const snowflakeString = {
  type: String,
  required: true,
  trim: true,
  match: SNOWFLAKE_PATTERN,
} as const;

export const GUILD_PERMISSION_SOURCES = ["category", "lobby"] as const;
export type GuildPermissionSource = (typeof GUILD_PERMISSION_SOURCES)[number];

export const GUILD_NAMING_MODES = ["template", "sequence"] as const;
export type GuildNamingMode = (typeof GUILD_NAMING_MODES)[number];

export const GUILD_CHANNEL_HOISTS = ["top", "bottom"] as const;
export type GuildChannelHoist = (typeof GUILD_CHANNEL_HOISTS)[number];

const guildConfigSchema = new Schema(
  {
    guildId: { ...snowflakeString, unique: true, index: true },
    enabled: { type: Boolean, required: true, default: false },
    lobbyChannelId: { ...snowflakeString },
    categoryId: { ...snowflakeString },
    /** Text channel for Join-to-Create / VC operational errors (optional for legacy guilds). */
    errorLogChannelId: {
      type: String,
      required: false,
      trim: true,
      match: SNOWFLAKE_PATTERN,
    },
    /** Optional shared text-channel interface for managed temporary voice channels. */
    interfaceChannelId: {
      type: String,
      required: false,
      trim: true,
      match: SNOWFLAKE_PATTERN,
    },
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
    /** When true, temp-channel owners receive Manage Channel on create. */
    ownerCanEdit: {
      type: Boolean,
      required: true,
      default: false,
    },
    /** Where newly created temporary channels copy permission overwrites from. */
    permissionSource: {
      type: String,
      required: true,
      enum: GUILD_PERMISSION_SOURCES,
      default: "category",
    },
    /** template = {username} style; sequence = "Base 1", "Base 2", … */
    namingMode: {
      type: String,
      required: true,
      enum: GUILD_NAMING_MODES,
      default: "template",
    },
    /** Next sequential number to assign (sequence naming mode). */
    sequenceNext: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    /** Creation order below the lobby: top is oldest-first; bottom is newest-first. */
    channelHoist: {
      type: String,
      required: true,
      enum: GUILD_CHANNEL_HOISTS,
      default: "bottom",
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
  readonly errorLogChannelId?: string;
  readonly interfaceChannelId?: string;
  readonly channelNameTemplate: string;
  readonly defaultUserLimit?: number;
  readonly ownerCanEdit: boolean;
  readonly permissionSource: GuildPermissionSource;
  readonly namingMode: GuildNamingMode;
  readonly sequenceNext: number;
  readonly channelHoist: GuildChannelHoist;
  readonly moderatorRoleIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertGuildConfigInput {
  readonly guildId: string;
  readonly enabled: boolean;
  readonly lobbyChannelId: string;
  readonly categoryId: string;
  readonly errorLogChannelId?: string;
  readonly interfaceChannelId?: string;
  readonly channelNameTemplate: string;
  readonly defaultUserLimit?: number;
  readonly ownerCanEdit?: boolean;
  readonly permissionSource?: GuildPermissionSource;
  readonly namingMode?: GuildNamingMode;
  readonly sequenceNext?: number;
  readonly channelHoist?: GuildChannelHoist;
  readonly moderatorRoleIds?: readonly string[];
}
