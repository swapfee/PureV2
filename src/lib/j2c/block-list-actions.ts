import { OWNER_BLOCK_LIST_MAX } from "../../models/owner-block-list.ts";
import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { OwnerBlockListRepository, TemporaryChannelRepository } from "./repositories.ts";
import { synchronizeOwnedChannelBlockLists } from "./voice-controls.ts";

const ownerLocks = new Map<string, Promise<void>>();

async function withOwnerLock<T>(guildId: string, ownerId: string, run: () => Promise<T>): Promise<T> {
  const key = `${guildId}:${ownerId}`;
  const previous = ownerLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate);
  ownerLocks.set(key, chain);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (ownerLocks.get(key) === chain) ownerLocks.delete(key);
  }
}

export type BlockUserOutcome =
  | { readonly kind: "ok"; readonly partialSync: boolean; readonly failedChannelIds: readonly string[] }
  | { readonly kind: "cannot_block_self" }
  | { readonly kind: "cannot_block_bot" }
  | { readonly kind: "already_blocked" }
  | { readonly kind: "limit_reached" }
  | { readonly kind: "target_missing" };

export type UnblockUserOutcome =
  | { readonly kind: "ok"; readonly partialSync: boolean; readonly failedChannelIds: readonly string[] }
  | { readonly kind: "not_blocked" };

export async function blockUser(options: {
  readonly blocks: OwnerBlockListRepository;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly guildId: string;
  readonly ownerId: string;
  readonly targetUserId: string;
  readonly requestId: string;
}): Promise<BlockUserOutcome> {
  if (options.targetUserId === options.ownerId) return { kind: "cannot_block_self" };

  const target = await options.discord.getUser({ userId: options.targetUserId });
  if (target.kind !== "found") return { kind: "target_missing" };
  if (target.value.bot) return { kind: "cannot_block_bot" };

  return withOwnerLock(options.guildId, options.ownerId, async () => {
    const added = await options.blocks.addBlockedUser(
      options.guildId,
      options.ownerId,
      options.targetUserId,
    );
    if (added.outcome === "exists") return { kind: "already_blocked" };
    if (added.outcome === "limit") return { kind: "limit_reached" };

    const sync = await synchronizeOwnedChannelBlockLists({
      discord: options.discord,
      channels: options.channels,
      guildId: options.guildId,
      ownerId: options.ownerId,
      blockedUserIds: added.blockedUserIds,
      requestId: options.requestId,
      reason: "owner block list",
    });

    if (sync.failedChannelIds.length > 0) {
      options.logger.warn("Block list saved but some channels failed to sync", {
        guildId: options.guildId,
        ownerId: options.ownerId,
        targetUserId: options.targetUserId,
        failedChannelIds: sync.failedChannelIds,
      });
    }

    return {
      kind: "ok",
      partialSync: sync.failedChannelIds.length > 0,
      failedChannelIds: sync.failedChannelIds,
    };
  });
}

export async function unblockUser(options: {
  readonly blocks: OwnerBlockListRepository;
  readonly channels: TemporaryChannelRepository;
  readonly discord: DiscordApiPort;
  readonly logger: Logger;
  readonly guildId: string;
  readonly ownerId: string;
  readonly targetUserId: string;
  readonly requestId: string;
}): Promise<UnblockUserOutcome> {
  return withOwnerLock(options.guildId, options.ownerId, async () => {
    const removed = await options.blocks.removeBlockedUser(
      options.guildId,
      options.ownerId,
      options.targetUserId,
    );
    if (removed.outcome === "missing") return { kind: "not_blocked" };

    const sync = await synchronizeOwnedChannelBlockLists({
      discord: options.discord,
      channels: options.channels,
      guildId: options.guildId,
      ownerId: options.ownerId,
      blockedUserIds: removed.blockedUserIds,
      requestId: options.requestId,
      reason: "owner unblock",
    });

    if (sync.failedChannelIds.length > 0) {
      options.logger.warn("Unblock saved but some channels failed to sync", {
        guildId: options.guildId,
        ownerId: options.ownerId,
        targetUserId: options.targetUserId,
        failedChannelIds: sync.failedChannelIds,
      });
    }

    return {
      kind: "ok",
      partialSync: sync.failedChannelIds.length > 0,
      failedChannelIds: sync.failedChannelIds,
    };
  });
}

export const BLOCK_LIST_PAGE_SIZE = 10;
export const BLOCK_LIST_BUTTON_PREFIX = "block-list-page";

export function formatBlockListPage(options: {
  readonly blockedUserIds: readonly string[];
  readonly page: number;
}): {
  readonly description: string;
  readonly page: number;
  readonly totalPages: number;
  readonly hasPrev: boolean;
  readonly hasNext: boolean;
} {
  const total = options.blockedUserIds.length;
  const totalPages = Math.max(1, Math.ceil(total / BLOCK_LIST_PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page), totalPages);
  const start = (page - 1) * BLOCK_LIST_PAGE_SIZE;
  const slice = options.blockedUserIds.slice(start, start + BLOCK_LIST_PAGE_SIZE);
  const lines =
    slice.length === 0
      ? ["Your block list is empty."]
      : slice.map((id, index) => `${start + index + 1}. <@${id}> (\`${id}\`)`);
  return {
    description: [
      `**Block list** (${total}/${OWNER_BLOCK_LIST_MAX})`,
      ...lines,
      totalPages > 1 ? `Page ${page}/${totalPages}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
    page,
    totalPages,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

export function buildBlockListComponents(options: {
  readonly ownerId: string;
  readonly page: number;
  readonly hasPrev: boolean;
  readonly hasNext: boolean;
}): readonly unknown[] {
  if (!options.hasPrev && !options.hasNext) return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          customId: `${BLOCK_LIST_BUTTON_PREFIX}:${options.ownerId}:${options.page - 1}`,
          label: "Previous",
          disabled: !options.hasPrev,
        },
        {
          type: 2,
          style: 2,
          customId: `${BLOCK_LIST_BUTTON_PREFIX}:${options.ownerId}:${options.page + 1}`,
          label: "Next",
          disabled: !options.hasNext,
        },
      ],
    },
  ];
}
