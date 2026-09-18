import type { TemporaryChannelRecord } from "../../models/temporary-channel.ts";
import { isSnowflake } from "../../models/snowflake.ts";
import type { Logger } from "../logger.ts";
import type {
  DiscordApiPort,
  DiscordChannelDetails,
  DiscordOperationResult,
  InteractionEmbed,
} from "../runtime-types.ts";
import type { OwnerBlockListRepository, TemporaryChannelRepository } from "./repositories.ts";
import {
  isConnectDenied,
  memberAlreadyPermitted,
  permitMember,
} from "./voice-controls.ts";
import { PANEL_EMOJIS } from "./voice-panel.ts";

export const VC_JOIN_REQUEST_PREFIX = "vc-req";
export const VC_JOIN_REQUEST_TTL_MS = 60_000;
/** Delay before removing the resolved join-request message (approve/decline/expiry). */
export const VC_JOIN_REQUEST_MESSAGE_DELETE_AFTER_MS = 5_000;

const ComponentTypes = {
  ActionRow: 1,
  Button: 2,
} as const;

const ButtonStyles = {
  Secondary: 2,
} as const;

export type JoinRequestDecision = "approve" | "decline";

export interface PendingJoinRequest {
  readonly requestKey: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly requesterId: string;
  readonly messageId: string;
  readonly expiresAt: number;
}

type JoinRequestStatus = "pending" | "resolved";

interface StoredJoinRequest extends PendingJoinRequest {
  status: JoinRequestStatus;
  timer?: ReturnType<typeof setTimeout>;
}

/** In-process pending join requests (expiry edits). Decision auth is encoded in custom_id. */
const pendingByKey = new Map<string, StoredJoinRequest>();
const pendingByRequesterChannel = new Map<string, string>();
const messageDeleteTimers = new Set<ReturnType<typeof setTimeout>>();

/** Test-only override for the post-resolve message delete delay. */
let messageDeleteAfterMsForTests: number | undefined;

export function setJoinRequestMessageDeleteAfterMsForTests(ms: number | undefined): void {
  messageDeleteAfterMsForTests = ms;
}

function joinRequestMessageDeleteAfterMs(): number {
  return messageDeleteAfterMsForTests ?? VC_JOIN_REQUEST_MESSAGE_DELETE_AFTER_MS;
}

function requesterChannelKey(channelId: string, requesterId: string): string {
  return `${channelId}:${requesterId}`;
}

export function buildJoinRequestKey(interactionId: string): string {
  return interactionId;
}

export function buildJoinRequestCustomId(
  decision: JoinRequestDecision,
  channelId: string,
  requesterId: string,
  expiresAt: number,
): string {
  return `${VC_JOIN_REQUEST_PREFIX}:${decision}:${channelId}:${requesterId}:${expiresAt}`;
}

export function parseJoinRequestCustomId(customId: string):
  | {
      readonly decision: JoinRequestDecision;
      readonly channelId: string;
      readonly requesterId: string;
      readonly expiresAt: number;
    }
  | undefined {
  const parts = customId.split(":");
  if (parts.length !== 5 || parts[0] !== VC_JOIN_REQUEST_PREFIX) return undefined;
  const decision = parts[1];
  if (decision !== "approve" && decision !== "decline") return undefined;
  const channelId = parts[2];
  const requesterId = parts[3];
  const expiresAtRaw = parts[4];
  if (!channelId || !requesterId || !expiresAtRaw) return undefined;
  if (!isSnowflake(channelId) || !isSnowflake(requesterId)) return undefined;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return undefined;
  return { decision, channelId, requesterId, expiresAt };
}

function discordRelativeTimestamp(expiresAtMs: number): string {
  return `<t:${Math.floor(expiresAtMs / 1000)}:R>`;
}

