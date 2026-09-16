import type { Logger } from "../logger.ts";
import type { DiscordApiPort, DiscordOperationResult } from "../runtime-types.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";
import { grantBotPanelTextAccess } from "./voice-panel-access.ts";
import {
  buildVoiceControlPanelComponents,
  IS_COMPONENTS_V2,
  VOICE_PANEL_VERSION,
} from "./voice-panel.ts";

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
  try {
    await grantBotPanelTextAccess({
      discord: options.discord,
      channelId: options.channelId,
      guildId: options.guildId,
      botUserId: options.botUserId,
      requestId: options.requestId,
    });

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
  const components = buildVoiceControlPanelComponents({
    botUsername: options.botUsername,
    channelId: options.channelId,
    ownerId: options.ownerId,
  });

  if (options.panelMessageId) {
    const edited = await options.discord.editChannelMessage({
      channelId: options.channelId,
      messageId: options.panelMessageId,
      requestId: `${options.requestId}:panel-edit`,
      components,
      flags: IS_COMPONENTS_V2,
    });
    if (edited.kind === "ok") {
      await persistPanelMessage(
        options.channels,
        options.channelId,
        options.panelMessageId,
        options.ownerId,
      );
      return;
    }
    if (!shouldResendAfterEdit(edited)) {
      options.logger.warn("Voice panel edit failed; leaving existing message in place", {
        channelId: options.channelId,
        panelMessageId: options.panelMessageId,
        outcome: edited.kind,
        ...(edited.kind === "transient" ? { message: edited.message } : {}),
      });
      return;
    }
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
}
