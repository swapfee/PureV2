import {
  ApplicationCommandOptionTypes,
  ChannelTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";
import { failureResponse } from "../lib/j2c/action-response.ts";

const setupCommandData: CreateApplicationCommand = {
  name: "setup",
  description: "Configure Join-to-Create for this server",
  options: [
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "automatic",
      description: "Automatically create a category and Join to Create channel",
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "default",
      description: "Create a Join to Create channel with username-based names",
      options: [
        {
          type: ApplicationCommandOptionTypes.Boolean,
          name: "editable",
          description: "Do you want the channel to be editable by the user?",
          required: true,
        },
        {
          type: ApplicationCommandOptionTypes.Channel,
          name: "category",
          description: "The category you want the channels to be created in",
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
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "sequence",
      description: "Create sequential channels that increment as more are made",
      options: [
        {
          type: ApplicationCommandOptionTypes.String,
          name: "name",
          description: "Base name for sequential channels",
          required: true,
          minLength: 1,
          maxLength: 100,
        },
        {
          type: ApplicationCommandOptionTypes.Integer,
          name: "limit",
          description: "User limit for created channels (0-99)",
          required: true,
          minValue: 0,
          maxValue: 99,
        },
        {
          type: ApplicationCommandOptionTypes.Boolean,
          name: "editable",
          description: "Do you want the channel to be editable by the user?",
          required: true,
        },
        {
          type: ApplicationCommandOptionTypes.Channel,
          name: "category",
          description: "The category you want the channels to be created in",
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
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "config",
      description: "Modify an existing setup's settings",
      options: [
        {
          type: ApplicationCommandOptionTypes.String,
          name: "channel",
          description: "The Join to Create channel to configure",
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionTypes.Boolean,
          name: "editable",
          description: "Do you want the channel to be editable by the user?",
          required: false,
        },
        {
          type: ApplicationCommandOptionTypes.String,
          name: "name",
          description: "Base name for sequential channels",
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
          description: "The category you want the channels to be created in",
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