export function formatJoinRequestEmbed(options: {
  readonly requesterId: string;
  readonly ownerId: string;
  readonly expiresAt: number;
}): InteractionEmbed {
  return {
    title: "Join request",
    description: [
      `<@${options.requesterId}> is requesting access to this locked voice channel.`,
      `Owner: <@${options.ownerId}>`,
      `Expires ${discordRelativeTimestamp(options.expiresAt)}.`,
    ].join("\n"),
  };
}

export function formatJoinRequestResolvedEmbed(options: {
  readonly requesterId: string;
  readonly ownerId: string;
  readonly outcome: "approved" | "declined" | "expired" | "cancelled";
}): InteractionEmbed {
  if (options.outcome === "approved") {
    return {
      title: "Join request approved",
      description: `<@${options.ownerId}> approved access for <@${options.requesterId}>.`,
    };
  }
  if (options.outcome === "declined") {
    return {
      title: "Join request declined",
      description: `<@${options.ownerId}> declined access for <@${options.requesterId}>.`,
    };
  }
  if (options.outcome === "cancelled") {
    return {
      title: "Join request cancelled",
      description: `The voice channel was deleted before a decision was made for <@${options.requesterId}>.`,
    };
  }
  return {
    title: "Join request expired",
    description: `No decision was made for <@${options.requesterId}> within 60 seconds.`,
  };
}

/** @deprecated Prefer formatJoinRequestEmbed — kept for string assertions in older call sites. */
export function formatJoinRequestResolvedMessage(options: {
  readonly requesterId: string;
  readonly ownerId: string;
  readonly outcome: "approved" | "declined" | "expired" | "cancelled";
}): string {
  const embed = formatJoinRequestResolvedEmbed(options);
  return `**${embed.title}**\n${embed.description}`;
}

export function buildJoinRequestComponents(options: {
  readonly channelId: string;
  readonly requesterId: string;
  readonly expiresAt: number;
  readonly disabled?: boolean;
}): readonly unknown[] {
  const disabled = options.disabled === true;
  return [
    {
      type: ComponentTypes.ActionRow,
      components: [
        {
          type: ComponentTypes.Button,
          style: ButtonStyles.Secondary,
          label: "Approve",
          custom_id: buildJoinRequestCustomId(
            "approve",
            options.channelId,
            options.requesterId,
            options.expiresAt,
          ),
          emoji: { id: PANEL_EMOJIS.confirm.id, name: PANEL_EMOJIS.confirm.name },
          ...(disabled ? { disabled: true } : {}),
        },
        {
          type: ComponentTypes.Button,
          style: ButtonStyles.Secondary,
          label: "Decline",
          custom_id: buildJoinRequestCustomId(
            "decline",
            options.channelId,
            options.requesterId,
            options.expiresAt,
          ),
          emoji: { id: PANEL_EMOJIS.cancel.id, name: PANEL_EMOJIS.cancel.name },
          ...(disabled ? { disabled: true } : {}),
        },
      ],
    },
  ];
}

export function hasPendingJoinRequest(channelId: string, requesterId: string): boolean {
  const key = pendingByRequesterChannel.get(requesterChannelKey(channelId, requesterId));
  if (!key) return false;
  const pending = pendingByKey.get(key);
  return pending !== undefined && pending.status === "pending" && pending.expiresAt > Date.now();
}

function clearPending(requestKey: string): void {
  const pending = pendingByKey.get(requestKey);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingByKey.delete(requestKey);
  const indexKey = requesterChannelKey(pending.channelId, pending.requesterId);
  if (pendingByRequesterChannel.get(indexKey) === requestKey) {
    pendingByRequesterChannel.delete(indexKey);
  }
}

