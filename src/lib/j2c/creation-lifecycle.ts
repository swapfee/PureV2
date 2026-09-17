import type { Logger } from "../logger.ts";
import type { DiscordApiPort, VoiceStateUpdatePayload } from "../runtime-types.ts";
import { renderChannelName, renderSequentialChannelName } from "./channel-name.ts";
import { pickDisplayName } from "./display-name.ts";
import type { J2cMetrics } from "./metrics.ts";
import type {
  CreationReservationRepository,
  GuildConfigRepository,
  OwnerBlockListRepository,
  TemporaryChannelRepository,
} from "./repositories.ts";
import {
  compensateDeleteRequestId,
  creationRequestId,
  creationReservationId,
  moveRequestId,
} from "./request-ids.ts";
import type { ReservationService } from "./reservation-service.ts";
import {
  copyChannelPermissionOverwrites,
  grantOwnerChannelEditAccess,
} from "./temp-channel-permissions.ts";
import type { Clock } from "./time.ts";
import { systemClock } from "./time.ts";
import { synchronizeTemporaryChannelAccess } from "./voice-controls.ts";
import { installVoiceControlPanel } from "./voice-panel-service.ts";

export type CreationOutcome =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "duplicate_prevented"; readonly channelId?: string }
  | { readonly kind: "replay"; readonly reservationId: string }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "created"; readonly channelId: string }
  | { readonly kind: "failed"; readonly reason: string; readonly orphanChannelId?: string };

export interface CreationLifecycle {
  handleVoiceJoin(input: {
    readonly eventId: string;
    readonly guildId: string;
    readonly memberId: string;
    readonly joinedChannelId: string;
    readonly username?: string;
  }): Promise<CreationOutcome>;
}

