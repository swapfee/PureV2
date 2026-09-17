import { Schema, model, type InferSchemaType, type Model } from "mongoose";

import { SNOWFLAKE_PATTERN } from "./snowflake.ts";

export const OWNER_BLOCK_LIST_MAX = 50;

const snowflakeString = {
  type: String,
  required: true,
  trim: true,
  match: SNOWFLAKE_PATTERN,
} as const;

const ownerBlockListSchema = new Schema(
  {
    guildId: { ...snowflakeString },
    ownerId: { ...snowflakeString },
    blockedUserIds: {
      type: [String],
      required: true,
      default: [],
      validate: [
        {
          validator: (values: string[]) => values.length <= OWNER_BLOCK_LIST_MAX,
          message: `blockedUserIds cannot exceed ${OWNER_BLOCK_LIST_MAX} entries`,
        },
        {
          validator: (values: string[]) => values.every((value) => SNOWFLAKE_PATTERN.test(value)),
          message: "blockedUserIds must contain Discord snowflakes",
        },
        {
          validator: (values: string[]) => new Set(values).size === values.length,
          message: "blockedUserIds must not contain duplicates",
        },
      ],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "owner_block_lists",
    autoIndex: false,
  },
);

ownerBlockListSchema.index(
  { guildId: 1, ownerId: 1 },
  { unique: true, name: "owner_block_lists_guild_owner_unique" },
);

export type OwnerBlockListDocument = InferSchemaType<typeof ownerBlockListSchema> & {
  createdAt: Date;
  updatedAt: Date;
};

export type OwnerBlockListModelType = Model<OwnerBlockListDocument>;

export const OwnerBlockListModel: OwnerBlockListModelType = model<OwnerBlockListDocument>(
  "OwnerBlockList",
  ownerBlockListSchema,
);

export interface OwnerBlockListRecord {
  readonly guildId: string;
  readonly ownerId: string;
  readonly blockedUserIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