export function registerPendingJoinRequest(
  request: PendingJoinRequest,
  onExpire: (pending: PendingJoinRequest) => Promise<void>,
): void {
  clearPending(request.requestKey);
  const existingKey = pendingByRequesterChannel.get(
    requesterChannelKey(request.channelId, request.requesterId),
  );
  if (existingKey) clearPending(existingKey);

  const delay = Math.max(0, request.expiresAt - Date.now());
  const stored: StoredJoinRequest = {
    ...request,
    status: "pending",
  };
  stored.timer = setTimeout(() => {
    void (async () => {
      const current = pendingByKey.get(request.requestKey);
      if (!current || current.status !== "pending") return;
      current.status = "resolved";
      clearPending(request.requestKey);
      try {
        await onExpire(request);
      } catch {
        // Expiry edit failures are non-fatal; buttons still validate expiresAt on click.
      }
    })();
  }, delay);
  // Ensure timer does not keep the process alive in tests / idle workers.
  stored.timer.unref?.();

  pendingByKey.set(request.requestKey, stored);
  pendingByRequesterChannel.set(
    requesterChannelKey(request.channelId, request.requesterId),
    request.requestKey,
  );
}

export function consumePendingJoinRequest(options: {
  readonly channelId: string;
  readonly requesterId: string;
}): PendingJoinRequest | undefined {
  const key = pendingByRequesterChannel.get(
    requesterChannelKey(options.channelId, options.requesterId),
  );
  if (!key) return undefined;
  const pending = pendingByKey.get(key);
  if (!pending || pending.status !== "pending") return undefined;
  pending.status = "resolved";
  const snapshot: PendingJoinRequest = {
    requestKey: pending.requestKey,
    guildId: pending.guildId,
    channelId: pending.channelId,
    ownerId: pending.ownerId,
    requesterId: pending.requesterId,
    messageId: pending.messageId,
    expiresAt: pending.expiresAt,
  };
  clearPending(key);
  return snapshot;
}

/** Take every pending join request for a channel (clears timers/store). */
export function consumePendingJoinRequestsForChannel(
  channelId: string,
): readonly PendingJoinRequest[] {
  const toConsume: StoredJoinRequest[] = [];
  for (const pending of pendingByKey.values()) {
    if (pending.channelId === channelId && pending.status === "pending") {
      toConsume.push(pending);
    }
  }

  const snapshots: PendingJoinRequest[] = [];
  for (const pending of toConsume) {
    pending.status = "resolved";
    snapshots.push({
      requestKey: pending.requestKey,
      guildId: pending.guildId,
      channelId: pending.channelId,
      ownerId: pending.ownerId,
      requesterId: pending.requesterId,
      messageId: pending.messageId,
      expiresAt: pending.expiresAt,
    });
    clearPending(pending.requestKey);
  }
  return snapshots;
}

/**
 * Cancel all pending join requests for a temporary channel that is being deleted.
 * Clears the in-memory store/timers and best-effort edits request messages to a
 * cancelled state with disabled buttons. Missing channel/message edits are OK.
 */
export async function cancelPendingJoinRequestsForChannel(options: {
  readonly discord: DiscordApiPort;
  readonly channelId: string;
  readonly requestId: string;
}): Promise<void> {
  const pending = consumePendingJoinRequestsForChannel(options.channelId);
  for (const request of pending) {
    try {
      const result = await finalizeJoinRequestMessage({
        discord: options.discord,
        channelId: request.channelId,
        messageId: request.messageId,
        requesterId: request.requesterId,
        ownerId: request.ownerId,
        expiresAt: request.expiresAt,
        outcome: "cancelled",
        requestId: `${options.requestId}:join-req:${request.requestKey}`,
      });
      // Channel or message may already be gone after deletion — treat as success.
      if (result.kind === "ok" || result.kind === "missing") continue;
    } catch {
      // Non-fatal: pending state is already cleared.
    }
  }
}

/** Test helper: drop all pending join requests and timers. */
export function resetJoinRequestStoreForTests(): void {
  for (const pending of pendingByKey.values()) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingByKey.clear();
  pendingByRequesterChannel.clear();
  for (const timer of messageDeleteTimers) {
    clearTimeout(timer);
  }
  messageDeleteTimers.clear();
  messageDeleteAfterMsForTests = undefined;
}

