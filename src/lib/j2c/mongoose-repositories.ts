import { CreationReservationModel, type CreationReservationRecord } from "../../models/creation-reservation.ts";
import { GuildConfigModel, type GuildConfigRecord, type UpsertGuildConfigInput } from "../../models/guild-config.ts";
import {
  OWNER_BLOCK_LIST_MAX,
  OwnerBlockListModel,
  type OwnerBlockListRecord,
} from "../../models/owner-block-list.ts";
import {
  TemporaryChannelModel,
  type TemporaryChannelRecord,
  type TemporaryChannelStatus,
} from "../../models/temporary-channel.ts";
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

function toGuildRecord(doc: {
  guildId: string;
  enabled: boolean;
  lobbyChannelId: string;
  categoryId: string;
  errorLogChannelId?: string | null;
  interfaceChannelId?: string | null;
  channelNameTemplate: string;
  defaultUserLimit?: number | null;
  ownerCanEdit?: boolean | null;
  permissionSource?: string | null;
  namingMode?: string | null;
  sequenceNext?: number | null;
  moderatorRoleIds: string[];
  createdAt: Date;
  updatedAt: Date;
}): GuildConfigRecord {
  const permissionSource =
    doc.permissionSource === "lobby" ? "lobby" : "category";
  const namingMode = doc.namingMode === "sequence" ? "sequence" : "template";
  return {
    guildId: doc.guildId,
    enabled: doc.enabled,
    lobbyChannelId: doc.lobbyChannelId,
    categoryId: doc.categoryId,
    ...(doc.errorLogChannelId && typeof doc.errorLogChannelId === "string"
      ? { errorLogChannelId: doc.errorLogChannelId }
      : {}),
    ...(doc.interfaceChannelId && typeof doc.interfaceChannelId === "string"
      ? { interfaceChannelId: doc.interfaceChannelId }
      : {}),
    channelNameTemplate: doc.channelNameTemplate,
    ...(doc.defaultUserLimit === undefined || doc.defaultUserLimit === null
      ? {}
      : { defaultUserLimit: doc.defaultUserLimit }),
    ownerCanEdit: doc.ownerCanEdit === true,
    permissionSource,
    namingMode,
    sequenceNext:
      typeof doc.sequenceNext === "number" && doc.sequenceNext >= 1 ? doc.sequenceNext : 1,
    moderatorRoleIds: [...doc.moderatorRoleIds],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toTempRecord(doc: {
  guildId: string;
  channelId: string;
  ownerId: string;
  lobbyChannelId: string;
  status: TemporaryChannelStatus;
  reservationId: string;
  creationRequestId: string;
  occupantIds: string[];
  locked?: boolean | null;
  rejectedUserIds?: string[] | null;
  appliedBlockUserIds?: string[] | null;
  ownerAbsentSince?: Date | null;
  panelMessageId?: string | null;
  panelVersion?: number | null;
  panelOwnerId?: string | null;
  cleanupCategoryId?: string | null;
  emptySince?: Date | null;
  deletionAttemptedAt?: Date | null;
  deletionRequestId?: string | null;
  lastError?: string | null;
  sequenceNumber?: number | null;
  createdAt: Date;
  updatedAt: Date;
}): TemporaryChannelRecord {
  return {
    guildId: doc.guildId,
    channelId: doc.channelId,
    ownerId: doc.ownerId,
    lobbyChannelId: doc.lobbyChannelId,
    status: doc.status,
    reservationId: doc.reservationId,
    creationRequestId: doc.creationRequestId,
    occupantIds: [...doc.occupantIds],
    locked: doc.locked === true,
    rejectedUserIds: [...(doc.rejectedUserIds ?? [])],
    appliedBlockUserIds: [...(doc.appliedBlockUserIds ?? [])],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.emptySince ? { emptySince: doc.emptySince } : {}),
    ...(doc.ownerAbsentSince ? { ownerAbsentSince: doc.ownerAbsentSince } : {}),
    ...(doc.panelMessageId ? { panelMessageId: doc.panelMessageId } : {}),
    ...(typeof doc.panelVersion === "number" ? { panelVersion: doc.panelVersion } : {}),
    ...(doc.panelOwnerId ? { panelOwnerId: doc.panelOwnerId } : {}),
    ...(doc.cleanupCategoryId ? { cleanupCategoryId: doc.cleanupCategoryId } : {}),
    ...(doc.deletionAttemptedAt ? { deletionAttemptedAt: doc.deletionAttemptedAt } : {}),
    ...(doc.deletionRequestId ? { deletionRequestId: doc.deletionRequestId } : {}),
    ...(doc.lastError ? { lastError: doc.lastError } : {}),
    ...(typeof doc.sequenceNumber === "number" && doc.sequenceNumber >= 1
      ? { sequenceNumber: doc.sequenceNumber }
      : {}),
  };
}

function toReservationRecord(doc: {
  reservationId: string;
  guildId: string;
  memberId: string;
  eventId: string;
  status: CreationReservationRecord["status"];
  channelId?: string | null;
  creationRequestId: string;
  expiresAt: Date;
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CreationReservationRecord {
  return {
    reservationId: doc.reservationId,
    guildId: doc.guildId,
    memberId: doc.memberId,
    eventId: doc.eventId,
    status: doc.status,
    creationRequestId: doc.creationRequestId,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(doc.channelId ? { channelId: doc.channelId } : {}),
    ...(doc.failureReason ? { failureReason: doc.failureReason } : {}),
  };
}

export function createMongooseGuildConfigRepository(): GuildConfigRepository {
  return {
    async findByGuildId(guildId) {
      const doc = await GuildConfigModel.findOne({ guildId }).lean().exec();
      return doc ? toGuildRecord(doc) : undefined;
    },
    async create(input) {
      const validated = validateUpsertGuildConfigInput(input);
      try {
        const doc = await GuildConfigModel.create({
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
          ...(validated.defaultUserLimit === undefined
            ? {}
            : { defaultUserLimit: validated.defaultUserLimit }),
          ownerCanEdit: validated.ownerCanEdit ?? false,
          permissionSource: validated.permissionSource ?? "category",
          namingMode: validated.namingMode ?? "template",
          sequenceNext: validated.sequenceNext ?? 1,
          moderatorRoleIds: [...(validated.moderatorRoleIds ?? [])],
        });
        return { kind: "created", record: toGuildRecord(doc.toObject()) };
      } catch (error: unknown) {
        const code = Reflect.get(error ?? {}, "code");
        if (code === 11000) {
          const existing = await GuildConfigModel.findOne({ guildId: validated.guildId }).lean().exec();
          if (existing) {
            return { kind: "exists", record: toGuildRecord(existing) };
          }
        }
        throw error;
      }
    },
    async upsert(input: UpsertGuildConfigInput) {
      const validated = validateUpsertGuildConfigInput(input);
      const setFields: Record<string, unknown> = {
        enabled: validated.enabled,
        lobbyChannelId: validated.lobbyChannelId,
        categoryId: validated.categoryId,
        channelNameTemplate: validated.channelNameTemplate,
        moderatorRoleIds: [...(validated.moderatorRoleIds ?? [])],
        ownerCanEdit: validated.ownerCanEdit ?? false,
        permissionSource: validated.permissionSource ?? "category",
        namingMode: validated.namingMode ?? "template",
        sequenceNext: validated.sequenceNext ?? 1,
      };
      if (validated.errorLogChannelId !== undefined) {
        setFields.errorLogChannelId = validated.errorLogChannelId;
      }
      if (validated.interfaceChannelId !== undefined) {
        setFields.interfaceChannelId = validated.interfaceChannelId;
      }
      const unsetFields: Record<string, 1> = {};
      if (validated.defaultUserLimit === undefined) unsetFields.defaultUserLimit = 1;
      else setFields.defaultUserLimit = validated.defaultUserLimit;
      if (validated.errorLogChannelId === undefined) unsetFields.errorLogChannelId = 1;
      if (validated.interfaceChannelId === undefined) unsetFields.interfaceChannelId = 1;
      const update = {
        $set: setFields,
        ...(Object.keys(unsetFields).length === 0 ? {} : { $unset: unsetFields }),
      };
      const doc = await GuildConfigModel.findOneAndUpdate({ guildId: validated.guildId }, update, {
        upsert: true,
        returnDocument: "after",
        setDefaultsOnInsert: true,
      })
        .lean()
        .exec();
      if (!doc) throw new Error("Failed to upsert guild config");
      return toGuildRecord(doc);
    },
    async deleteByGuildId(guildId) {
      const result = await GuildConfigModel.deleteOne({ guildId }).exec();
      return result.deletedCount > 0;
    },
  };
}

export function createMongooseTemporaryChannelRepository(): TemporaryChannelRepository {
  return {
    async create(input: CreateTemporaryChannelInput) {
      const doc = await TemporaryChannelModel.create({
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
      });
      return toTempRecord(doc.toObject());
    },

    async findByChannelId(channelId) {
      const doc = await TemporaryChannelModel.findOne({ channelId }).lean().exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async findActiveOrCreatingByOwner(guildId, ownerId) {
      const doc = await TemporaryChannelModel.findOne({
        guildId,
        ownerId,
        status: { $in: ["creating", "active"] },
      })
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async findBlockingOwnedChannel(guildId, ownerId) {
      const doc = await TemporaryChannelModel.findOne({
        guildId,
        ownerId,
        status: { $in: ["creating", "active", "deleting"] },
      })
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async listByStatus(statuses) {
      const docs = await TemporaryChannelModel.find({ status: { $in: [...statuses] } })
        .lean()
        .exec();
      return docs.map(toTempRecord);
    },

    async listActiveByGuild(guildId) {
      const docs = await TemporaryChannelModel.find({ guildId, status: "active" }).lean().exec();
      return docs.map(toTempRecord);
    },

    async listActiveOwned(guildId, ownerId) {
      const docs = await TemporaryChannelModel.find({ guildId, ownerId, status: "active" })
        .lean()
        .exec();
      return docs.map(toTempRecord);
    },

    async listByGuild(guildId) {
      const docs = await TemporaryChannelModel.find({ guildId }).lean().exec();
      return docs.map(toTempRecord);
    },

    async allocateSequenceNumber(guildId) {
      const docs = await TemporaryChannelModel.find({
        guildId,
        status: { $in: ["creating", "active", "deleting"] },
      })
        .lean()
        .exec();
      const used = new Set<number>();
      for (const doc of docs) {
        if (typeof doc.sequenceNumber === "number" && doc.sequenceNumber >= 1) {
          used.add(doc.sequenceNumber);
        }
      }
      let next = 1;
      while (used.has(next)) next += 1;
      return next;
    },

    async countByStatus(status) {
      return TemporaryChannelModel.countDocuments({ status }).exec();
    },

    async markActive(channelId, occupantIds) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId },
        { $set: { status: "active", occupantIds: [...occupantIds] }, $unset: { emptySince: 1 } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async setOccupants(channelId, occupantIds, emptySince) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId },
        emptySince
          ? { $set: { occupantIds: [...occupantIds], emptySince } }
          : { $set: { occupantIds: [...occupantIds] }, $unset: { emptySince: 1 } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async beginDeleting(channelId, deletionRequestId, attemptedAt) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId, status: "active" },
        {
          $set: {
            status: "deleting",
            deletionRequestId,
            deletionAttemptedAt: attemptedAt,
          },
        },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async markStale(channelId, lastError) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId },
        { $set: { status: "stale", lastError } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async setLocked(channelId, locked) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId, status: "active" },
        { $set: { locked } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async addRejectedUser(channelId, userId) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId, status: "active" },
        { $addToSet: { rejectedUserIds: userId } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async removeRejectedUser(channelId, userId) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId, status: "active" },
        { $pull: { rejectedUserIds: userId } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async setAppliedBlockUserIds(channelId, appliedBlockUserIds) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId, status: { $in: ["creating", "active"] } },
        { $set: { appliedBlockUserIds: [...appliedBlockUserIds] } },
        { returnDocument: "after" },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async transferOwner(channelId, newOwnerId) {
      const current = await TemporaryChannelModel.findOne({ channelId, status: "active" }).lean().exec();
      if (!current) return undefined;
      const conflict = await TemporaryChannelModel.findOne({
        guildId: current.guildId,
        ownerId: newOwnerId,
        status: { $in: ["creating", "active", "deleting"] },
        channelId: { $ne: channelId },
      })
        .lean()
        .exec();
      if (conflict) return undefined;
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId, status: "active" },
        { $set: { ownerId: newOwnerId }, $unset: { ownerAbsentSince: 1 } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async setOwnerAbsentSince(channelId, ownerAbsentSince) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId, status: "active" },
        ownerAbsentSince
          ? { $set: { ownerAbsentSince } }
          : { $unset: { ownerAbsentSince: 1 } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async setPanelMessage(channelId, panelMessageId, panelVersion, panelOwnerId) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId },
        { $set: { panelMessageId, panelVersion, panelOwnerId } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async setCleanupCategoryId(channelId, cleanupCategoryId) {
      const doc = await TemporaryChannelModel.findOneAndUpdate(
        { channelId },
        { $set: { cleanupCategoryId } },
        { returnDocument: "after" },
      )
        .lean()
        .exec();
      return doc ? toTempRecord(doc) : undefined;
    },

    async remove(channelId) {
      const result = await TemporaryChannelModel.deleteOne({ channelId }).exec();
      return result.deletedCount > 0;
    },
  };
}

export function createMongooseCreationReservationRepository(): CreationReservationRepository {
  return {
    async acquire(input: AcquireReservationInput): Promise<AcquireReservationResult> {
      const replay = await CreationReservationModel.findOne({ eventId: input.eventId }).lean().exec();
      if (replay) return { outcome: "replay", reservation: toReservationRecord(replay) };

      await CreationReservationModel.updateMany(
        {
          guildId: input.guildId,
          memberId: input.memberId,
          status: "reserved",
          expiresAt: { $lte: new Date() },
        },
        { $set: { status: "expired" } },
      ).exec();

      const existing = await CreationReservationModel.findOne({
        guildId: input.guildId,
        memberId: input.memberId,
        status: "reserved",
      })
        .lean()
        .exec();
      if (existing) {
        return { outcome: "already_reserved", reservation: toReservationRecord(existing) };
      }

      try {
        const created = await CreationReservationModel.create({
          reservationId: input.reservationId,
          guildId: input.guildId,
          memberId: input.memberId,
          eventId: input.eventId,
          status: "reserved",
          creationRequestId: input.creationRequestId,
          expiresAt: input.expiresAt,
        });
        return { outcome: "acquired", reservation: toReservationRecord(created.toObject()) };
      } catch (error) {
        const concurrent = await CreationReservationModel.findOne({
          guildId: input.guildId,
          memberId: input.memberId,
          status: "reserved",
        })
          .lean()
          .exec();
        if (concurrent) {
          return { outcome: "already_reserved", reservation: toReservationRecord(concurrent) };
        }
        throw error;
      }
    },

    async findByReservationId(reservationId) {
      const doc = await CreationReservationModel.findOne({ reservationId }).lean().exec();
      return doc ? toReservationRecord(doc) : undefined;
    },

    async findByEventId(eventId) {
      const doc = await CreationReservationModel.findOne({ eventId }).lean().exec();
      return doc ? toReservationRecord(doc) : undefined;
    },

    async findActive(guildId, memberId) {
      const doc = await CreationReservationModel.findOne({
        guildId,
        memberId,
        status: "reserved",
        expiresAt: { $gt: new Date() },
      })
        .lean()
        .exec();
      return doc ? toReservationRecord(doc) : undefined;
    },

    async complete(reservationId, channelId) {
      const doc = await CreationReservationModel.findOneAndUpdate(
        { reservationId },
        { $set: { status: "completed", channelId } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toReservationRecord(doc) : undefined;
    },

    async fail(reservationId, reason) {
      const doc = await CreationReservationModel.findOneAndUpdate(
        { reservationId },
        { $set: { status: "failed", failureReason: reason } },
        { returnDocument: 'after' },
      )
        .lean()
        .exec();
      return doc ? toReservationRecord(doc) : undefined;
    },

    async expireDue(now) {
      const result = await CreationReservationModel.updateMany(
        { status: "reserved", expiresAt: { $lte: now } },
        { $set: { status: "expired" } },
      ).exec();
      return result.modifiedCount;
    },

    async listByStatus(status) {
      const docs = await CreationReservationModel.find({ status }).lean().exec();
      return docs.map(toReservationRecord);
    },
  };
}

function toOwnerBlockListRecord(doc: {
  guildId: string;
  ownerId: string;
  blockedUserIds: string[];
  createdAt: Date;
  updatedAt: Date;
}): OwnerBlockListRecord {
  return {
    guildId: doc.guildId,
    ownerId: doc.ownerId,
    blockedUserIds: [...doc.blockedUserIds],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createMongooseOwnerBlockListRepository(): OwnerBlockListRepository {
  return {
    async getBlockedUserIds(guildId, ownerId) {
      const doc = await OwnerBlockListModel.findOne({ guildId, ownerId }).lean().exec();
      return [...(doc?.blockedUserIds ?? [])];
    },

    async findByOwner(guildId, ownerId) {
      const doc = await OwnerBlockListModel.findOne({ guildId, ownerId }).lean().exec();
      return doc ? toOwnerBlockListRecord(doc) : undefined;
    },

    async addBlockedUser(guildId, ownerId, blockedUserId) {
      const existing = await OwnerBlockListModel.findOne({ guildId, ownerId }).lean().exec();
      const current = existing?.blockedUserIds ?? [];
      if (current.includes(blockedUserId)) {
        return { outcome: "exists", blockedUserIds: [...current] };
      }
      if (current.length >= OWNER_BLOCK_LIST_MAX) {
        return { outcome: "limit", blockedUserIds: [...current] };
      }

      const doc = await OwnerBlockListModel.findOneAndUpdate(
        { guildId, ownerId },
        {
          $addToSet: { blockedUserIds: blockedUserId },
          $setOnInsert: { guildId, ownerId },
        },
        { upsert: true, returnDocument: "after" },
      )
        .lean()
        .exec();

      const blockedUserIds = [...(doc?.blockedUserIds ?? [...current, blockedUserId])];
      if (blockedUserIds.length > OWNER_BLOCK_LIST_MAX) {
        // Rare race: trim the extra id and report limit.
        await OwnerBlockListModel.updateOne(
          { guildId, ownerId },
          { $pull: { blockedUserIds: blockedUserId } },
        ).exec();
        return {
          outcome: "limit",
          blockedUserIds: blockedUserIds.filter((id) => id !== blockedUserId).slice(0, OWNER_BLOCK_LIST_MAX),
        };
      }
      return { outcome: "added", blockedUserIds };
    },

    async removeBlockedUser(guildId, ownerId, blockedUserId) {
      const existing = await OwnerBlockListModel.findOne({ guildId, ownerId }).lean().exec();
      const current = existing?.blockedUserIds ?? [];
      if (!current.includes(blockedUserId)) {
        return { outcome: "missing", blockedUserIds: [...current] };
      }

      const doc = await OwnerBlockListModel.findOneAndUpdate(
        { guildId, ownerId },
        { $pull: { blockedUserIds: blockedUserId } },
        { returnDocument: "after" },
      )
        .lean()
        .exec();

      const blockedUserIds = [...(doc?.blockedUserIds ?? [])];
      if (doc && blockedUserIds.length === 0) {
        await OwnerBlockListModel.deleteOne({ guildId, ownerId }).exec();
      }
      return { outcome: "removed", blockedUserIds };
    },
  };
}
