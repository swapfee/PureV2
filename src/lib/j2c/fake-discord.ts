import { ChannelTypes } from "discordeno";

import type {
  CreateGuildChannelRequest,
  CreateVoiceChannelRequest,
  DiscordApiPort,
  DiscordOperationResult,
  DiscordValueResult,
  PermissionOverwrite,
} from "../runtime-types.ts";

export interface FakeDiscordChannel {
  id: string;
  name: string;
  type?: number;
  parentId?: string;
  userLimit?: number;
  bitrate?: number;
  nsfw?: boolean;
  rtcRegion?: string | null;
  status?: string | null;
  guildId: string;
  permissionOverwrites: PermissionOverwrite[];
}

export interface FakeDiscordGuild {
  id: string;
  premiumTier: number;
  features: string[];
}

export interface FakeDiscordControls {
  readonly channels: Map<string, FakeDiscordChannel>;
  readonly guilds: Map<string, FakeDiscordGuild>;
  readonly voiceByUser: Map<string, string | null>;
  /** guildId:userId -> server mute */
  readonly serverMuteByUser: Map<string, boolean>;
  readonly users: Map<string, { id: string; bot: boolean; username?: string; globalName?: string }>;
  readonly members: Map<string, { id: string; bot: boolean; nick?: string; username?: string; globalName?: string }>;
  readonly createCalls: CreateVoiceChannelRequest[];
  readonly guildChannelCreates: CreateGuildChannelRequest[];
  readonly deleteCalls: { channelId: string; requestId: string }[];
  readonly moveCalls: { guildId: string; userId: string; channelId: string | null; requestId: string }[];
  readonly muteCalls: { guildId: string; userId: string; mute: boolean; requestId: string }[];
  readonly dmCalls: { userId: string; content: string; requestId: string }[];
  readonly editCalls: {
    channelId: string;
    requestId: string;
    name?: string;
    userLimit?: number;
    bitrate?: number;
    nsfw?: boolean;
    rtcRegion?: string | null;
    parentId?: string | null;
  }[];
  readonly voiceStatusCalls: { channelId: string; requestId: string; status: string | null }[];
  readonly overwriteCalls: {
    channelId: string;
    overwriteId: string;
    requestId: string;
    allow: string;
    deny: string;
    type: 0 | 1;
  }[];
  readonly deferredInteractions: string[];
  readonly deferredUpdates: string[];
  readonly modals: { interactionId: string; customId: string; title: string }[];
  readonly channelMessages: {
    channelId: string;
    id: string;
    content?: string;
    embeds?: readonly { description: string; color?: number; title?: string }[];
    components?: readonly unknown[];
    flags?: number;
  }[];
  readonly editedChannelMessages: {
    channelId: string;
    messageId: string;
    content?: string;
    embeds?: readonly { description: string; color?: number; title?: string }[];
    components?: readonly unknown[];
    flags?: number;
  }[];
  readonly deletedChannelMessages: { channelId: string; messageId: string; requestId: string }[];
  readonly editedInteractions: {
    token: string;
    content?: string;
    embeds?: readonly { description: string; color?: number; title?: string }[];
    components?: readonly unknown[];
  }[];
  readonly responses: {
    interactionId: string;
    content?: string;
    embeds?: readonly { description: string; color?: number; title?: string }[];
    components?: readonly unknown[];
  }[];
  readonly autocompleteResponses: {
    interactionId: string;
    choices: readonly { name: string; value: string }[];
  }[];
  currentUser?: { id: string; username: string };
  messageSequence: number;
  failNextCreate?: DiscordValueResult<{ id: string }>;
  failNextGuildChannelCreate?: DiscordValueResult<{ id: string }>;
  failNextMove?: DiscordOperationResult;
  failNextMute?: DiscordOperationResult;
  failNextDelete?: DiscordOperationResult;
  failNextEdit?: DiscordOperationResult;
  failNextVoiceStatus?: DiscordOperationResult;
  failNextOverwrite?: DiscordOperationResult;
  failNextSendMessage?: DiscordValueResult<{ id: string }>;
  failNextEditMessage?: DiscordOperationResult;
  failCompensationDeletes?: boolean;
  missingChannels: Set<string>;
  createSequence: number;
}

