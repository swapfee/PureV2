import { ChannelTypes, type RestManager } from "discordeno";

import { REST_REQUEST_ID_HEADER } from "../coordinator/rest.ts";
import type {
  CreateGuildChannelRequest,
  CreateVoiceChannelRequest,
  DiscordApiPort,
  PermissionOverwrite,
} from "../runtime-types.ts";
import { toDiscordOperationResult, toDiscordValueResult } from "./discord-results.ts";

function withReason<T extends Record<string, unknown>>(
  base: T,
  reason: string | undefined,
): T & { reason?: string } {
  return reason === undefined ? base : { ...base, reason };
}

function readPermissionOverwrites(raw: unknown): readonly PermissionOverwrite[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const overwrites: PermissionOverwrite[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null) continue;
    const id = Reflect.get(value, "id");
    const type = Reflect.get(value, "type");
    if ((typeof id !== "string" && typeof id !== "number") || (type !== 0 && type !== 1)) {
      continue;
    }
    overwrites.push({
      id: String(id),
      type,
      allow: String(Reflect.get(value, "allow") ?? "0"),
      deny: String(Reflect.get(value, "deny") ?? "0"),
    });
  }
  return overwrites;
}

/**
 * Discord API port backed by the coordinator's central RestManager.
 * Used for startup reconciliation — never bypasses Discordeno rate limits.
 */
export function createRestManagerDiscordPort(rest: RestManager): DiscordApiPort {
  return {
    async respondToInteraction() {
      throw new Error("respondToInteraction is not available on the coordinator Discord port");
    },

    async respondToAutocomplete() {
      throw new Error("respondToAutocomplete is not available on the coordinator Discord port");
    },

    async deferInteraction() {
      throw new Error("deferInteraction is not available on the coordinator Discord port");
    },

    async deferUpdateInteraction() {
      throw new Error("deferUpdateInteraction is not available on the coordinator Discord port");
    },

    async editInteractionResponse() {
      throw new Error("editInteractionResponse is not available on the coordinator Discord port");
    },

    async showModal() {
      throw new Error("showModal is not available on the coordinator Discord port");
    },

    async editChannel(request) {
      try {
        await rest.makeRequest(
          "PATCH",
          rest.routes.channels.channel(request.channelId),
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

    async setChannelVoiceStatus() {
      throw new Error("setChannelVoiceStatus is not available on the coordinator Discord port");
    },

    async editChannelPermissionOverwrite(request) {
      try {
        await rest.makeRequest(
          "PUT",
          rest.routes.channels.overwrite(request.channelId, request.overwriteId),
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
        const user = await rest.makeRequest<{
          id: string | number | bigint;
          username?: string;
          global_name?: string | null;
          bot?: boolean;
        }>("GET", rest.routes.user(request.userId));
        return {
          kind: "found" as const,
          value: {
            id: String(user.id),
            bot: user.bot === true,
            ...(typeof user.username === "string" ? { username: user.username } : {}),
            ...(typeof user.global_name === "string" ? { globalName: user.global_name } : {}),
          },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async getCurrentUser() {
      try {
        const user = await rest.makeRequest<{
          id: string | number | bigint;
          username: string;
        }>("GET", rest.routes.user("@me"));
        return {
          kind: "found" as const,
          value: { id: String(user.id), username: user.username },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async getGuild() {
      throw new Error("getGuild is not available on the coordinator Discord port");
    },

    async getGuildMember(request) {
      try {
        const member = await rest.makeRequest<{
          nick?: string | null;
          user?: {
            id: string | number | bigint;
            username?: string;
            global_name?: string | null;
            bot?: boolean;
          };
        }>("GET", rest.routes.guilds.members.member(request.guildId, request.userId));
        const user = member.user;
        return {
          kind: "found" as const,
          value: {
            id: String(user?.id ?? request.userId),
            bot: user?.bot === true,
            ...(typeof member.nick === "string" ? { nick: member.nick } : {}),
            ...(typeof user?.username === "string" ? { username: user.username } : {}),
            ...(typeof user?.global_name === "string" ? { globalName: user.global_name } : {}),
          },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async createVoiceChannel(request: CreateVoiceChannelRequest) {
      try {
        const created = await rest.makeRequest<{ id: string | number | bigint }>(
          "POST",
          rest.routes.guilds.channels(request.guildId),
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
        await rest.makeRequest(
          "PATCH",
          rest.routes.guilds.channels(request.guildId),
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

    async createGuildChannel(_request: CreateGuildChannelRequest) {
      throw new Error("createGuildChannel is not available on the coordinator Discord port");
    },

    async deleteChannel(request) {
      try {
        await rest.makeRequest(
          "DELETE",
          rest.routes.channels.channel(request.channelId),
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
        const channel = await rest.makeRequest<{
          id: string | number | bigint;
          name?: string;
          type?: number;
          position?: number;
          permission_overwrites?: unknown;
        }>("GET", rest.routes.channels.channel(request.channelId));
        const permissionOverwrites = readPermissionOverwrites(channel.permission_overwrites);
        return {
          kind: "found" as const,
          value: {
            id: String(channel.id),
            ...(channel.name === undefined ? {} : { name: channel.name }),
            ...(channel.type === undefined ? {} : { type: channel.type }),
            ...(channel.position === undefined ? {} : { position: channel.position }),
            ...(permissionOverwrites === undefined ? {} : { permissionOverwrites }),
          },
        };
      } catch (error) {
        return toDiscordValueResult(error);
      }
    },

    async getUserVoiceChannel(request) {
      try {
        const voiceState = await rest.makeRequest<{
          channel_id?: string | null;
          mute?: boolean;
        }>("GET", rest.routes.guilds.voice(request.guildId, request.userId));
        return {
          kind: "found" as const,
          value: {
            channelId: voiceState.channel_id ?? null,
            ...(typeof voiceState.mute === "boolean" ? { serverMuted: voiceState.mute } : {}),
          },
        };
      } catch (error) {
        const result = toDiscordValueResult<{ channelId: string | null; serverMuted?: boolean }>(
          error,
        );
        if (result.kind === "missing") {
          return { kind: "found", value: { channelId: null } };
        }
        return result;
      }
    },

    async moveMemberToChannel(request) {
      try {
        await rest.makeRequest(
          "PATCH",
          rest.routes.guilds.members.member(request.guildId, request.userId),
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

    async setMemberServerMute() {
      throw new Error("setMemberServerMute is not available on the coordinator Discord port");
    },

    async sendDirectMessage() {
      throw new Error("sendDirectMessage is not available on the coordinator Discord port");
    },

    async sendChannelMessage(request) {
      try {
        const created = await rest.makeRequest<{ id: string | number | bigint }>(
          "POST",
          rest.routes.channels.messages(request.channelId),
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

    async editChannelMessage() {
      throw new Error("editChannelMessage is not available on the coordinator Discord port");
    },

    async deleteChannelMessage() {
      throw new Error("deleteChannelMessage is not available on the coordinator Discord port");
    },
  };
}
