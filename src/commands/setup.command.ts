import { ApplicationCommandOptionTypes, type CreateApplicationCommand } from "discordeno";

import type { CommandModule } from "../handlers/types.ts";

const setupCommandData: CreateApplicationCommand = {
  name: "setup",
  description: "Configure or reset Join-to-Create for this server",
  options: [
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "create",
      description: "Create the Temporary Voice Channel category and Join to Create lobby",
      options: [
        {
          type: ApplicationCommandOptionTypes.String,
          name: "category_name",
          description: "Name for the new category (default: Temporary Voice Channel)",
          required: false,
          minLength: 1,
          maxLength: 100,
        },
        {
          type: ApplicationCommandOptionTypes.String,
          name: "lobby_name",
          description: "Name for the join-to-create voice channel (default: Join to Create)",
          required: false,
          minLength: 1,
          maxLength: 100,
        },
        {
          type: ApplicationCommandOptionTypes.String,
          name: "template",
          description: "Temporary channel name template (default: {username}'s channel)",
          required: false,
          minLength: 1,
          maxLength: 100,
        },
        {
          type: ApplicationCommandOptionTypes.Integer,
          name: "limit",
          description: "Default user limit for new temporary channels (0 = unlimited)",
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
    },
    {
      type: ApplicationCommandOptionTypes.SubCommand,
      name: "reset",
      description:
        "Factory reset: remove Join-to-Create, delete empty temp channels, keep occupied ones",
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
        content: "Setup is not ready yet.",
        ephemeral: true,
      });
      return;
    }
    await context.setup.execute(interaction);
  },
};

export default setupCommand;
