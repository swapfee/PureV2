import {
  ApplicationCommandOptionTypes,
  ChannelTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";
import { failureResponse } from "../lib/j2c/action-response.ts";

/**
 * Discord requires a subcommand whenever any subcommand exists, so the
 * automatic install path is `/setup` with no nested options via the `create`
 * subcommand (shown first). Config remains `/setup config`.
 */
const setupCommandData: CreateApplicationCommand = {
  name: "setup",
  description: "Set up or configure Join to Create for this server",
  options: [
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "create",
      description: "Automatically create a category and Join to Create channel",
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "config",
      description: "Modify an existing setup's settings",
      options: [
        {
          type: ApplicationCommandOptionTypes.Boolean,
          name: "editable",
          description: "Do you want the channel to be editable by the user?",
          required: false,
        },
        {
          type: ApplicationCommandOptionTypes.String,
          name: "name",
          description:
            "Temp channel name template (use {username} for display name / username)",
          required: false,
          minLength: 1,
          maxLength: 100,
        },
        {
          type: ApplicationCommandOptionTypes.Integer,
          name: "limit",
          description: "User limit for created channels (0-99)",
          required: false,
          minValue: 0,
          maxValue: 99,
        },
        {
          type: ApplicationCommandOptionTypes.Channel,
          name: "category",
          description: "The category you want temporary channels created in",
          required: false,
          channelTypes: [ChannelTypes.GuildCategory],
        },
        {
          type: ApplicationCommandOptionTypes.String,
          name: "permission",
          description: "Copy category permissions or Join to Create permissions?",
          required: false,
          choices: [
            { name: "Category", value: "category" },
            { name: "Join to Create", value: "lobby" },
          ],
        },
      ],
    },
  ],
};

const setupCommand: CommandModule = {
  data: setupCommandData,
  cooldownMs: 30_000,
  async execute(context, interaction) {
    if (!context.setup) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        embeds: failureResponse("Setup is currently unavailable.").embeds,
        ephemeral: true,
      });
      return;
    }
    await context.setup.execute(interaction);
  },
};

export default setupCommand;
