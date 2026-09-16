import {
  ApplicationCommandOptionTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";

const vcCommandData: CreateApplicationCommand = {
  name: "vc",
  description: "Manage your temporary voice channel",
  options: [
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "invite",
      description: "Allow a member to view and join your channel",
      options: [
        {
          type: ApplicationCommandOptionTypes.User,
          name: "user",
          description: "Member to invite",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "rename",
      description: "Rename your temporary channel",
      options: [
        {
          type: ApplicationCommandOptionTypes.String,
          name: "name",
          description: "New channel name",
          required: true,
          minLength: 1,
          maxLength: 100,
        },
      ],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "limit",
      description: "Set the voice channel user limit (0 = unlimited)",
      options: [
        {
          type: ApplicationCommandOptionTypes.Integer,
          name: "amount",
          description: "User limit from 0 to 99",
          required: true,
          minValue: 0,
          maxValue: 99,
        },
      ],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "lock",
      description: "Prevent @everyone from joining",
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "unlock",
      description: "Allow @everyone to join again",
    },
  ],
};

const vcCommand: CommandModule = {
  data: vcCommandData,
  async execute(context, interaction) {
    if (!context.vc) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        content: "Voice channel management is not ready yet.",
        ephemeral: true,
      });
      return;
    }
    await context.vc.execute(interaction);
  },
};

export default vcCommand;
