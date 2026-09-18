import {
  ChannelTypes,
  createBot,
  InteractionResponseTypes,
  type MessageComponents,
} from "discordeno";

import type { WorkerConfig } from "../config.ts";
import { restProxyBaseUrl } from "../config.ts";
import { COORDINATOR_INTENTS } from "../coordinator/gateway.ts";
import { REST_REQUEST_ID_HEADER } from "../coordinator/rest.ts";
import { toDiscordOperationResult, toDiscordValueResult } from "../j2c/discord-results.ts";
import { displayNameFromVoiceMember } from "../j2c/display-name.ts";
import type { Logger } from "../logger.ts";
import { createDiscordenoLogger } from "../logger.ts";
import type {
  CreateGuildChannelRequest,
  CreateVoiceChannelRequest,
  DiscordApiPort,
  InteractionResponseRequest,
  PermissionOverwrite,
} from "../runtime-types.ts";
import { workerDesiredProperties } from "./desired-properties.ts";
import { createWorkerBotAdapter } from "./synthetic-token.ts";

function buildBot(config: WorkerConfig, logger: Logger) {
  const adapter = createWorkerBotAdapter({ applicationId: config.DISCORD_APPLICATION_ID });
  const bot = createBot({
    token: adapter.token,
    applicationId: BigInt(adapter.applicationId),
    intents: COORDINATOR_INTENTS,
    desiredProperties: workerDesiredProperties,
    rest: {
      proxy: {
        baseUrl: restProxyBaseUrl(config),
        authorization: config.REST_PROXY_AUTHORIZATION,
      },
    },
    loggerFactory: (name) => createDiscordenoLogger(logger.child({ component: name })),
  });

  // Discordeno's voiceState transformer drops `member`. Re-attach display name from the raw payload.
  bot.transformers.customizers.voiceState = (_bot, payload, voiceState) => {
    const info = displayNameFromVoiceMember(Reflect.get(payload, "member"));
    if (info.displayName !== undefined) {
      Reflect.set(voiceState, "displayName", info.displayName);
    }
    if (info.isBot) {
      Reflect.set(voiceState, "memberIsBot", true);
    }
    return voiceState;
  };

  return bot;
}

export type WorkerBot = ReturnType<typeof buildBot>;

export interface WorkerBotBundle {
  readonly bot: WorkerBot;
  readonly discord: DiscordApiPort;
}

function withReason<T extends Record<string, unknown>>(
  base: T,
  reason: string | undefined,
): T & { reason?: string } {
  return reason === undefined ? base : { ...base, reason };
}

/** Panel/modal payloads are built as plain objects that match Discordeno MessageComponents. */
function toMessageComponents(components: readonly unknown[]): MessageComponents {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Discordeno expects MessageComponents; panel builders emit compatible JSON shapes.
  return components as MessageComponents;
}

function isVoiceChannelType(type: number): boolean {
  const voiceType: number = ChannelTypes.GuildVoice;
  return type === voiceType;
}

function readOverwrites(raw: unknown): PermissionOverwrite[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const overwrites: PermissionOverwrite[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const id = Reflect.get(item, "id");
    const type = Reflect.get(item, "type");
    const allow = Reflect.get(item, "allow");
    const deny = Reflect.get(item, "deny");
    if (id === undefined || (type !== 0 && type !== 1)) continue;
    overwrites.push({
      id: String(id),
      type,
      allow: allow === undefined ? "0" : String(allow),
      deny: deny === undefined ? "0" : String(deny),
    });
  }
  return overwrites;
}

