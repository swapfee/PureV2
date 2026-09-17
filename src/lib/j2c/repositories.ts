import type { CreationReservationRecord, ReservationStatus } from "../../models/creation-reservation.ts";
import type { GuildConfigRecord, UpsertGuildConfigInput } from "../../models/guild-config.ts";
import type { OwnerBlockListRecord } from "../../models/owner-block-list.ts";
import type { TemporaryChannelRecord, TemporaryChannelStatus } from "../../models/temporary-channel.ts";

export interface GuildConfigRepository {
  findByGuildId(guildId: string): Promise<GuildConfigRecord | undefined>;
  upsert(input: UpsertGuildConfigInput): Promise<GuildConfigRecord>;
  deleteByGuildId(guildId: string): Promise<boolean>;
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
  readonly appliedBlockUserIds?: readonly string[];
  readonly sequenceNumber?: number;
}

export interface TemporaryChannelRepository {
  create(input: CreateTemporaryChannelInput): Promise<TemporaryChannelRecord>;
  findByChannelId(channelId: string): Promise<TemporaryChannelRecord | undefined>;
  findActiveOrCreatingByOwner(guildId: string, ownerId: string): Promise<TemporaryChannelRecord | undefined>;
  /** creating | active | deleting — blocks replacement until cleanup completes */
  findBlockingOwnedChannel(guildId: string, ownerId: string): Promise<TemporaryChannelRecord | undefined>;
  listByStatus(statuses: readonly TemporaryChannelStatus[]): Promise<readonly TemporaryChannelRecord[]>;
  listActiveByGuild(guildId: string): Promise<readonly TemporaryChannelRecord[]>;
  listByGuild(guildId: string): Promise<readonly TemporaryChannelRecord[]>;
  listActiveOwned(guildId: string, ownerId: string): Promise<readonly TemporaryChannelRecord[]>;
  /**
   * Lowest free sequential number for a guild (gap-fill).
   * Considers creating / active / deleting temporary channels only.
   */
  allocateSequenceNumber(guildId: string): Promise<number>;
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
  setLocked(channelId: string, locked: boolean): Promise<TemporaryChannelRecord | undefined>;
  addRejectedUser(channelId: string, userId: string): Promise<TemporaryChannelRecord | undefined>;
  removeRejectedUser(channelId: string, userId: string): Promise<TemporaryChannelRecord | undefined>;
  setAppliedBlockUserIds(
    channelId: string,
    appliedBlockUserIds: readonly string[],
  ): Promise<TemporaryChannelRecord | undefined>;
  transferOwner(
    channelId: string,
    newOwnerId: string,
  ): Promise<TemporaryChannelRecord | undefined>;
  setOwnerAbsentSince(
    channelId: string,
    ownerAbsentSince: Date | null,
  ): Promise<TemporaryChannelRecord | undefined>;
  setPanelMessage(
    channelId: string,
    panelMessageId: string,
    panelVersion: number,
    panelOwnerId: string,
  ): Promise<TemporaryChannelRecord | undefined>;
  remove(channelId: string): Promise<boolean>;
}

export type AddBlockedUserResult =
  | { readonly outcome: "added"; readonly blockedUserIds: readonly string[] }
  | { readonly outcome: "exists"; readonly blockedUserIds: readonly string[] }
  | { readonly outcome: "limit"; readonly blockedUserIds: readonly string[] };

export type RemoveBlockedUserResult =
  | { readonly outcome: "removed"; readonly blockedUserIds: readonly string[] }
  | { readonly outcome: "missing"; readonly blockedUserIds: readonly string[] };

export interface OwnerBlockListRepository {
  getBlockedUserIds(guildId: string, ownerId: string): Promise<readonly string[]>;
  findByOwner(guildId: string, ownerId: string): Promise<OwnerBlockListRecord | undefined>;
  addBlockedUser(guildId: string, ownerId: string, blockedUserId: string): Promise<AddBlockedUserResult>;
  removeBlockedUser(
    guildId: string,
    ownerId: string,
    blockedUserId: string,
  ): Promise<RemoveBlockedUserResult>;
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
