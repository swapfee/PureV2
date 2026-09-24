export interface InteractionOption {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
  readonly focused?: boolean;
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
  /** Message component / modal custom id. */
  readonly customId?: string;
  /** Modal text inputs or select values. */
  readonly componentValues?: Readonly<Record<string, string>>;
  readonly selectedUserIds?: readonly string[];
  /** Target user for user-context-menu commands. */
  readonly targetUserId?: string;
  /** Message id for component interactions (button/select on a channel message). */
  readonly messageId?: string;
}

export interface VoiceStateUpdatePayload {
  readonly guildId: string;
  readonly userId: string;
  readonly channelId: string | null;
  readonly isBot?: boolean;
  /** Guild nick, global display name, or username when available from the event. */
  readonly displayName?: string;
  /** Discord Gateway sequence used to reject delayed older transitions. */
  readonly gatewaySequence?: number;
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

export interface InteractionEmbed {
  readonly description: string;
  readonly color?: number;
  readonly title?: string;
}

export interface InteractionFile {
  readonly name: string;
  readonly contentType: "image/png";
  readonly data: Uint8Array;
}

export interface InteractionResponseRequest {
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly content?: string;
  readonly embeds?: readonly InteractionEmbed[];
  readonly components?: readonly unknown[];
  readonly flags?: number;
  readonly ephemeral?: boolean;
}

export interface AutocompleteChoice {
  readonly name: string;
  readonly value: string;
}

export interface AutocompleteResponseRequest {
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly choices: readonly AutocompleteChoice[];
}

export interface EditInteractionResponseRequest {
  readonly applicationId: string;
  readonly interactionToken: string;
  readonly content?: string;
  readonly embeds?: readonly InteractionEmbed[];
  readonly components?: readonly unknown[];
  readonly flags?: number;
  readonly files?: readonly InteractionFile[];
  readonly requestId?: string;
}

export interface ShowModalRequest {
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly title: string;
  readonly customId: string;
  readonly components: readonly unknown[];
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
  /** Discord sort position within the channel's category/group. */
  readonly position?: number;
  readonly userLimit?: number;
  readonly bitrate?: number;
  readonly nsfw?: boolean;
  readonly rtcRegion?: string | null;
  /** Voice channel status text (not topic/name). */
  readonly status?: string | null;
  readonly permissionOverwrites?: readonly PermissionOverwrite[];
}

export interface DiscordGuildDetails {
  readonly id: string;
  readonly name?: string;
  readonly premiumTier: number;
  readonly features: readonly string[];
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
  respondToAutocomplete(request: AutocompleteResponseRequest): Promise<void>;
  deferInteraction(request: {
    readonly interactionId: string;
    readonly interactionToken: string;
    readonly ephemeral?: boolean;
  }): Promise<void>;
  deferUpdateInteraction(request: {
    readonly interactionId: string;
    readonly interactionToken: string;
  }): Promise<void>;
  editInteractionResponse(request: EditInteractionResponseRequest): Promise<void>;
  showModal(request: ShowModalRequest): Promise<void>;
  createVoiceChannel(
    request: CreateVoiceChannelRequest,
  ): Promise<DiscordValueResult<{ readonly id: string }>>;
  setGuildChannelPosition(request: {
    readonly guildId: string;
    readonly channelId: string;
    readonly position: number;
    readonly requestId: string;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
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
  getGuild(request: {
    readonly guildId: string;
  }): Promise<DiscordValueResult<DiscordGuildDetails>>;
  editChannel(request: {
    readonly channelId: string;
    readonly requestId: string;
    readonly name?: string;
    readonly userLimit?: number;
    readonly bitrate?: number;
    readonly nsfw?: boolean;
    readonly rtcRegion?: string | null;
    readonly parentId?: string | null;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
  /** Sets or clears the voice channel status (separate from topic/name). */
  setChannelVoiceStatus(request: {
    readonly channelId: string;
    readonly requestId: string;
    readonly status: string | null;
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
  }): Promise<
    DiscordValueResult<{
      readonly id: string;
      readonly bot: boolean;
      readonly username?: string;
      readonly globalName?: string;
    }>
  >;
  getCurrentUser(): Promise<
    DiscordValueResult<{
      readonly id: string;
      readonly username: string;
    }>
  >;
  getGuildMember(request: {
    readonly guildId: string;
    readonly userId: string;
  }): Promise<
    DiscordValueResult<{
      readonly id: string;
      readonly nick?: string;
      readonly username?: string;
      readonly globalName?: string;
      readonly avatarUrl?: string;
      readonly bot: boolean;
    }>
  >;
  getUserVoiceChannel(request: {
    readonly guildId: string;
    readonly userId: string;
  }): Promise<
    DiscordValueResult<{
      readonly channelId: string | null;
      /** Server mute when the member has a voice state; omit when unknown. */
      readonly serverMuted?: boolean;
    }>
  >;
  moveMemberToChannel(request: {
    readonly guildId: string;
    readonly userId: string;
    readonly channelId: string | null;
    readonly requestId: string;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
  setMemberServerMute(request: {
    readonly guildId: string;
    readonly userId: string;
    readonly mute: boolean;
    readonly requestId: string;
    readonly reason?: string;
  }): Promise<DiscordOperationResult>;
  sendDirectMessage(request: {
    readonly userId: string;
    readonly content: string;
    readonly requestId: string;
  }): Promise<DiscordOperationResult>;
  sendChannelMessage(request: {
    readonly channelId: string;
    readonly requestId: string;
    readonly content?: string;
    readonly embeds?: readonly InteractionEmbed[];
    readonly components?: readonly unknown[];
    readonly flags?: number;
  }): Promise<DiscordValueResult<{ readonly id: string }>>;
  editChannelMessage(request: {
    readonly channelId: string;
    readonly messageId: string;
    readonly requestId: string;
    readonly content?: string;
    readonly embeds?: readonly InteractionEmbed[];
    readonly components?: readonly unknown[];
    readonly flags?: number;
  }): Promise<DiscordOperationResult>;
  deleteChannelMessage(request: {
    readonly channelId: string;
    readonly messageId: string;
    readonly requestId: string;
  }): Promise<DiscordOperationResult>;
}
