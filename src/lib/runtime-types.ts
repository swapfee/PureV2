export interface InteractionOption {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
  readonly options?: readonly InteractionOption[];
}

export interface InteractionCreatePayload {
  readonly id: string;
  readonly token: string;
  readonly type: number;
  readonly applicationId: string;
  readonly guildId?: string;
  readonly channelId?: string;
  readonly userId: string;
  readonly memberPermissions?: string;
  readonly commandName?: string;
  readonly options?: readonly InteractionOption[];
}

export interface VoiceStateUpdatePayload {
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string | null;
  readonly isBot?: boolean;
}

export interface ReadyPayload {
  readonly shardId: number;
  readonly applicationId: string;
  readonly guildIds: readonly string[];
}

export interface RuntimeEventMap {
  readonly interactionCreate: InteractionCreatePayload;
  readonly ready: ReadyPayload;
  readonly voiceStateUpdate: VoiceStateUpdatePayload;
}

export type RuntimeEventName = keyof RuntimeEventMap;

export interface InteractionResponseRequest {
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly content: string;
  readonly ephemeral?: boolean;
}

export interface PermissionOverwrite {
  readonly id: string;
  readonly type: 0 | 1;
  readonly allow: string;
  readonly deny: string;
}

export interface DiscordChannelDetails {
  readonly id: string;
  readonly name?: string;
  readonly type?: number;
  readonly userLimit?: number;
  readonly permissionOverwrites?: readonly PermissionOverwrite[];
}

export type DiscordOperationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "missing" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "transient"; readonly message: string };

export type DiscordValueResult<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "transient"; readonly message: string };

export interface CreateVoiceChannelRequest {
  readonly guildId: string;
  readonly name: string;
  readonly parentId: string;
  readonly userLimit?: number;
  readonly requestId: string;
  readonly reason?: string;
}

export interface CreateGuildChannelRequest {
  readonly guildId: string;
  readonly name: string;
  readonly type: number;
  readonly parentId?: string;
  readonly userLimit?: number;
  readonly requestId: string;
  readonly reason?: string;
}

export interface DiscordApiPort {
  respondToInteraction(request: InteractionResponseRequest): Promise<void>;
  deferInteraction(request: {
    readonly interactionId: string;
    readonly interactionToken: string;
    readonly ephemeral?: boolean;
  }): Promise<void>;
  editInteractionResponse(request: {
    readonly applicationId: string;
    readonly interactionToken: string;
    readonly content: string;
  }): Promise<void>;
  createVoiceChannel(
    request: CreateVoiceChannelRequest,
  ): Promise<DiscordValueResult<{ readonly id: string }>>;
  createGuildChannel(
    request: CreateGuildChannelRequest,
  ): Promise<DiscordValueResult<{ readonly id: string }>>;
  deleteChannel(request: {
    readonly channelId: string;
    readonly requestId: string;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
  getChannel(request: {
    readonly channelId: string;
  }): Promise<DiscordValueResult<DiscordChannelDetails>>;
  editChannel(request: {
    readonly channelId: string;
    readonly requestId: string;
    readonly name?: string;
    readonly userLimit?: number;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
  editChannelPermissionOverwrite(request: {
    readonly channelId: string;
    readonly overwriteId: string;
    readonly type: 0 | 1;
    readonly allow: string;
    readonly deny: string;
    readonly requestId: string;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
  getUser(request: {
    readonly userId: string;
  }): Promise<DiscordValueResult<{ readonly id: string; readonly bot: boolean }>>;
  getUserVoiceChannel(request: {
    readonly guildId: string;
    readonly userId: string;
  }): Promise<DiscordValueResult<{ readonly channelId: string | null }>>;
  moveMemberToChannel(request: {
    readonly guildId: string;
    readonly userId: string;
    readonly channelId: string;
    readonly requestId: string;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
}
