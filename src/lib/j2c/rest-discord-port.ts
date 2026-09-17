import { ChannelTypes, type RestManager } from "discordeno";

import { REST_REQUEST_ID_HEADER } from "../coordinator/rest.ts";
import type {
  CreateGuildChannelRequest,
  CreateVoiceChannelRequest,
  DiscordApiPort,
} from "../runtime-types.ts";
import { toDiscordOperationResult, toDiscordValueResult } from "./discord-results.ts";

function withReason<T extends Record<string, unknown>>(
  base: T,
  reason: string | undefined,
): T & { reason?: string } {
  return reason === undefined ? base : { ...base, reason };
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

    async editChannel() {
      throw new Error("editChannel is not available on the coordinator Discord port");
    },

    async setChannelVoiceStatus() {
      throw new Error("setChannelVoiceStatus is not available on the coordinator Discord port");
    },

    async editChannelPermissionOverwrite() {
      throw new Error("editChannelPermissionOverwrite is not available on the coordinator Discord port");
    },

    async getUser() {
      throw new Error("getUser is not available on the coordinator Discord port");
    },

    async getCurrentUser() {
      throw new Error("getCurrentUser is not available on the coordinator Discord port");
    },

    async getGuild() {
      throw new Error("getGuild is not available on the coordinator Discord port");
    },

    async getGuildMember() {
      throw new Error("getGuildMember is not available on the coordinator Discord port");
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
        }>("GET", rest.routes.channels.channel(request.channelId));
        return {
          kind: "found" as const,
          value: {
            id: String(channel.id),
            ...(channel.name === undefined ? {} : { name: channel.name }),
            ...(channel.type === undefined ? {} : { type: channel.type }),
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

    async sendChannelMessage() {
      throw new Error("sendChannelMessage is not available on the coordinator Discord port");
    },

    async editChannelMessage() {
      throw new Error("editChannelMessage is not available on the coordinator Discord port");
    },

    async deleteChannelMessage() {
      throw new Error("deleteChannelMessage is not available on the coordinator Discord port");
    },
  };
}