export function createCreationLifecycle(options: {
  readonly configs: GuildConfigRepository;
  readonly channels: TemporaryChannelRepository;
  readonly reservations: CreationReservationRepository;
  readonly reservationService: ReservationService;
  readonly discord: DiscordApiPort;
  readonly metrics: J2cMetrics;
  readonly logger: Logger;
  readonly blocks?: OwnerBlockListRepository;
  readonly clock?: Clock;
}): CreationLifecycle {
  const clock = options.clock ?? systemClock();

  const refreshActiveGauge = async (): Promise<void> => {
    const count = await options.channels.countByStatus("active");
    options.metrics.setActiveTemporaryChannels(count);
  };

  const resolveChannelUsername = async (input: {
    readonly guildId: string;
    readonly memberId: string;
    readonly username?: string;
  }): Promise<string> => {
    const provided = input.username?.trim();
    if (provided && provided.length > 0) return provided.slice(0, 80);

    const member = await options.discord.getGuildMember({
      guildId: input.guildId,
      userId: input.memberId,
    });
    if (member.kind === "found") {
      const fromMember = pickDisplayName({
        nick: member.value.nick,
        globalName: member.value.globalName,
        username: member.value.username,
      });
      if (fromMember) return fromMember;
    }

    const user = await options.discord.getUser({ userId: input.memberId });
    if (user.kind === "found") {
      const fromUser = pickDisplayName({
        globalName: user.value.globalName,
        username: user.value.username,
      });
      if (fromUser) return fromUser;
    }

    return "user";
  };

  const compensate = async (input: {
    readonly channelId: string;
    readonly reservationId: string;
    readonly guildId: string;
    readonly memberId: string;
    readonly eventId: string;
    readonly reason: string;
  }): Promise<"deleted" | "orphan"> => {
    options.metrics.increment("compensatingDeletions");
    const deleteResult = await options.discord.deleteChannel({
      channelId: input.channelId,
      requestId: compensateDeleteRequestId(input.channelId, input.reservationId),
      reason: "j2c compensating deletion",
    });

    if (deleteResult.kind === "ok" || deleteResult.kind === "missing") {
      await options.channels.remove(input.channelId);
      await options.reservationService.fail(input.reservationId, input.reason);
      options.logger.warn("Compensating deletion succeeded", {
        guildId: input.guildId,
        userId: input.memberId,
        channelId: input.channelId,
        reservationId: input.reservationId,
        eventId: input.eventId,
        reason: input.reason,
      });
      return "deleted";
    }

    await options.channels.markStale(input.channelId, `compensation_failed:${input.reason}`);
    options.metrics.increment("poisonedLifecycleOperations");
    options.logger.error("Compensating deletion failed; orphan preserved", {
      guildId: input.guildId,
      userId: input.memberId,
      channelId: input.channelId,
      reservationId: input.reservationId,
      eventId: input.eventId,
      reason: input.reason,
      deleteKind: deleteResult.kind,
    });
    await options.reservationService.fail(input.reservationId, `orphan:${input.reason}`);
    return "orphan";
  };

  return {
    async handleVoiceJoin(input) {
      const config = await options.configs.findByGuildId(input.guildId);
      if (!config || !config.enabled) {
        return { kind: "ignored", reason: "feature_disabled" };
      }
      if (input.joinedChannelId !== config.lobbyChannelId) {
        return { kind: "ignored", reason: "not_lobby" };
      }

      options.metrics.increment("creationAttempts");

      const reservationId = creationReservationId(input.eventId);
      const createReqId = creationRequestId(input.eventId);
      const decision = await options.reservationService.beginCreation({
        reservationId,
        guildId: input.guildId,
        memberId: input.memberId,
        eventId: input.eventId,
        creationRequestId: createReqId,
      });

      if (decision.outcome === "owner_has_channel") {
        return { kind: "duplicate_prevented", channelId: decision.channelId };
      }
      if (decision.outcome === "duplicate_in_flight") {
        return decision.reservation.channelId
          ? { kind: "duplicate_prevented", channelId: decision.reservation.channelId }
          : { kind: "duplicate_prevented" };
      }
      if (decision.outcome === "replay") {
        return { kind: "replay", reservationId: decision.reservation.reservationId };
      }

      const voice = await options.discord.getUserVoiceChannel({
        guildId: input.guildId,
        userId: input.memberId,
      });
      if (voice.kind !== "found" || voice.value.channelId !== config.lobbyChannelId) {
        await options.reservationService.fail(reservationId, "left_lobby_before_create");
        options.metrics.increment("creationFailures");
        options.logger.info("Cancelled creation; user left lobby", {
          guildId: input.guildId,
          userId: input.memberId,
          reservationId,
          eventId: input.eventId,
          requestId: createReqId,
        });
        return { kind: "cancelled", reason: "left_lobby_before_create" };
      }

      const channelUsername = await resolveChannelUsername({
        guildId: input.guildId,
        memberId: input.memberId,
        ...(input.username === undefined ? {} : { username: input.username }),
      });
      let channelName: string;
      let sequenceNumber: number | undefined;
      if (config.namingMode === "sequence") {
        sequenceNumber = await options.channels.allocateSequenceNumber(input.guildId);
        channelName = renderSequentialChannelName(config.channelNameTemplate, sequenceNumber);
      } else {
        channelName = renderChannelName(config.channelNameTemplate, channelUsername);
      }
      const created = await options.discord.createVoiceChannel({
        guildId: input.guildId,
        name: channelName,
        parentId: config.categoryId,
        ...(config.defaultUserLimit === undefined ? {} : { userLimit: config.defaultUserLimit }),
        // Keep sequential rooms ordered under the category (lobby typically stays above).
        ...(sequenceNumber === undefined ? {} : { position: sequenceNumber }),
        requestId: createReqId,
        reason: "join-to-create",
      });

      if (created.kind !== "found") {
        await options.reservationService.fail(reservationId, `create_failed:${created.kind}`);
        options.metrics.increment("creationFailures");
        if (created.kind === "forbidden") {
          // permanent — do not retry
        }
        options.logger.error("Temporary channel creation failed", {
          guildId: input.guildId,
          userId: input.memberId,
          reservationId,
          eventId: input.eventId,
          requestId: createReqId,
          result: created.kind,
        });
        return { kind: "failed", reason: `create_failed:${created.kind}` };
      }

      const channelId = created.value.id;
      if (config.permissionSource === "lobby") {
        await copyChannelPermissionOverwrites({
          discord: options.discord,
          sourceChannelId: config.lobbyChannelId,
          targetChannelId: channelId,
          requestId: `${createReqId}:perms`,
        });
      }
      if (config.ownerCanEdit) {
        await grantOwnerChannelEditAccess({
          discord: options.discord,
          channelId,
          ownerId: input.memberId,
          requestId: createReqId,
        });
      }
      const blockedUserIds = options.blocks
        ? await options.blocks.getBlockedUserIds(input.guildId, input.memberId)
        : [];
      try {
        await options.channels.create({
          guildId: input.guildId,
          channelId,
          ownerId: input.memberId,
          lobbyChannelId: config.lobbyChannelId,
          status: "creating",
          reservationId,
          creationRequestId: createReqId,
          occupantIds: [],
          appliedBlockUserIds: blockedUserIds,
          ...(sequenceNumber === undefined ? {} : { sequenceNumber }),
        });
      } catch {
        const compensation = await compensate({
          channelId,
          reservationId,
          guildId: input.guildId,
          memberId: input.memberId,
          eventId: input.eventId,
          reason: "persist_failed",
        });
        options.metrics.increment("creationFailures");
        return {
          kind: "failed",
          reason: "persist_failed",
          ...(compensation === "orphan" ? { orphanChannelId: channelId } : {}),
        };
      }

      // Install the panel while status is still "creating" so voice-state repair
      // (active-only) cannot race and send a second copy after markActive.
      if (blockedUserIds.length > 0) {
        const record = await options.channels.findByChannelId(channelId);
        if (record) {
          const sync = await synchronizeTemporaryChannelAccess({
            discord: options.discord,
            channels: options.channels,
            record,
            blockedUserIds,
            requestId: `${createReqId}:blocks`,
            reason: "apply owner block list on create",
          });
          if (!sync.ok) {
            options.logger.warn("Failed to fully apply block list on channel create", {
              guildId: input.guildId,
              channelId,
              failedUserIds: sync.failedUserIds,
            });
          }
        }
      }
      const botUser = await options.discord.getCurrentUser();
      if (botUser.kind === "found") {
        await installVoiceControlPanel({
          discord: options.discord,
          channels: options.channels,
          logger: options.logger,
          guildId: input.guildId,
          channelId,
          ownerId: input.memberId,
          botUserId: botUser.value.id,
          botUsername: botUser.value.username,
          requestId: createReqId,
        });
      } else {
        options.logger.warn("Voice panel skipped; bot user unavailable", {
          guildId: input.guildId,
          channelId,
          outcome: botUser.kind,
        });
      }

      const moved = await options.discord.moveMemberToChannel({
        guildId: input.guildId,
        userId: input.memberId,
        channelId,
        requestId: moveRequestId(input.eventId),
        reason: "join-to-create move",
      });

      if (moved.kind !== "ok") {
        const compensation = await compensate({
          channelId,
          reservationId,
          guildId: input.guildId,
          memberId: input.memberId,
          eventId: input.eventId,
          reason: `move_failed:${moved.kind}`,
        });
        options.metrics.increment("creationFailures");
        options.logger.error("Member move failed after channel creation", {
          guildId: input.guildId,
          userId: input.memberId,
          channelId,
          reservationId,
          eventId: input.eventId,
          requestId: moveRequestId(input.eventId),
          moveKind: moved.kind,
        });
        return {
          kind: "failed",
          reason: `move_failed:${moved.kind}`,
          ...(compensation === "orphan" ? { orphanChannelId: channelId } : {}),
        };
      }

      await options.channels.markActive(channelId, [input.memberId]);
      await options.reservationService.complete(reservationId, channelId);
      options.metrics.increment("creationSuccesses");
      await refreshActiveGauge();

      options.logger.info("Temporary channel created", {
        guildId: input.guildId,
        userId: input.memberId,
        channelId,
        reservationId,
        eventId: input.eventId,
        requestId: createReqId,
        at: clock.now().toISOString(),
      });
      return { kind: "created", channelId };
    },
  };
}

export function shouldAttemptCreation(payload: VoiceStateUpdatePayload, lobbyChannelId: string): boolean {
  if (payload.isBot) return false;
  return payload.channelId === lobbyChannelId;
}
