import type { CommandRegistry, EventContext, EventRegistry, InteractionDispatcher } from "../../handlers/types.ts";
import type { CooldownStore } from "../../handlers/cooldowns.ts";
import { failureResponse } from "../j2c/action-response.ts";
import { cooldownFailureMessage } from "../discord-timestamp.ts";
import type { Logger } from "../logger.ts";
import type {
  DiscordApiPort,
  InteractionCreatePayload,
  InteractionOption,
  ReadyPayload,
  VoiceStateUpdatePayload,
} from "../runtime-types.ts";
import type { WorkerBot } from "./bot.ts";

function bigintToSnowflake(value: bigint | undefined): string | undefined {
  return value === undefined ? undefined : value.toString();
}

/**
 * Discordeno transforms interaction member permissions into a Permissions object
 * with a bigint `bitfield` (and toJSON()). Accept raw strings/bigints too.
 */
export function extractMemberPermissionBits(raw: unknown): string | undefined {
  if (typeof raw === "bigint" || typeof raw === "number" || typeof raw === "string") {
    return String(raw);
  }
  if (typeof raw !== "object" || raw === null) return undefined;

  const bitfield = Reflect.get(raw, "bitfield");
  if (typeof bitfield === "bigint" || typeof bitfield === "number" || typeof bitfield === "string") {
    return String(bitfield);
  }

  const toJSON = Reflect.get(raw, "toJSON");
  if (typeof toJSON === "function") {
    try {
      const json: unknown = toJSON.call(raw);
      if (typeof json === "bigint" || typeof json === "number" || typeof json === "string") {
        return String(json);
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function mapInteractionOption(option: {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
  readonly focused?: boolean;
  readonly options?: readonly {
    readonly name: string;
    readonly type: number;
    readonly value?: string | number | boolean;
    readonly focused?: boolean;
    readonly options?: readonly {
      readonly name: string;
      readonly type: number;
      readonly value?: string | number | boolean;
      readonly focused?: boolean;
    }[];
  }[];
}): InteractionOption {
  const mapped: InteractionOption = {
    name: option.name,
    type: option.type,
    ...(option.focused === undefined ? {} : { focused: option.focused }),
  };
  const withValue = option.value === undefined ? mapped : { ...mapped, value: option.value };
  if (!option.options) return withValue;
  return {
    ...withValue,
    options: option.options.map((nested) => mapInteractionOption(nested)),
  };
}

function extractModalComponentValues(
  components: readonly {
    readonly customId?: string;
    readonly value?: string;
    readonly components?: readonly {
      readonly customId?: string;
      readonly value?: string;
      readonly components?: readonly {
        readonly customId?: string;
        readonly value?: string;
      }[];
    }[];
  }[] | undefined,
): Record<string, string> | undefined {
  if (!components || components.length === 0) return undefined;
  const values: Record<string, string> = {};
  const visit = (nodes: typeof components): void => {
    for (const node of nodes) {
      if (node.customId !== undefined && node.value !== undefined) {
        values[node.customId] = node.value;
      }
      if (node.components) visit(node.components);
    }
  };
  visit(components);
  return Object.keys(values).length > 0 ? values : undefined;
}

export function createInteractionDispatcher(
  commands: CommandRegistry,
  cooldowns: CooldownStore,
  workerId: number,
  logger: Logger,
  discord: DiscordApiPort,
  services?: {
    readonly vc?: { execute(interaction: InteractionCreatePayload): Promise<void> };
    readonly setup?: {
      execute(interaction: InteractionCreatePayload): Promise<void>;
    };
    readonly voicePanel?: {
      handles(interaction: InteractionCreatePayload): boolean;
      execute(interaction: InteractionCreatePayload): Promise<void>;
    };
  },
): InteractionDispatcher {
  return {
    async dispatch(interaction: InteractionCreatePayload): Promise<void> {
      if (services?.voicePanel?.handles(interaction)) {
        await services.voicePanel.execute(interaction);
        return;
      }

      // Application command autocomplete (type 4) — no cooldown, no defer.
      if (interaction.type === 4) {
        await discord.respondToAutocomplete({
          interactionId: interaction.id,
          interactionToken: interaction.token,
          choices: [],
        });
        return;
      }

      if (!interaction.commandName) return;
      const command = commands.get(interaction.commandName);
      if (!command) {
        logger.warn("Unknown command", { commandName: interaction.commandName });
        return;
      }

      if (command.cooldownMs !== undefined) {
        const key = `${interaction.commandName}:${interaction.userId}`;
        const decision = cooldowns.check(key, command.cooldownMs);
        if (!decision.allowed) {
          await discord.respondToInteraction({
            interactionId: interaction.id,
            interactionToken: interaction.token,
            embeds: failureResponse(cooldownFailureMessage(decision.remainingMs)).embeds,
            ephemeral: true,
          });
          return;
        }
      }

      await command.execute(
        {
          workerId,
          logger,
          discord,
          ...(services?.vc ? { vc: services.vc } : {}),
          ...(services?.setup ? { setup: services.setup } : {}),
        },
        interaction,
      );
    },
  };
}

export function wireBotEvents(
  bot: WorkerBot,
  events: EventRegistry,
  context: EventContext,
): void {
  bot.events.ready = async (payload) => {
    const event = events.get("ready");
    if (!event) return;
    const readyPayload: ReadyPayload = {
      shardId: payload.shardId,
      applicationId: payload.applicationId.toString(),
      guildIds: payload.guilds.map((guildId) => guildId.toString()),
    };
    await event.execute(context, readyPayload);
  };

  bot.events.interactionCreate = async (interaction) => {
    const event = events.get("interactionCreate");
    if (!event) return;

    const userId = interaction.user?.id ?? interaction.member?.id;
    if (userId === undefined) {
      context.logger.warn("interactionCreate missing user id");
      return;
    }

    const options: InteractionOption[] | undefined = interaction.data?.options?.map((option) =>
      mapInteractionOption(option),
    );

    const memberPermissions = extractMemberPermissionBits(
      Reflect.get(interaction.member ?? {}, "permissions"),
    );

    const customId = interaction.data?.customId;
    const componentValues = extractModalComponentValues(interaction.data?.components);
    const selectedUserIds = interaction.data?.values;
    const targetIdRaw = Reflect.get(interaction.data ?? {}, "targetId");
    const targetUserId =
      typeof targetIdRaw === "bigint" || typeof targetIdRaw === "number" || typeof targetIdRaw === "string"
        ? String(targetIdRaw)
        : undefined;
    const messageRaw = Reflect.get(interaction, "message");
    const messageIdRaw =
      typeof messageRaw === "object" && messageRaw !== null
        ? Reflect.get(messageRaw, "id")
        : undefined;
    const messageId =
      typeof messageIdRaw === "bigint" ||
      typeof messageIdRaw === "number" ||
      typeof messageIdRaw === "string"
        ? String(messageIdRaw)
        : undefined;

    const payload: InteractionCreatePayload = {
      id: interaction.id.toString(),
      token: interaction.token,
      type: interaction.type,
      applicationId: interaction.applicationId.toString(),
      userId: userId.toString(),
      ...(interaction.guildId === undefined ? {} : { guildId: interaction.guildId.toString() }),
      ...(interaction.channelId === undefined ? {} : { channelId: interaction.channelId.toString() }),
      ...(interaction.data?.name === undefined ? {} : { commandName: interaction.data.name }),
      ...(options === undefined ? {} : { options }),
      ...(memberPermissions === undefined ? {} : { memberPermissions }),
      ...(customId === undefined ? {} : { customId }),
      ...(componentValues === undefined ? {} : { componentValues }),
      ...(selectedUserIds === undefined ? {} : { selectedUserIds }),
      ...(targetUserId === undefined ? {} : { targetUserId }),
      ...(messageId === undefined ? {} : { messageId }),
    };

    await event.execute(context, payload);
  };

  bot.events.voiceStateUpdate = async (voiceState) => {
    const event = events.get("voiceStateUpdate");
    if (!event) return;
    const displayNameRaw = Reflect.get(voiceState, "displayName");
    const memberIsBot = Reflect.get(voiceState, "memberIsBot") === true;
    const member = Reflect.get(voiceState, "member");
    const memberUser =
      typeof member === "object" && member !== null ? Reflect.get(member, "user") : undefined;
    const isBot =
      memberIsBot ||
      (typeof memberUser === "object" &&
        memberUser !== null &&
        Reflect.get(memberUser, "bot") === true);
    const payload: VoiceStateUpdatePayload = {
      guildId: voiceState.guildId.toString(),
      userId: voiceState.userId.toString(),
      channelId: voiceState.channelId === undefined ? null : voiceState.channelId.toString(),
      ...(isBot ? { isBot: true } : {}),
      ...(typeof displayNameRaw === "string" && displayNameRaw.trim().length > 0
        ? { displayName: displayNameRaw.trim() }
        : {}),
    };
    await event.execute(context, payload);
  };

  bot.events.guildCreate = (guild) => {
    if (!context.j2c) return;
    const guildId = guild.id.toString();
    const voiceStatesRaw = Reflect.get(guild, "voiceStates");
    const seeded: { userId: string; channelId: string | null }[] = [];
    if (voiceStatesRaw && typeof voiceStatesRaw === "object") {
      const values =
        typeof Reflect.get(voiceStatesRaw, "values") === "function"
          ? [...(voiceStatesRaw as Map<unknown, { userId?: bigint; channelId?: bigint }>).values()]
          : Array.isArray(voiceStatesRaw)
            ? voiceStatesRaw
            : [];
      for (const state of values) {
        if (typeof state !== "object" || state === null) continue;
        const userId = Reflect.get(state, "userId");
        const channelId = Reflect.get(state, "channelId");
        if (userId === undefined) continue;
        seeded.push({
          userId: String(userId),
          channelId: channelId === undefined || channelId === null ? null : String(channelId),
        });
      }
    }
    context.j2c.occupancy.seedGuildVoiceStates(guildId, seeded);
    context.j2c.occupancy.markReady();
    // Restart: empty temp channels get no leave event — schedule deletion from the seed.
    void context.j2c.scheduleEmptyChannelDeletions(guildId).catch((error: unknown) => {
      context.logger.error("Failed to schedule empty-channel deletions after guild seed", {
        guildId,
        error,
      });
    });
    context.j2c.scheduleEmptyChannelDeletionResweep(guildId);
  };
}

export { bigintToSnowflake };