export function createWorkerBot(config: WorkerConfig, logger: Logger): WorkerBotBundle {
  const bot = buildBot(config, logger);
  // Never call bot.start() — gateway shards belong exclusively to the coordinator.

  const discord: DiscordApiPort = {
    async respondToInteraction(request: InteractionResponseRequest): Promise<void> {
      const flags =
        request.flags ??
        (request.ephemeral === false ? undefined : 64);
      await bot.rest.sendInteractionResponse(request.interactionId, request.interactionToken, {
        type: InteractionResponseTypes.ChannelMessageWithSource,
        data: {
          ...(request.content === undefined ? {} : { content: request.content }),
          ...(request.embeds === undefined ? {} : { embeds: [...request.embeds] }),
          ...(request.components === undefined
            ? {}
            : { components: toMessageComponents(request.components) }),
          ...(flags === undefined ? {} : { flags }),
        },
      });
    },

    async respondToAutocomplete(request) {
      await bot.rest.sendInteractionResponse(request.interactionId, request.interactionToken, {
        type: InteractionResponseTypes.ApplicationCommandAutocompleteResult,
        data: {
          choices: request.choices.map((choice) => ({
            name: choice.name.slice(0, 100),
            value: choice.value,
          })),
        },
      });
    },

    async deferInteraction(request) {
      await bot.rest.sendInteractionResponse(request.interactionId, request.interactionToken, {
        type: InteractionResponseTypes.DeferredChannelMessageWithSource,
        data: request.ephemeral === false ? {} : { flags: 64 },
      });
    },

    async deferUpdateInteraction(request) {
      await bot.rest.sendInteractionResponse(request.interactionId, request.interactionToken, {
        type: InteractionResponseTypes.DeferredUpdateMessage,
      });
    },

    async editInteractionResponse(request) {
      await bot.helpers.editOriginalInteractionResponse(request.interactionToken, {
        ...(request.content === undefined ? {} : { content: request.content }),
        ...(request.embeds === undefined ? {} : { embeds: [...request.embeds] }),
        ...(request.components === undefined
          ? {}
          : { components: toMessageComponents(request.components) }),
        ...(request.flags === undefined ? {} : { flags: request.flags }),
      });
    },

    async showModal(request) {
      await bot.rest.sendInteractionResponse(request.interactionId, request.interactionToken, {
        type: InteractionResponseTypes.Modal,
        data: {
          title: request.title,
          customId: request.customId,
          components: toMessageComponents(request.components),
        },
      });
    },

    async createVoiceChannel(request: CreateVoiceChannelRequest) {
      try {
        const created = await bot.rest.makeRequest<{ id: string | number | bigint }>(
          "POST",
          bot.rest.routes.guilds.channels(request.guildId),
          withReason(
            {
              body: {
                name: request.name,
                type: ChannelTypes.GuildVoice,
                parent_id: request.parentId,
                ...(request.userLimit === undefined ? {} : { user_limit: request.userLimit }),
              },
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "found" as const, value: { id: String(created.id) } };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async setGuildChannelPosition(request) {
      try {
        await bot.rest.makeRequest(
          "PATCH",
          bot.rest.routes.guilds.channels(request.guildId),
          withReason(
            {
              body: [{ id: request.channelId, position: request.position }],
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async createGuildChannel(request: CreateGuildChannelRequest) {
      try {
        const created = await bot.rest.makeRequest<{ id: string | number | bigint }>(
          "POST",
          bot.rest.routes.guilds.channels(request.guildId),
          withReason(
            {
              body: {
                name: request.name,
                type: request.type,
                ...(request.parentId === undefined ? {} : { parent_id: request.parentId }),
                ...(request.userLimit === undefined || !isVoiceChannelType(request.type)
                  ? {}
                  : { user_limit: request.userLimit }),
              },
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "found" as const, value: { id: String(created.id) } };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async deleteChannel(request) {
      try {
        await bot.rest.makeRequest(
          "DELETE",
          bot.rest.routes.channels.channel(request.channelId),
          withReason(
            {
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async getChannel(request) {
      try {
        // Prefer raw REST so voice fields Discordeno may omit (e.g. status) are available.
        const channel = await bot.rest.makeRequest<{
          id: string | number | bigint;
          name?: string;
          type?: number;
          position?: number;
          user_limit?: number;
          bitrate?: number;
          nsfw?: boolean;
          rtc_region?: string | null;
          status?: string | null;
          permission_overwrites?: unknown;
        }>("GET", bot.rest.routes.channels.channel(request.channelId));
        const overwrites = readOverwrites(channel.permission_overwrites);
        return {
          kind: "found" as const,
          value: {
            id: String(channel.id),
            ...(channel.name === undefined ? {} : { name: channel.name }),
            ...(channel.type === undefined ? {} : { type: channel.type }),
            ...(channel.position === undefined ? {} : { position: channel.position }),
            ...(channel.user_limit === undefined ? {} : { userLimit: channel.user_limit }),
            ...(channel.bitrate === undefined ? {} : { bitrate: channel.bitrate }),
            ...(channel.nsfw === undefined ? {} : { nsfw: channel.nsfw }),
            ...(channel.rtc_region === undefined ? {} : { rtcRegion: channel.rtc_region }),
            ...(channel.status === undefined ? {} : { status: channel.status }),
            ...(overwrites === undefined ? {} : { permissionOverwrites: overwrites }),
          },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async getGuild(request) {
      try {
        const guild = await bot.rest.makeRequest<{
          id: string | number | bigint;
          premium_tier?: number;
          features?: string[];
        }>("GET", bot.rest.routes.guilds.guild(request.guildId));
        return {
          kind: "found" as const,
          value: {
            id: String(guild.id),
            premiumTier: typeof guild.premium_tier === "number" ? guild.premium_tier : 0,
            features: Array.isArray(guild.features) ? guild.features : [],
          },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async editChannel(request) {
      try {
        await bot.rest.makeRequest(
          "PATCH",
          bot.rest.routes.channels.channel(request.channelId),
          withReason(
            {
              body: {
                ...(request.name === undefined ? {} : { name: request.name }),
                ...(request.userLimit === undefined ? {} : { user_limit: request.userLimit }),
                ...(request.bitrate === undefined ? {} : { bitrate: request.bitrate }),
                ...(request.nsfw === undefined ? {} : { nsfw: request.nsfw }),
                ...(request.rtcRegion === undefined ? {} : { rtc_region: request.rtcRegion }),
                ...(request.parentId === undefined ? {} : { parent_id: request.parentId }),
              },
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async setChannelVoiceStatus(request) {
      try {
        await bot.rest.makeRequest("PUT", `/channels/${request.channelId}/voice-status`, {
          body: { status: request.status },
          headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
        });
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async editChannelPermissionOverwrite(request) {
      try {
        await bot.rest.makeRequest(
          "PUT",
          bot.rest.routes.channels.overwrite(request.channelId, request.overwriteId),
          withReason(
            {
              body: {
                type: request.type,
                allow: request.allow,
                deny: request.deny,
              },
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async getUser(request) {
      try {
        const user = await bot.helpers.getUser(request.userId);
        const botFlag = Reflect.get(user, "bot");
        const usernameRaw = Reflect.get(user, "username");
        const globalNameRaw = Reflect.get(user, "globalName");
        return {
          kind: "found" as const,
          value: {
            id: String(user.id),
            bot: typeof botFlag === "boolean" ? botFlag : false,
            ...(typeof usernameRaw === "string" ? { username: usernameRaw } : {}),
            ...(typeof globalNameRaw === "string" ? { globalName: globalNameRaw } : {}),
          },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async getGuildMember(request) {
      try {
        const member = await bot.helpers.getMember(request.guildId, request.userId);
        const nickRaw = Reflect.get(member, "nick");
        const memberUser = Reflect.get(member, "user");
        let username: string | undefined;
        let globalName: string | undefined;
        let isBot = false;
        if (typeof memberUser === "object" && memberUser !== null) {
          const usernameRaw = Reflect.get(memberUser, "username");
          const globalNameRaw = Reflect.get(memberUser, "globalName");
          const botRaw = Reflect.get(memberUser, "bot");
          if (typeof usernameRaw === "string") username = usernameRaw;
          if (typeof globalNameRaw === "string") globalName = globalNameRaw;
          isBot = typeof botRaw === "boolean" ? botRaw : false;
        }
        return {
          kind: "found" as const,
          value: {
            id: String(Reflect.get(member, "id") ?? request.userId),
            bot: isBot,
            ...(typeof nickRaw === "string" ? { nick: nickRaw } : {}),
            ...(username === undefined ? {} : { username }),
            ...(globalName === undefined ? {} : { globalName }),
          },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async getUserVoiceChannel(request) {
      try {
        const voiceState = await bot.helpers.getUserVoiceState(request.guildId, request.userId);
        const muteRaw = Reflect.get(voiceState, "mute");
        const toggles = Reflect.get(voiceState, "toggles");
        const toggleMute =
          typeof toggles === "object" && toggles !== null ? Reflect.get(toggles, "mute") : undefined;
        const serverMuted =
          typeof muteRaw === "boolean"
            ? muteRaw
            : typeof toggleMute === "boolean"
              ? toggleMute
              : undefined;
        return {
          kind: "found" as const,
          value: {
            channelId: voiceState.channelId === undefined ? null : String(voiceState.channelId),
            ...(serverMuted === undefined ? {} : { serverMuted }),
          },
        };
      } catch (error) {
        const result = toDiscordValueResult<{ channelId: string | null; serverMuted?: boolean }>(
          error,
        );
        // Discord returns 404 when the member is not connected to any voice channel.
        if (result.kind === "missing") {
          return { kind: "found", value: { channelId: null } };
        }
        return result;
      }
    },

    async moveMemberToChannel(request) {
      try {
        await bot.rest.makeRequest(
          "PATCH",
          bot.rest.routes.guilds.members.member(request.guildId, request.userId),
          withReason(
            {
              body: { channel_id: request.channelId },
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async setMemberServerMute(request) {
      try {
        await bot.rest.makeRequest(
          "PATCH",
          bot.rest.routes.guilds.members.member(request.guildId, request.userId),
          withReason(
            {
              body: { mute: request.mute },
              headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
            },
            request.reason,
          ),
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async sendDirectMessage(request) {
      try {
        const dm = await bot.helpers.getDmChannel(request.userId);
        await bot.helpers.sendMessage(String(dm.id), {
          content: request.content,
        });
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async getCurrentUser() {
      try {
        const me = await bot.rest.makeRequest<{ id: string | number | bigint; username: string }>(
          "GET",
          bot.rest.routes.user("@me"),
        );
        return {
          kind: "found" as const,
          value: { id: String(me.id), username: me.username },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async sendChannelMessage(request) {
      try {
        const created = await bot.rest.makeRequest<{ id: string | number | bigint }>(
          "POST",
          bot.rest.routes.channels.messages(request.channelId),
          {
            body: {
              ...(request.content === undefined ? {} : { content: request.content }),
              ...(request.embeds === undefined ? {} : { embeds: request.embeds }),
              ...(request.components === undefined ? {} : { components: request.components }),
              ...(request.flags === undefined ? {} : { flags: request.flags }),
            },
            headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
          },
        );
        return { kind: "found" as const, value: { id: String(created.id) } };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async editChannelMessage(request) {
      try {
        await bot.rest.makeRequest(
          "PATCH",
          bot.rest.routes.channels.message(request.channelId, request.messageId),
          {
            body: {
              ...(request.content === undefined ? {} : { content: request.content }),
              ...(request.embeds === undefined ? {} : { embeds: request.embeds }),
              ...(request.components === undefined ? {} : { components: request.components }),
              ...(request.flags === undefined ? {} : { flags: request.flags }),
            },
            headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
          },
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },

    async deleteChannelMessage(request) {
      try {
        await bot.rest.makeRequest(
          "DELETE",
          bot.rest.routes.channels.message(request.channelId, request.messageId),
          {
            headers: { [REST_REQUEST_ID_HEADER]: request.requestId },
          },
        );
        return { kind: "ok" };
      } catch (error) {
        return toDiscordOperationResult(error);
      }
    },
  };

  return { bot, discord };
}
