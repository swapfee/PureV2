import type {
  CreateVoiceChannelRequest,
  DiscordApiPort,
  DiscordOperationResult,
  DiscordValueResult,
  PermissionOverwrite,
} from "../runtime-types.ts";

export interface FakeDiscordChannel {
  id: string;
  name: string;
  parentId?: string;
  userLimit?: number;
  guildId: string;
  permissionOverwrites: PermissionOverwrite[];
}

export interface FakeDiscordControls {
  readonly channels: Map<string, FakeDiscordChannel>;
  readonly voiceByUser: Map<string, string | null>;
  readonly users: Map<string, { id: string; bot: boolean }>;
  readonly createCalls: CreateVoiceChannelRequest[];
  readonly deleteCalls: { channelId: string; requestId: string }[];
  readonly moveCalls: { guildId: string; userId: string; channelId: string; requestId: string }[];
  readonly editCalls: { channelId: string; requestId: string; name?: string; userLimit?: number }[];
  readonly overwriteCalls: {
    channelId: string;
    overwriteId: string;
    requestId: string;
    allow: string;
    deny: string;
    type: 0 | 1;
  }[];
  readonly deferredInteractions: string[];
  readonly editedInteractions: { token: string; content: string }[];
  readonly responses: { interactionId: string; content: string }[];
  failNextCreate?: DiscordValueResult<{ id: string }>;
  failNextMove?: DiscordOperationResult;
  failNextDelete?: DiscordOperationResult;
  failNextEdit?: DiscordOperationResult;
  failNextOverwrite?: DiscordOperationResult;
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
    voiceByUser: seed?.voiceByUser ?? new Map(),
    users: seed?.users ?? new Map(),
    createCalls: [],
    deleteCalls: [],
    moveCalls: [],
    editCalls: [],
    overwriteCalls: [],
    deferredInteractions: [],
    editedInteractions: [],
    responses: [],
    missingChannels: seed?.missingChannels ?? new Set(),
    createSequence: seed?.createSequence ?? 0,
    ...(seed?.failNextCreate === undefined ? {} : { failNextCreate: seed.failNextCreate }),
    ...(seed?.failNextMove === undefined ? {} : { failNextMove: seed.failNextMove }),
    ...(seed?.failNextDelete === undefined ? {} : { failNextDelete: seed.failNextDelete }),
    ...(seed?.failNextEdit === undefined ? {} : { failNextEdit: seed.failNextEdit }),
    ...(seed?.failNextOverwrite === undefined ? {} : { failNextOverwrite: seed.failNextOverwrite }),
    ...(seed?.failCompensationDeletes === undefined
      ? {}
      : { failCompensationDeletes: seed.failCompensationDeletes }),
  };

  const discord: DiscordApiPort = {
    async respondToInteraction(request) {
      controls.responses.push({ interactionId: request.interactionId, content: request.content });
    },

    async deferInteraction(request) {
      controls.deferredInteractions.push(request.interactionId);
    },

    async editInteractionResponse(request) {
      controls.editedInteractions.push({ token: request.interactionToken, content: request.content });
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
        parentId: request.parentId,
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
          ...(channel.userLimit === undefined ? {} : { userLimit: channel.userLimit }),
          permissionOverwrites: [...channel.permissionOverwrites],
        },
      };
    },

    async editChannel(request) {
      controls.editCalls.push({
        channelId: request.channelId,
        requestId: request.requestId,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.userLimit === undefined ? {} : { userLimit: request.userLimit }),
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

    async getUserVoiceChannel(request) {
      const key = `${request.guildId}:${request.userId}`;
      if (!controls.voiceByUser.has(key)) {
        return { kind: "found", value: { channelId: null } };
      }
      return { kind: "found", value: { channelId: controls.voiceByUser.get(key) ?? null } };
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
  };

  return { discord, controls };
}
