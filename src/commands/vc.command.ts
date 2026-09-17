import {
  ApplicationCommandOptionTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";
import { failureResponse } from "../lib/j2c/action-response.ts";

const memberOption = {
  type: ApplicationCommandOptionTypes.User,
  name: "member",
  description: "Target member",
  required: true,
} as const;

const vcCommandData: CreateApplicationCommand = {
  name: "vc",
  description: "Manage your temporary voice channel",
  options: [
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
          name: "limit",
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
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "hide",
      description: "Hide the channel from @everyone",
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "unhide",
      description: "Show the channel to @everyone again",
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "permit",
      description: "Allow a member to view and join your channel",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "reject",
      description: "Deny a member from this channel and disconnect them",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "block",
      description: "Add a member to your persistent block list",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "unblock",
      description: "Remove a member from your persistent block list",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "block-list",
      description: "Show your persistent block list for this server",
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "mute",
      description: "Server mute a member in your temporary channel",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "unmute",
      description: "Remove server mute from a member in your temporary channel",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "transfer",
      description: "Transfer ownership to a connected member",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "invite",
      description: "DM a member an invite link to this channel",
      options: [memberOption],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "info",
      description: "Show details about this temporary channel",
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "delete",
      description: "Delete your temporary voice channel",
    },
  ],
};

const vcCommand: CommandModule = {
  data: vcCommandData,
  cooldownMs: 1_000,
  async execute(context, interaction) {
    if (!context.vc) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        embeds: failureResponse("Voice channel management is not ready yet.").embeds,
        ephemeral: true,
      });
      return;
    }
    await context.vc.execute(interaction);
  },
};

export default vcCommand;
