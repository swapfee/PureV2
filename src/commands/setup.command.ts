import {
  ApplicationCommandOptionTypes,
  ChannelTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";

const setupCommandData: CreateApplicationCommand = {
  name: "setup",
  description: "Configure Join-to-Create for this server",
  options: [
    {
      type: ApplicationCommandOptionTypes.Channel,
      name: "lobby",
      description: "Voice channel members join to create a temporary channel",
      required: true,
      channelTypes: [ChannelTypes.GuildVoice],
    },
    {
      type: ApplicationCommandOptionTypes.Channel,
      name: "category",
      description: "Category where temporary channels are created",
      required: true,
      channelTypes: [ChannelTypes.GuildCategory],
    },
    {
      type: ApplicationCommandOptionTypes.String,
      name: "template",
      description: "Channel name template (default: {username}'s Channel)",
      required: false,
      minLength: 1,
      maxLength: 100,
    },
    {
      type: ApplicationCommandOptionTypes.Integer,
      name: "limit",
      description: "Default user limit for new channels (0 = unlimited)",
      required: false,
      minValue: 0,
      maxValue: 99,
    },
    {
      type: ApplicationCommandOptionTypes.Boolean,
      name: "enabled",
      description: "Enable Join-to-Create (default: true)",
      required: false,
    },
    {
      type: ApplicationCommandOptionTypes.Role,
      name: "moderator_role",
      description: "Optional moderator role for J2C management",
      required: false,
    },
  ],
};

const setupCommand: CommandModule = {
  data: setupCommandData,
  cooldownMs: 5_000,
  async execute(context, interaction) {
    if (!context.setup) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        content: "Setup is not ready yet.",
        ephemeral: true,
      });
      return;
    }
    await context.setup.execute(interaction);
  },
};

export default setupCommand;
