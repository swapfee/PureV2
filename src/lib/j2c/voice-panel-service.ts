import type { Logger } from "../logger.ts";
import type { DiscordApiPort, DiscordOperationResult } from "../runtime-types.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";
import { grantBotPanelTextAccess } from "./voice-panel-access.ts";
import {
  buildVoiceControlPanelComponents,
  IS_COMPONENTS_V2,
  VOICE_PANEL_VERSION,
} from "./voice-panel.ts";

/** Serializes install/refresh per channel so create + voice repair cannot double-send. */
const panelOpsInFlight = new Map<string, Promise<void>>();

/** Test-only: clear in-flight panel locks between cases that share channel ids. */
export function resetVoicePanelLocksForTests(): void {
  panelOpsInFlight.clear();
}

export function voicePanelNeedsRepair(record: {
  readonly panelMessageId?: string;
  readonly panelVersion?: number;
  readonly panelOwnerId?: string;
  readonly ownerId: string;
}): boolean {
  return (
    !record.panelMessageId ||
    record.panelVersion !== VOICE_PANEL_VERSION ||
    record.panelOwnerId !== record.ownerId
  );
}

async function persistPanelMessage(
  channels: TemporaryChannelRepository,
  channelId: string,
  panelMessageId: string,
  ownerId: string,
): Promise<void> {
  await channels.setPanelMessage(channelId, panelMessageId, VOICE_PANEL_VERSION, ownerId);
}

async function withChannelPanelLock(channelId: string, run: () => Promise<void>): Promise<void> {
  const previous = panelOpsInFlight.get(channelId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Keep the map entry until this caller finishes, chaining waiters behind us.
  const held = previous.catch(() => undefined).then(() => gate);
  panelOpsInFlight.set(channelId, held);

  await previous.catch(() => undefined);
  try {
    await run();
  } finally {
    release();
    // Only clear if no newer waiter replaced our chain head.
    queueMicrotask(() => {
      if (panelOpsInFlight.get(channelId) === held) {
        panelOpsInFlight.delete(channelId);
      }
    });
  }
}

async function recordAlreadyHasCurrentPanel(
  channels: TemporaryChannelRepository,
  channelId: string,
  ownerId: string,
): Promise<boolean> {
  const record = await channels.findByChannelId(channelId);
  if (!record) return false;
  return !voicePanelNeedsRepair({
    ownerId,
    ...(record.panelMessageId ? { panelMessageId: record.panelMessageId } : {}),
    ...(record.panelVersion !== undefined ? { panelVersion: record.panelVersion } : {}),
    ...(record.panelOwnerId ? { panelOwnerId: record.panelOwnerId } : {}),
  });
}

export async function installVoiceControlPanel(options: {
  readonly discord: DiscordApiPort;
  readonly channels: TemporaryChannelRepository;
  readonly logger: Logger;
  readonly guildId: string;
  readonly channelId: string;
  readonly ownerId: string;
  readonly botUserId: string;
  readonly botUsername: string;
  readonly requestId: string;
}): Promise<void> {
  await withChannelPanelLock(options.channelId, async () => {
    try {
      if (await recordAlreadyHasCurrentPanel(options.channels, options.channelId, options.ownerId)) {
        return;
      }

      await grantBotPanelTextAccess({
        discord: options.discord,
        channelId: options.channelId,
        guildId: options.guildId,
        botUserId: options.botUserId,
        requestId: options.requestId,
      });

      // Re-check after overwrites: a concurrent waiter may have finished sending.
      if (await recordAlreadyHasCurrentPanel(options.channels, options.channelId, options.ownerId)) {
        return;
      }

      const components = buildVoiceControlPanelComponents({
        botUsername: options.botUsername,
        channelId: options.channelId,
        ownerId: options.ownerId,
      });

      const sent = await options.discord.sendChannelMessage({
        channelId: options.channelId,
        requestId: `${options.requestId}:panel`,
        components,
        flags: IS_COMPONENTS_V2,
      });

      if (sent.kind !== "found") {
        options.logger.warn("Voice panel send failed; channel remains usable via /vc", {
          guildId: options.guildId,
          channelId: options.channelId,
          outcome: sent.kind,
        });
        return;
      }

      await persistPanelMessage(
        options.channels,
        options.channelId,
        sent.value.id,
        options.ownerId,
      );
    } catch (error) {
      options.logger.warn("Voice panel install failed; channel remains usable via /vc", {
        guildId: options.guildId,
        channelId: options.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function shouldResendAfterEdit(result: DiscordOperationResult): boolean {
  // Only replace the message when Discord says it is gone. Transient/forbidden
  // failures must not create a second panel copy.
  return result.kind === "missing";
}

export async function refreshVoiceControlPanel(options: {
  readonly discord: DiscordApiPort;
  readonly channels: TemporaryChannelRepository;
  readonly logger: Logger;
  readonly channelId: string;
  readonly ownerId: string;
  readonly botUsername: string;
  readonly panelMessageId?: string;
  readonly requestId: string;
}): Promise<void> {
  await withChannelPanelLock(options.channelId, async () => {
    const latest = await options.channels.findByChannelId(options.channelId);
    const panelMessageId = latest?.panelMessageId ?? options.panelMessageId;
    const components = buildVoiceControlPanelComponents({
      botUsername: options.botUsername,
      channelId: options.channelId,
      ownerId: options.ownerId,
    });

    if (panelMessageId) {
      const edited = await options.discord.editChannelMessage({
        channelId: options.channelId,
        messageId: panelMessageId,
        requestId: `${options.requestId}:panel-edit`,
        components,
        flags: IS_COMPONENTS_V2,
      });
      if (edited.kind === "ok") {
        await persistPanelMessage(
          options.channels,
          options.channelId,
          panelMessageId,
          options.ownerId,
        );
        return;
      }
      if (!shouldResendAfterEdit(edited)) {
        options.logger.warn("Voice panel edit failed; leaving existing message in place", {
          channelId: options.channelId,
          panelMessageId,
          outcome: edited.kind,
          ...(edited.kind === "transient" ? { message: edited.message } : {}),
        });
        return;
      }
    } else if (
      await recordAlreadyHasCurrentPanel(options.channels, options.channelId, options.ownerId)
    ) {
      // No id was provided, but another install finished while we waited on the lock.
      return;
    }

    // If Discord said our message is gone, replace it even when Mongo still has the stale id.
    // Only abort when a different, current panel message appeared concurrently.
    const afterEdit = await options.channels.findByChannelId(options.channelId);
    if (
      panelMessageId &&
      afterEdit?.panelMessageId &&
      afterEdit.panelMessageId !== panelMessageId &&
      !voicePanelNeedsRepair({
        ownerId: options.ownerId,
        panelMessageId: afterEdit.panelMessageId,
        ...(afterEdit.panelVersion !== undefined ? { panelVersion: afterEdit.panelVersion } : {}),
        ...(afterEdit.panelOwnerId ? { panelOwnerId: afterEdit.panelOwnerId } : {}),
      })
    ) {
      return;
    }

    const sent = await options.discord.sendChannelMessage({
      channelId: options.channelId,
      requestId: `${options.requestId}:panel-resend`,
      components,
      flags: IS_COMPONENTS_V2,
    });
    if (sent.kind === "found") {
      await persistPanelMessage(options.channels, options.channelId, sent.value.id, options.ownerId);
    } else {
      options.logger.warn("Voice panel refresh failed", {
        channelId: options.channelId,
        outcome: sent.kind,
      });
    }
  });
}
