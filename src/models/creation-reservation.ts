import { Schema, model, type InferSchemaType, type Model } from "mongoose";

import { SNOWFLAKE_PATTERN } from "./snowflake.ts";

export const RESERVATION_STATUSES = ["reserved", "completed", "failed", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

const snowflakeString = {
  type: String,
  required: true,
  trim: true,
  match: SNOWFLAKE_PATTERN,
} as const;

const creationReservationSchema = new Schema(
  {
    reservationId: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    guildId: { ...snowflakeString },
    memberId: { ...snowflakeString },
    eventId: { type: String, required: true, trim: true, maxlength: 80 },
    status: {
      type: String,
      required: true,
      enum: RESERVATION_STATUSES,
      default: "reserved",
      index: true,
    },
    channelId: { type: String, required: false, trim: true, match: SNOWFLAKE_PATTERN },
    creationRequestId: { type: String, required: true, trim: true, maxlength: 80 },
    expiresAt: { type: Date, required: true, index: true },
    failureReason: { type: String, required: false, maxlength: 2_000 },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: "creation_reservations",
    autoIndex: false,
  },
);

creationReservationSchema.index(
  { guildId: 1, memberId: 1 },
  {
    unique: true,
    name: "creation_reservations_one_active",
    partialFilterExpression: { status: "reserved" },
  },
);
creationReservationSchema.index({ expiresAt: 1 }, { name: "creation_reservations_expiresAt" });
creationReservationSchema.index({ eventId: 1 }, { name: "creation_reservations_eventId" });

export type CreationReservationDocument = InferSchemaType<typeof creationReservationSchema> & {
  createdAt: Date;
  updatedAt: Date;
};

export type CreationReservationModelType = Model<CreationReservationDocument>;

export const CreationReservationModel: CreationReservationModelType = model<CreationReservationDocument>(
  "CreationReservation",
  creationReservationSchema,
);

export interface CreationReservationRecord {
  readonly reservationId: string;
  readonly guildId: string;
  readonly memberId: string;
  readonly eventId: string;
  readonly status: ReservationStatus;
  readonly channelId?: string;
  readonly creationRequestId: string;
  readonly expiresAt: Date;
  readonly failureReason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
