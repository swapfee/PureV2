import type {
  AutocompleteChoice,
  DiscordApiPort,
  InteractionCreatePayload,
  InteractionOption,
} from "../runtime-types.ts";
import type { GuildConfigRepository } from "./repositories.ts";

const MAX_AUTOCOMPLETE_CHOICES = 25;

function optionValue(
  options: readonly InteractionOption[] | undefined,
  name: string,
): string | number | boolean | undefined {
  return options?.find((option) => option.name === name)?.value;
}

/** Whether this interaction is autocomplete for the Join-to-Create lobby picker. */
export function isJoinToCreateLobbyAutocomplete(interaction: InteractionCreatePayload): boolean {
  if (interaction.commandName === "reset") {
    return interaction.options?.some((option) => option.name === "channel" && option.focused) ?? false;
  }
  if (interaction.commandName === "setup") {
    const configSub = interaction.options?.find((option) => option.name === "config");
    return (
      configSub?.options?.some((option) => option.name === "channel" && option.focused) ?? false
    );
  }
  return false;
}

export function readJoinToCreateLobbyAutocompleteQuery(
  interaction: InteractionCreatePayload,
): string {
  if (interaction.commandName === "reset") {
    const raw = optionValue(interaction.options, "channel");
    return typeof raw === "string" ? raw : "";
  }
  if (interaction.commandName === "setup") {
    const configSub = interaction.options?.find((option) => option.name === "config");
    const raw = optionValue(configSub?.options, "channel");
    return typeof raw === "string" ? raw : "";
  }
  return "";
}

export async function buildJoinToCreateLobbyAutocompleteChoices(input: {
  readonly guildId: string;
  readonly query: string;
  readonly configs: GuildConfigRepository;
  readonly discord: DiscordApiPort;
}): Promise<readonly AutocompleteChoice[]> {
  const config = await input.configs.findByGuildId(input.guildId);
  if (!config) {
    return [];
  }

  const channel = await input.discord.getChannel({ channelId: config.lobbyChannelId });
  const displayName =
    channel.kind === "found" && channel.value.name && channel.value.name.trim().length > 0
      ? channel.value.name.trim()
      : "Join to Create";

  const needle = input.query.trim().toLowerCase();
  if (
    needle.length > 0 &&
    !displayName.toLowerCase().includes(needle) &&
    !config.lobbyChannelId.includes(needle)
  ) {
    return [];
  }

  return [
    {
      name: displayName.slice(0, 100),
      value: config.lobbyChannelId,
    },
  ].slice(0, MAX_AUTOCOMPLETE_CHOICES);
}
