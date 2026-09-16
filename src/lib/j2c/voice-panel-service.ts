import type { Logger } from "../logger.ts";
import type { DiscordApiPort } from "../runtime-types.ts";
import type { TemporaryChannelRepository } from "./repositories.ts";
import { grantBotPanelTextAccess } from "./voice-panel-access.ts";
import {
  buildVoiceControlPanelComponents,
  IS_COMPONENTS_V2,
  VOICE_PANEL_VERSION,
} from "./voice-panel.ts";

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

    await options.channels.setPanelMessage(options.channelId, sent.value.id, VOICE_PANEL_VERSION);
  } catch (error) {
    options.logger.warn("Voice panel install failed; channel remains usable via /vc", {
      guildId: options.guildId,
      channelId: options.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
      await options.channels.setPanelMessage(
        options.channelId,
        options.panelMessageId,
        VOICE_PANEL_VERSION,
      );
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
    await options.channels.setPanelMessage(options.channelId, sent.value.id, VOICE_PANEL_VERSION);
  } else {
    options.logger.warn("Voice panel refresh failed", {
      channelId: options.channelId,
      outcome: sent.kind,
    });
  }
}
