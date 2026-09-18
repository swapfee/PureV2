import type { CreationReservationRecord } from "../../models/creation-reservation.ts";
import type { GuildConfigRecord, UpsertGuildConfigInput } from "../../models/guild-config.ts";
import {
  OWNER_BLOCK_LIST_MAX,
  type OwnerBlockListRecord,
} from "../../models/owner-block-list.ts";
import type { TemporaryChannelRecord, TemporaryChannelStatus } from "../../models/temporary-channel.ts";
import { validateUpsertGuildConfigInput } from "./validation.ts";
import type {
  AcquireReservationInput,
  AcquireReservationResult,
  CreateTemporaryChannelInput,
  CreationReservationRepository,
  GuildConfigRepository,
  OwnerBlockListRepository,
  TemporaryChannelRepository,
} from "./repositories.ts";

function cloneGuild(record: GuildConfigRecord): GuildConfigRecord {
  return {
    ...record,
    ...(record.errorLogChannelId === undefined
      ? {}
      : { errorLogChannelId: record.errorLogChannelId }),
    ...(record.interfaceChannelId === undefined
      ? {}
      : { interfaceChannelId: record.interfaceChannelId }),
    moderatorRoleIds: [...record.moderatorRoleIds],
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function cloneTemp(record: TemporaryChannelRecord): TemporaryChannelRecord {
  return {
    ...record,
    occupantIds: [...record.occupantIds],
    rejectedUserIds: [...record.rejectedUserIds],
    appliedBlockUserIds: [...(record.appliedBlockUserIds ?? [])],
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    ...(record.emptySince ? { emptySince: new Date(record.emptySince) } : {}),
    ...(record.deletionAttemptedAt ? { deletionAttemptedAt: new Date(record.deletionAttemptedAt) } : {}),
    ...(record.ownerAbsentSince ? { ownerAbsentSince: new Date(record.ownerAbsentSince) } : {}),
  };
}

function cloneReservation(record: CreationReservationRecord): CreationReservationRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    expiresAt: new Date(record.expiresAt),
  };
}