export function createFakeDiscord(seed?: Partial<FakeDiscordControls>): {
  readonly discord: DiscordApiPort;
  readonly controls: FakeDiscordControls;
} {
  const controls: FakeDiscordControls = {
    channels: seed?.channels ?? new Map(),
    guilds: seed?.guilds ?? new Map(),
    voiceByUser: seed?.voiceByUser ?? new Map(),
    serverMuteByUser: seed?.serverMuteByUser ?? new Map(),
    users: seed?.users ?? new Map(),
    members: seed?.members ?? new Map(),
    createCalls: [],
    guildChannelCreates: [],
    deleteCalls: [],
    moveCalls: [],
    muteCalls: [],
    dmCalls: [],
    editCalls: [],
    voiceStatusCalls: [],
    overwriteCalls: [],
    deferredInteractions: [],
    deferredUpdates: [],
    modals: [],
    channelMessages: [],
    editedChannelMessages: [],
    deletedChannelMessages: [],
    editedInteractions: [],
    responses: [],
    autocompleteResponses: [],
    messageSequence: seed?.messageSequence ?? 0,
    missingChannels: seed?.missingChannels ?? new Set(),
    createSequence: seed?.createSequence ?? 0,
    ...(seed?.currentUser === undefined ? {} : { currentUser: seed.currentUser }),
    ...(seed?.failNextCreate === undefined ? {} : { failNextCreate: seed.failNextCreate }),
    ...(seed?.failNextGuildChannelCreate === undefined
      ? {}
      : { failNextGuildChannelCreate: seed.failNextGuildChannelCreate }),
    ...(seed?.failNextMove === undefined ? {} : { failNextMove: seed.failNextMove }),
    ...(seed?.failNextMute === undefined ? {} : { failNextMute: seed.failNextMute }),
    ...(seed?.failNextDelete === undefined ? {} : { failNextDelete: seed.failNextDelete }),
    ...(seed?.failNextEdit === undefined ? {} : { failNextEdit: seed.failNextEdit }),
    ...(seed?.failNextVoiceStatus === undefined
      ? {}
      : { failNextVoiceStatus: seed.failNextVoiceStatus }),
    ...(seed?.failNextOverwrite === undefined ? {} : { failNextOverwrite: seed.failNextOverwrite }),
    ...(seed?.failNextSendMessage === undefined ? {} : { failNextSendMessage: seed.failNextSendMessage }),
    ...(seed?.failNextEditMessage === undefined ? {} : { failNextEditMessage: seed.failNextEditMessage }),
    ...(seed?.failCompensationDeletes === undefined
      ? {}
      : { failCompensationDeletes: seed.failCompensationDeletes }),
  };

  const discord: DiscordApiPort = {
    async respondToInteraction(request) {
      controls.responses.push({
        interactionId: request.interactionId,
        ...(request.content === undefined ? {} : { content: request.content }),
        ...(request.embeds === undefined ? {} : { embeds: request.embeds }),
        ...(request.components === undefined ? {} : { components: request.components }),
      });
    },

    async respondToAutocomplete(request) {
      controls.autocompleteResponses.push({
        interactionId: request.interactionId,
        choices: [...request.choices],
      });
    },

    async deferInteraction(request) {
      controls.deferredInteractions.push(request.interactionId);
    },

    async deferUpdateInteraction(request) {
      controls.deferredUpdates.push(request.interactionId);
    },

    async editInteractionResponse(request) {
      controls.editedInteractions.push({
        token: request.interactionToken,
        ...(request.content === undefined ? {} : { content: request.content }),
        ...(request.embeds === undefined ? {} : { embeds: request.embeds }),
        ...(request.components === undefined ? {} : { components: request.components }),
      });
    },

    async showModal(request) {
      controls.modals.push({
        interactionId: request.interactionId,
        customId: request.customId,
        title: request.title,
      });
    },

    async createVoiceChannel(request) {
      controls.createCalls.push(request);
      if (controls.failNextCreate) {
        const result = controls.failNextCreate;
        delete controls.failNextCreate;
        return result;
      }
      controls.createSequence += 1;
      const id = `9${String(controls.createSequence).padStart(17, "0")}`;
      controls.channels.set(id, {
        id,
        name: request.name,
        type: ChannelTypes.GuildVoice,
        parentId: request.parentId,
        ...(request.userLimit === undefined ? {} : { userLimit: request.userLimit }),
        guildId: request.guildId,
        permissionOverwrites: [],
      });
      return { kind: "found", value: { id } };
    },

    async createGuildChannel(request) {
      controls.guildChannelCreates.push(request);
      if (controls.failNextGuildChannelCreate) {
        const result = controls.failNextGuildChannelCreate;
        delete controls.failNextGuildChannelCreate;
        return result;
      }
      controls.createSequence += 1;
      const id = `9${String(controls.createSequence).padStart(17, "0")}`;
      controls.channels.set(id, {
        id,
        name: request.name,
        type: request.type,
        ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
        ...(request.userLimit === undefined ? {} : { userLimit: request.userLimit }),
        guildId: request.guildId,
        permissionOverwrites: [],
      });
      return { kind: "found", value: { id } };
    },

    async deleteChannel(request) {
      controls.deleteCalls.push({ channelId: request.channelId, requestId: request.requestId });
      if (request.requestId.startsWith("j2c-compensate:") && controls.failCompensationDeletes) {
        return { kind: "transient", message: "compensation_failed" };
      }
      if (controls.failNextDelete) {
        const result = controls.failNextDelete;
        delete controls.failNextDelete;
        return result;
      }
      if (controls.missingChannels.has(request.channelId) || !controls.channels.has(request.channelId)) {
        controls.channels.delete(request.channelId);
        return { kind: "missing" };
      }
      controls.channels.delete(request.channelId);
      return { kind: "ok" };
    },

    async getChannel(request) {
      if (controls.missingChannels.has(request.channelId) || !controls.channels.has(request.channelId)) {
        return { kind: "missing" };
      }
      const channel = controls.channels.get(request.channelId);
      if (!channel) return { kind: "missing" };
      return {
        kind: "found",
        value: {
          id: channel.id,
          name: channel.name,
          ...(channel.type === undefined ? {} : { type: channel.type }),
          ...(channel.userLimit === undefined ? {} : { userLimit: channel.userLimit }),
          ...(channel.bitrate === undefined ? {} : { bitrate: channel.bitrate }),
          ...(channel.nsfw === undefined ? {} : { nsfw: channel.nsfw }),
          ...(channel.rtcRegion === undefined ? {} : { rtcRegion: channel.rtcRegion }),
          ...(channel.status === undefined ? {} : { status: channel.status }),
          permissionOverwrites: [...channel.permissionOverwrites],
        },
      };
    },

    async getGuild(request) {
      const guild = controls.guilds.get(request.guildId);
      if (!guild) {
        return {
          kind: "found",
          value: { id: request.guildId, premiumTier: 0, features: [] },
        };
      }
      return {
        kind: "found",
        value: {
          id: guild.id,
          premiumTier: guild.premiumTier,
          features: [...guild.features],
        },
      };
    },

    async editChannel(request) {
      controls.editCalls.push({
        channelId: request.channelId,
        requestId: request.requestId,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.userLimit === undefined ? {} : { userLimit: request.userLimit }),
        ...(request.bitrate === undefined ? {} : { bitrate: request.bitrate }),
        ...(request.nsfw === undefined ? {} : { nsfw: request.nsfw }),
        ...(request.rtcRegion === undefined ? {} : { rtcRegion: request.rtcRegion }),
        ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
      });
      if (controls.failNextEdit) {
        const result = controls.failNextEdit;
        delete controls.failNextEdit;
        return result;
      }
      const channel = controls.channels.get(request.channelId);
      if (!channel) return { kind: "missing" };
      if (request.name !== undefined) channel.name = request.name;
      if (request.userLimit !== undefined) channel.userLimit = request.userLimit;
      if (request.bitrate !== undefined) channel.bitrate = request.bitrate;
      if (request.nsfw !== undefined) channel.nsfw = request.nsfw;
      if (request.rtcRegion !== undefined) channel.rtcRegion = request.rtcRegion;
      if (request.parentId !== undefined) {
        if (request.parentId === null) {
          delete channel.parentId;
        } else {
          channel.parentId = request.parentId;
        }
      }
      return { kind: "ok" };
    },

    async setChannelVoiceStatus(request) {
      controls.voiceStatusCalls.push({
        channelId: request.channelId,
        requestId: request.requestId,
        status: request.status,
      });
      if (controls.failNextVoiceStatus) {
        const result = controls.failNextVoiceStatus;
        delete controls.failNextVoiceStatus;
        return result;
      }
      const channel = controls.channels.get(request.channelId);
      if (!channel) return { kind: "missing" };
      channel.status = request.status;
      return { kind: "ok" };
    },

    async editChannelPermissionOverwrite(request) {
      controls.overwriteCalls.push({
        channelId: request.channelId,
        overwriteId: request.overwriteId,
        requestId: request.requestId,
        allow: request.allow,
        deny: request.deny,
        type: request.type,
      });
      if (controls.failNextOverwrite) {
        const result = controls.failNextOverwrite;
        delete controls.failNextOverwrite;
        return result;
      }
      const channel = controls.channels.get(request.channelId);
      if (!channel) return { kind: "missing" };
      const next: PermissionOverwrite = {
        id: request.overwriteId,
        type: request.type,
        allow: request.allow,
        deny: request.deny,
      };
      const index = channel.permissionOverwrites.findIndex((overwrite) => overwrite.id === request.overwriteId);
      if (index >= 0) channel.permissionOverwrites[index] = next;
      else channel.permissionOverwrites.push(next);
      return { kind: "ok" };
    },

    async getUser(request) {
      const user = controls.users.get(request.userId);
      if (!user) return { kind: "missing" };
      return { kind: "found", value: user };
    },

    async getCurrentUser() {
      if (!controls.currentUser) return { kind: "missing" };
      return { kind: "found", value: controls.currentUser };
    },

    async getGuildMember(request) {
      const key = `${request.guildId}:${request.userId}`;
      const member = controls.members.get(key);
      if (member) return { kind: "found", value: member };
      const user = controls.users.get(request.userId);
      if (!user) return { kind: "missing" };
      return { kind: "found", value: user };
    },

    async getUserVoiceChannel(request) {
      const key = `${request.guildId}:${request.userId}`;
      if (!controls.voiceByUser.has(key)) {
        return { kind: "found", value: { channelId: null } };
      }
      const muted = controls.serverMuteByUser.get(key);
      return {
        kind: "found",
        value: {
          channelId: controls.voiceByUser.get(key) ?? null,
          ...(muted === undefined ? {} : { serverMuted: muted }),
        },
      };
    },

    async moveMemberToChannel(request) {
      controls.moveCalls.push({
        guildId: request.guildId,
        userId: request.userId,
        channelId: request.channelId,
        requestId: request.requestId,
      });
      if (controls.failNextMove) {
        const result = controls.failNextMove;
        delete controls.failNextMove;
        return result;
      }
      controls.voiceByUser.set(`${request.guildId}:${request.userId}`, request.channelId);
      return { kind: "ok" };
    },

    async setMemberServerMute(request) {
      controls.muteCalls.push({
        guildId: request.guildId,
        userId: request.userId,
        mute: request.mute,
        requestId: request.requestId,
      });
      if (controls.failNextMute) {
        const result = controls.failNextMute;
        delete controls.failNextMute;
        return result;
      }
      controls.serverMuteByUser.set(`${request.guildId}:${request.userId}`, request.mute);
      return { kind: "ok" };
    },

    async sendDirectMessage(request) {
      controls.dmCalls.push({
        userId: request.userId,
        content: request.content,
        requestId: request.requestId,
      });
      return { kind: "ok" };
    },

    async sendChannelMessage(request) {
      if (controls.failNextSendMessage) {
        const result = controls.failNextSendMessage;
        delete controls.failNextSendMessage;
        return result;
      }
      controls.messageSequence += 1;
      const id = `8${String(controls.messageSequence).padStart(17, "0")}`;
      controls.channelMessages.push({
        channelId: request.channelId,
        id,
        ...(request.content === undefined ? {} : { content: request.content }),
        ...(request.embeds === undefined ? {} : { embeds: request.embeds }),
        ...(request.components === undefined ? {} : { components: request.components }),
        ...(request.flags === undefined ? {} : { flags: request.flags }),
      });
      return { kind: "found", value: { id } };
    },

    async editChannelMessage(request) {
      controls.editedChannelMessages.push({
        channelId: request.channelId,
        messageId: request.messageId,
        ...(request.content === undefined ? {} : { content: request.content }),
        ...(request.embeds === undefined ? {} : { embeds: request.embeds }),
        ...(request.components === undefined ? {} : { components: request.components }),
        ...(request.flags === undefined ? {} : { flags: request.flags }),
      });
      if (controls.failNextEditMessage) {
        const result = controls.failNextEditMessage;
        delete controls.failNextEditMessage;
        return result;
      }
      return { kind: "ok" };
    },

    async deleteChannelMessage(request) {
      controls.deletedChannelMessages.push({
        channelId: request.channelId,
        messageId: request.messageId,
        requestId: request.requestId,
      });
      return { kind: "ok" };
    },
  };

  return { discord, controls };
}
