import {
  ApplicationCommandOptionTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";
import { failureResponse } from "../lib/j2c/action-response.ts";
import {
  VOICE_BITRATE_MIN_KBPS,
  VOICE_REGION_OPTIONS,
  VOICE_STATUS_MAX_LENGTH,
} from "../lib/j2c/voice-channel-settings.ts";

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
      name: "bitrate",
      description: "Set the voice channel bitrate (kbps), limited by server boost level",
      options: [
        {
          type: ApplicationCommandOptionTypes.Integer,
          name: "kbps",
          description: `Bitrate in kbps (${VOICE_BITRATE_MIN_KBPS}–384, capped by boost level)`,
          required: true,
          minValue: VOICE_BITRATE_MIN_KBPS,
          maxValue: 384,
        },
      ],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "status",
      description: "Set or clear the voice channel status",
      options: [
        {
          type: ApplicationCommandOptionTypes.String,
          name: "text",
          description: "Status text (omit to clear)",
          required: false,
          maxLength: VOICE_STATUS_MAX_LENGTH,
        },
      ],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "nsfw",
      description: "Enable or disable age restriction on the channel",
      options: [
        {
          type: ApplicationCommandOptionTypes.Boolean,
          name: "enabled",
          description: "Whether age restriction should be enabled",
          required: true,
        },
      ],
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "region",
      description: "Set the voice region for the channel",
      options: [
        {
          type: ApplicationCommandOptionTypes.String,
          name: "region",
          description: "Voice region (Automatic follows Discord routing)",
          required: true,
          choices: VOICE_REGION_OPTIONS.map((entry) => ({
            name: entry.name,
            value: entry.value,
          })),
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
      name: "request",
      description: "Request access to a locked temporary voice channel",
      options: [
        {
          type: ApplicationCommandOptionTypes.String,
          name: "target",
          description: "Voice channel ID or channel owner ID",
          required: true,
          minLength: 17,
          maxLength: 20,
        },
      ],
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
        embeds: failureResponse("Voice channel management is unavailable.").embeds,
        ephemeral: true,
      });
      return;
    }
    await context.vc.execute(interaction);
  },
};

export default vcCommand;