function buildGuildConfigRecord(
  validated: ReturnType<typeof validateUpsertGuildConfigInput>,
  existing: GuildConfigRecord | undefined,
  now: Date,
): GuildConfigRecord {
  return {
    guildId: validated.guildId,
    enabled: validated.enabled,
    lobbyChannelId: validated.lobbyChannelId,
    categoryId: validated.categoryId,
    ...(validated.errorLogChannelId === undefined
      ? {}
      : { errorLogChannelId: validated.errorLogChannelId }),
    ...(validated.interfaceChannelId === undefined
      ? {}
      : { interfaceChannelId: validated.interfaceChannelId }),
    channelNameTemplate: validated.channelNameTemplate,
    ...(validated.defaultUserLimit === undefined ? {} : { defaultUserLimit: validated.defaultUserLimit }),
    ownerCanEdit: validated.ownerCanEdit ?? false,
    permissionSource: validated.permissionSource ?? "category",
    namingMode: validated.namingMode ?? "template",
    sequenceNext: validated.sequenceNext ?? 1,
    channelHoist: validated.channelHoist ?? "bottom",
    moderatorRoleIds: [...(validated.moderatorRoleIds ?? [])],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function createMemoryGuildConfigRepository(): GuildConfigRepository {
  const byGuild = new Map<string, GuildConfigRecord>();

  return {
    async findByGuildId(guildId) {
      const found = byGuild.get(guildId);
      return found ? cloneGuild(found) : undefined;
    },
    async create(input: UpsertGuildConfigInput) {
      const validated = validateUpsertGuildConfigInput(input);
      const existing = byGuild.get(validated.guildId);
      if (existing) {
        return { kind: "exists", record: cloneGuild(existing) };
      }
      const record = buildGuildConfigRecord(validated, undefined, new Date());
      byGuild.set(record.guildId, record);
      return { kind: "created", record: cloneGuild(record) };
    },
    async upsert(input: UpsertGuildConfigInput) {
      const validated = validateUpsertGuildConfigInput(input);
      const now = new Date();
      const existing = byGuild.get(validated.guildId);
      const record = buildGuildConfigRecord(validated, existing, now);
      byGuild.set(record.guildId, record);
      return cloneGuild(record);
    },
    async deleteByGuildId(guildId) {
      return byGuild.delete(guildId);
    },
  };
}

function ownerKey(guildId: string, ownerId: string): string {
  return `${guildId}:${ownerId}`;
}

export function createMemoryTemporaryChannelRepository(): TemporaryChannelRepository {
  const byChannel = new Map<string, TemporaryChannelRecord>();

  const assertSequenceUniqueness = (input: CreateTemporaryChannelInput): void => {
    if (input.sequenceNumber === undefined) return;
    if (input.status !== "creating" && input.status !== "active" && input.status !== "deleting") return;
    for (const record of byChannel.values()) {
      if (
        record.guildId === input.guildId &&
        record.sequenceNumber === input.sequenceNumber &&
        (record.status === "creating" || record.status === "active" || record.status === "deleting") &&
        record.channelId !== input.channelId
      ) {
        throw new Error(
          `Sequence ${input.sequenceNumber} already used in guild ${input.guildId}`,
        );
      }
    }
  };

  return {
    async create(input) {
      assertSequenceUniqueness(input);
      if (byChannel.has(input.channelId)) throw new Error(`Channel ${input.channelId} already exists`);
      const now = new Date();
      const record: TemporaryChannelRecord = {
        guildId: input.guildId,
        channelId: input.channelId,
        ownerId: input.ownerId,
        lobbyChannelId: input.lobbyChannelId,
        status: input.status,
        reservationId: input.reservationId,
        creationRequestId: input.creationRequestId,
        occupantIds: [...(input.occupantIds ?? [])],
        locked: false,
        rejectedUserIds: [],
        appliedBlockUserIds: [...(input.appliedBlockUserIds ?? [])],
        ...(input.sequenceNumber === undefined ? {} : { sequenceNumber: input.sequenceNumber }),
        createdAt: now,
        updatedAt: now,
      };
      byChannel.set(record.channelId, record);
      return cloneTemp(record);
    },

    async findByChannelId(channelId) {
      const found = byChannel.get(channelId);
      return found ? cloneTemp(found) : undefined;
    },

    async findActiveOrCreatingByOwner(guildId, ownerId) {
      for (const record of byChannel.values()) {
        if (
          record.guildId === guildId &&
          record.ownerId === ownerId &&
          (record.status === "creating" || record.status === "active")
        ) {
          return cloneTemp(record);
        }
      }
      return undefined;
    },

    async findBlockingOwnedChannel(guildId, ownerId) {
      for (const record of byChannel.values()) {
        if (
          record.guildId === guildId &&
          record.ownerId === ownerId &&
          (record.status === "creating" ||
            record.status === "deleting" ||
            (record.status === "active" && record.occupantIds.length === 0))
        ) {
          return cloneTemp(record);
        }
      }
      return undefined;
    },

    async listByStatus(statuses) {
      const set = new Set(statuses);
      return [...byChannel.values()].filter((record) => set.has(record.status)).map(cloneTemp);
    },

    async listActiveByGuild(guildId) {
      return [...byChannel.values()]
        .filter((record) => record.guildId === guildId && record.status === "active")
        .map(cloneTemp);
    },

    async listActiveOwned(guildId, ownerId) {
      return [...byChannel.values()]
        .filter(
          (record) =>
            record.guildId === guildId &&
            record.ownerId === ownerId &&
            record.status === "active",
        )
        .map(cloneTemp);
    },

    async listByGuild(guildId) {
      return [...byChannel.values()].filter((record) => record.guildId === guildId).map(cloneTemp);
    },

    async allocateSequenceNumber(guildId) {
      const used = new Set<number>();
      for (const record of byChannel.values()) {
        if (record.guildId !== guildId) continue;
        if (record.status !== "creating" && record.status !== "active" && record.status !== "deleting") {
          continue;
        }
        if (typeof record.sequenceNumber === "number" && record.sequenceNumber >= 1) {
          used.add(record.sequenceNumber);
        }
      }
      let next = 1;
      while (used.has(next)) next += 1;
      return next;
    },

    async countByStatus(status) {
      let count = 0;
      for (const record of byChannel.values()) {
        if (record.status === status) count += 1;
      }
      return count;
    },

    async markActive(channelId, occupantIds) {
      const existing = byChannel.get(channelId);
      if (!existing) return undefined;
      const next: TemporaryChannelRecord = {
        ...existing,
        status: "active",
        occupantIds: [...occupantIds],
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async setOccupants(channelId, occupantIds, emptySince) {
      const existing = byChannel.get(channelId);
      if (!existing) return undefined;
      const next: TemporaryChannelRecord = {
        guildId: existing.guildId,
        channelId: existing.channelId,
        ownerId: existing.ownerId,
        lobbyChannelId: existing.lobbyChannelId,
        status: existing.status,
        reservationId: existing.reservationId,
        creationRequestId: existing.creationRequestId,
        occupantIds: [...occupantIds],
        locked: existing.locked,
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        createdAt: existing.createdAt,
        updatedAt: new Date(),
        ...(existing.deletionAttemptedAt ? { deletionAttemptedAt: existing.deletionAttemptedAt } : {}),
        ...(existing.deletionRequestId ? { deletionRequestId: existing.deletionRequestId } : {}),
        ...(existing.lastError ? { lastError: existing.lastError } : {}),
        ...(existing.ownerAbsentSince ? { ownerAbsentSince: existing.ownerAbsentSince } : {}),
        ...(existing.panelMessageId ? { panelMessageId: existing.panelMessageId } : {}),
        ...(existing.panelVersion !== undefined ? { panelVersion: existing.panelVersion } : {}),
        ...(existing.panelOwnerId ? { panelOwnerId: existing.panelOwnerId } : {}),
        ...(existing.cleanupCategoryId ? { cleanupCategoryId: existing.cleanupCategoryId } : {}),
        ...(emptySince ? { emptySince } : {}),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async beginDeleting(channelId, deletionRequestId, attemptedAt) {
      const existing = byChannel.get(channelId);
      if (!existing || existing.status !== "active") return undefined;
      const next: TemporaryChannelRecord = {
        ...existing,
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        occupantIds: [...existing.occupantIds],
        status: "deleting",
        deletionRequestId,
        deletionAttemptedAt: attemptedAt,
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async markStale(channelId, lastError) {
      const existing = byChannel.get(channelId);
      if (!existing) return undefined;
      const next: TemporaryChannelRecord = {
        ...existing,
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        occupantIds: [...existing.occupantIds],
        status: "stale",
        lastError,
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async setLocked(channelId, locked) {
      const existing = byChannel.get(channelId);
      if (!existing || existing.status !== "active") return undefined;
      const next: TemporaryChannelRecord = {
        ...existing,
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        occupantIds: [...existing.occupantIds],
        locked,
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async addRejectedUser(channelId, userId) {
      const existing = byChannel.get(channelId);
      if (!existing || existing.status !== "active") return undefined;
      if (existing.rejectedUserIds.includes(userId)) return cloneTemp(existing);
      const next: TemporaryChannelRecord = {
        ...existing,
        occupantIds: [...existing.occupantIds],
        rejectedUserIds: [...existing.rejectedUserIds, userId],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async removeRejectedUser(channelId, userId) {
      const existing = byChannel.get(channelId);
      if (!existing || existing.status !== "active") return undefined;
      if (!existing.rejectedUserIds.includes(userId)) return cloneTemp(existing);
      const next: TemporaryChannelRecord = {
        ...existing,
        occupantIds: [...existing.occupantIds],
        rejectedUserIds: existing.rejectedUserIds.filter((id) => id !== userId),
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async setAppliedBlockUserIds(channelId, appliedBlockUserIds) {
      const existing = byChannel.get(channelId);
      if (!existing || (existing.status !== "active" && existing.status !== "creating")) {
        return undefined;
      }
      const next: TemporaryChannelRecord = {
        ...existing,
        occupantIds: [...existing.occupantIds],
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...appliedBlockUserIds],
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async transferOwner(channelId, newOwnerId) {
      const existing = byChannel.get(channelId);
      if (!existing || existing.status !== "active") return undefined;
      const next: TemporaryChannelRecord = {
        ...existing,
        occupantIds: [...existing.occupantIds],
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        ownerId: newOwnerId,
        updatedAt: new Date(),
      };
      // Clear absence on transfer; preserve panel fields via spread.
      const { ownerAbsentSince: _absent, ...rest } = next;
      void _absent;
      const cleared: TemporaryChannelRecord = { ...rest, updatedAt: new Date() };
      byChannel.set(channelId, cleared);
      return cloneTemp(cleared);
    },

    async setOwnerAbsentSince(channelId, ownerAbsentSince) {
      const existing = byChannel.get(channelId);
      if (!existing || existing.status !== "active") return undefined;
      const next: TemporaryChannelRecord = {
        guildId: existing.guildId,
        channelId: existing.channelId,
        ownerId: existing.ownerId,
        lobbyChannelId: existing.lobbyChannelId,
        status: existing.status,
        reservationId: existing.reservationId,
        creationRequestId: existing.creationRequestId,
        occupantIds: [...existing.occupantIds],
        locked: existing.locked,
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        createdAt: existing.createdAt,
        updatedAt: new Date(),
        ...(existing.deletionAttemptedAt ? { deletionAttemptedAt: existing.deletionAttemptedAt } : {}),
        ...(existing.deletionRequestId ? { deletionRequestId: existing.deletionRequestId } : {}),
        ...(existing.lastError ? { lastError: existing.lastError } : {}),
        ...(existing.emptySince ? { emptySince: existing.emptySince } : {}),
        ...(existing.panelMessageId ? { panelMessageId: existing.panelMessageId } : {}),
        ...(existing.panelVersion !== undefined ? { panelVersion: existing.panelVersion } : {}),
        ...(existing.panelOwnerId ? { panelOwnerId: existing.panelOwnerId } : {}),
        ...(existing.cleanupCategoryId ? { cleanupCategoryId: existing.cleanupCategoryId } : {}),
        ...(ownerAbsentSince ? { ownerAbsentSince } : {}),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async setPanelMessage(channelId, panelMessageId, panelVersion, panelOwnerId) {
      const existing = byChannel.get(channelId);
      if (!existing) return undefined;
      const next: TemporaryChannelRecord = {
        ...existing,
        occupantIds: [...existing.occupantIds],
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        panelMessageId,
        panelVersion,
        panelOwnerId,
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async setCleanupCategoryId(channelId, cleanupCategoryId) {
      const existing = byChannel.get(channelId);
      if (!existing) return undefined;
      const next: TemporaryChannelRecord = {
        ...existing,
        occupantIds: [...existing.occupantIds],
        rejectedUserIds: [...existing.rejectedUserIds],
        appliedBlockUserIds: [...existing.appliedBlockUserIds],
        cleanupCategoryId,
        updatedAt: new Date(),
      };
      byChannel.set(channelId, next);
      return cloneTemp(next);
    },

    async remove(channelId) {
      return byChannel.delete(channelId);
    },
  };
}

export function createMemoryCreationReservationRepository(now: () => Date = () => new Date()): CreationReservationRepository {
  const byId = new Map<string, CreationReservationRecord>();

  return {
    async acquire(input: AcquireReservationInput): Promise<AcquireReservationResult> {
      const replay = [...byId.values()].find((record) => record.eventId === input.eventId);
      if (replay) return { outcome: "replay", reservation: cloneReservation(replay) };

      for (const record of byId.values()) {
        if (
          record.guildId === input.guildId &&
          record.memberId === input.memberId &&
          record.status === "reserved"
        ) {
          if (record.expiresAt.getTime() <= now().getTime()) {
            byId.set(record.reservationId, {
              ...record,
              status: "expired",
              updatedAt: now(),
            });
            continue;
          }
          return { outcome: "already_reserved", reservation: cloneReservation(record) };
        }
      }

      const created: CreationReservationRecord = {
        reservationId: input.reservationId,
        guildId: input.guildId,
        memberId: input.memberId,
        eventId: input.eventId,
        status: "reserved",
        creationRequestId: input.creationRequestId,
        expiresAt: new Date(input.expiresAt),
        createdAt: now(),
        updatedAt: now(),
      };
      byId.set(created.reservationId, created);
      return { outcome: "acquired", reservation: cloneReservation(created) };
    },

    async findByReservationId(reservationId) {
      const found = byId.get(reservationId);
      return found ? cloneReservation(found) : undefined;
    },

    async findByEventId(eventId) {
      for (const record of byId.values()) {
        if (record.eventId === eventId) return cloneReservation(record);
      }
      return undefined;
    },

    async findActive(guildId, memberId) {
      for (const record of byId.values()) {
        if (record.guildId === guildId && record.memberId === memberId && record.status === "reserved") {
          if (record.expiresAt.getTime() <= now().getTime()) {
            byId.set(record.reservationId, { ...record, status: "expired", updatedAt: now() });
            return undefined;
          }
          return cloneReservation(record);
        }
      }
      return undefined;
    },

    async complete(reservationId, channelId) {
      const existing = byId.get(reservationId);
      if (!existing) return undefined;
      const next: CreationReservationRecord = {
        ...existing,
        status: "completed",
        channelId,
        updatedAt: now(),
      };
      byId.set(reservationId, next);
      return cloneReservation(next);
    },

    async fail(reservationId, reason) {
      const existing = byId.get(reservationId);
      if (!existing) return undefined;
      const next: CreationReservationRecord = {
        ...existing,
        status: "failed",
        failureReason: reason,
        updatedAt: now(),
      };
      byId.set(reservationId, next);
      return cloneReservation(next);
    },

    async expireDue(at) {
      let count = 0;
      for (const [id, record] of byId) {
        if (record.status === "reserved" && record.expiresAt.getTime() <= at.getTime()) {
          byId.set(id, { ...record, status: "expired", updatedAt: at });
          count += 1;
        }
      }
      return count;
    },

    async listByStatus(status) {
      return [...byId.values()].filter((record) => record.status === status).map(cloneReservation);
    },
  };
}

export function createMemoryOwnerBlockListRepository(): OwnerBlockListRepository {
  const byOwner = new Map<string, OwnerBlockListRecord>();

  return {
    async getBlockedUserIds(guildId, ownerId) {
      return [...(byOwner.get(ownerKey(guildId, ownerId))?.blockedUserIds ?? [])];
    },

    async findByOwner(guildId, ownerId) {
      const found = byOwner.get(ownerKey(guildId, ownerId));
      if (!found) return undefined;
      return {
        ...found,
        blockedUserIds: [...found.blockedUserIds],
        createdAt: new Date(found.createdAt),
        updatedAt: new Date(found.updatedAt),
      };
    },

    async addBlockedUser(guildId, ownerId, blockedUserId) {
      const existing = byOwner.get(ownerKey(guildId, ownerId));
      const current = existing?.blockedUserIds ?? [];
      if (current.includes(blockedUserId)) {
        return { outcome: "exists", blockedUserIds: [...current] };
      }
      if (current.length >= OWNER_BLOCK_LIST_MAX) {
        return { outcome: "limit", blockedUserIds: [...current] };
      }
      const now = new Date();
      const blockedUserIds = [...current, blockedUserId];
      byOwner.set(ownerKey(guildId, ownerId), {
        guildId,
        ownerId,
        blockedUserIds,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return { outcome: "added", blockedUserIds: [...blockedUserIds] };
    },

    async removeBlockedUser(guildId, ownerId, blockedUserId) {
      const existing = byOwner.get(ownerKey(guildId, ownerId));
      const current = existing?.blockedUserIds ?? [];
      if (!current.includes(blockedUserId)) {
        return { outcome: "missing", blockedUserIds: [...current] };
      }
      const blockedUserIds = current.filter((id) => id !== blockedUserId);
      if (blockedUserIds.length === 0) {
        byOwner.delete(ownerKey(guildId, ownerId));
      } else if (existing) {
        byOwner.set(ownerKey(guildId, ownerId), {
          ...existing,
          blockedUserIds,
          updatedAt: new Date(),
        });
      }
      return { outcome: "removed", blockedUserIds: [...blockedUserIds] };
    },
  };
}

export type { TemporaryChannelStatus };
