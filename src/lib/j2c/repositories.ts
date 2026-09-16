import type { CreationReservationRecord, ReservationStatus } from "../../models/creation-reservation.ts";
import type { GuildConfigRecord, UpsertGuildConfigInput } from "../../models/guild-config.ts";
import type { TemporaryChannelRecord, TemporaryChannelStatus } from "../../models/temporary-channel.ts";

export interface GuildConfigRepository {
  findByGuildId(guildId: string): Promise<GuildConfigRecord | undefined>;
  upsert(input: UpsertGuildConfigInput): Promise<GuildConfigRecord>;
}

export interface CreateTemporaryChannelInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly lobbyChannelId: string;
  readonly status: TemporaryChannelStatus;
  readonly reservationId: string;
  readonly creationRequestId: string;
  readonly occupantIds?: readonly string[];
}

export interface TemporaryChannelRepository {
  create(input: CreateTemporaryChannelInput): Promise<TemporaryChannelRecord>;
  findByChannelId(channelId: string): Promise<TemporaryChannelRecord | undefined>;
  findActiveOrCreatingByOwner(guildId: string, ownerId: string): Promise<TemporaryChannelRecord | undefined>;
  /** creating | active | deleting — blocks replacement until cleanup completes */
  findBlockingOwnedChannel(guildId: string, ownerId: string): Promise<TemporaryChannelRecord | undefined>;
  listByStatus(statuses: readonly TemporaryChannelStatus[]): Promise<readonly TemporaryChannelRecord[]>;
  listActiveByGuild(guildId: string): Promise<readonly TemporaryChannelRecord[]>;
  countByStatus(status: TemporaryChannelStatus): Promise<number>;
  markActive(channelId: string, occupantIds: readonly string[]): Promise<TemporaryChannelRecord | undefined>;
  setOccupants(
    channelId: string,
    occupantIds: readonly string[],
    emptySince: Date | null,
  ): Promise<TemporaryChannelRecord | undefined>;
  beginDeleting(
    channelId: string,
    deletionRequestId: string,
    attemptedAt: Date,
  ): Promise<TemporaryChannelRecord | undefined>;
  markStale(channelId: string, lastError: string): Promise<TemporaryChannelRecord | undefined>;
  remove(channelId: string): Promise<boolean>;
}

export interface AcquireReservationInput {
  readonly reservationId: string;
  readonly guildId: string;
  readonly memberId: string;
  readonly eventId: string;
  readonly creationRequestId: string;
  readonly expiresAt: Date;
}

export type AcquireReservationResult =
  | { readonly outcome: "acquired"; readonly reservation: CreationReservationRecord }
  | { readonly outcome: "already_reserved"; readonly reservation: CreationReservationRecord }
  | { readonly outcome: "replay"; readonly reservation: CreationReservationRecord };

export interface CreationReservationRepository {
  acquire(input: AcquireReservationInput): Promise<AcquireReservationResult>;
  findByReservationId(reservationId: string): Promise<CreationReservationRecord | undefined>;
  findByEventId(eventId: string): Promise<CreationReservationRecord | undefined>;
  findActive(guildId: string, memberId: string): Promise<CreationReservationRecord | undefined>;
  complete(reservationId: string, channelId: string): Promise<CreationReservationRecord | undefined>;
  fail(reservationId: string, reason: string): Promise<CreationReservationRecord | undefined>;
  expireDue(now: Date): Promise<number>;
  listByStatus(status: ReservationStatus): Promise<readonly CreationReservationRecord[]>;
}