function scheduleJoinRequestMessageDeletion(options: {
  readonly discord: DiscordApiPort;
  readonly channelId: string;
  readonly messageId: string;
  readonly requestId: string;
}): void {
  const timer = setTimeout(() => {
    messageDeleteTimers.delete(timer);
    void options.discord
      .deleteChannelMessage({
        channelId: options.channelId,
        messageId: options.messageId,
        requestId: options.requestId,
      })
      .catch(() => {
        // Missing/forbidden after resolve is non-fatal.
      });
  }, joinRequestMessageDeleteAfterMs());
  timer.unref?.();
  messageDeleteTimers.add(timer);
}

export async function resolveManagedChannelTarget(options: {
  readonly guildId: string;
  readonly target: string;
  readonly channels: TemporaryChannelRepository;
}): Promise<TemporaryChannelRecord | undefined> {
  if (!isSnowflake(options.target)) return undefined;

  const byChannel = await options.channels.findByChannelId(options.target);
  if (
    byChannel &&
    byChannel.status === "active" &&
    byChannel.guildId === options.guildId
  ) {
    return byChannel;
  }

  const owned = await options.channels.listActiveOwned(options.guildId, options.target);
  // An owner ID is convenient only while it identifies exactly one room. Once
  // an owner has multiple rooms, callers must use the unambiguous channel ID.
  if (owned.length === 1) return owned[0];
  return undefined;
}

export function channelIsLockedForJoinRequests(
  record: Pick<TemporaryChannelRecord, "locked" | "guildId">,
  channel: DiscordChannelDetails,
): boolean {
  return record.locked || isConnectDenied(channel.permissionOverwrites, record.guildId);
}

export async function approveJoinRequest(options: {
  readonly discord: DiscordApiPort;
  readonly channels: TemporaryChannelRepository;
  readonly blocks?: OwnerBlockListRepository;
  readonly logger: Logger;
  readonly record: TemporaryChannelRecord;
  readonly channel: DiscordChannelDetails;
  readonly requesterId: string;
  readonly requestId: string;
}): Promise<DiscordOperationResult | { readonly kind: "blocked" } | { readonly kind: "already_permitted" }> {
  if (options.blocks) {
    const blocked = await options.blocks.getBlockedUserIds(
      options.record.guildId,
      options.record.ownerId,
    );
    if (blocked.includes(options.requesterId)) {
      return { kind: "blocked" };
    }
  }
  if (
    memberAlreadyPermitted(
      options.channel.permissionOverwrites,
      options.requesterId,
      options.record.rejectedUserIds,
    )
  ) {
    return { kind: "already_permitted" };
  }
  return permitMember({
    discord: options.discord,
    channels: options.channels,
    channel: options.channel,
    record: options.record,
    userId: options.requesterId,
    requestId: options.requestId,
    reason: "vc request approved",
  });
}

export async function finalizeJoinRequestMessage(options: {
  readonly discord: DiscordApiPort;
  readonly channelId: string;
  readonly messageId: string;
  readonly requesterId: string;
  readonly ownerId: string;
  readonly expiresAt: number;
  readonly outcome: "approved" | "declined" | "expired" | "cancelled";
  readonly requestId: string;
}): Promise<DiscordOperationResult> {
  const result = await options.discord.editChannelMessage({
    channelId: options.channelId,
    messageId: options.messageId,
    requestId: options.requestId,
    content: "",
    embeds: [
      formatJoinRequestResolvedEmbed({
        requesterId: options.requesterId,
        ownerId: options.ownerId,
        outcome: options.outcome,
      }),
    ],
    components: [
      ...buildJoinRequestComponents({
        channelId: options.channelId,
        requesterId: options.requesterId,
        expiresAt: options.expiresAt,
        disabled: true,
      }),
    ],
  });

  // Channel-delete cancellation should not schedule a follow-up delete.
  if (options.outcome !== "cancelled" && result.kind === "ok") {
    scheduleJoinRequestMessageDeletion({
      discord: options.discord,
      channelId: options.channelId,
      messageId: options.messageId,
      requestId: `${options.requestId}:delete`,
    });
  }

  return result;
}
