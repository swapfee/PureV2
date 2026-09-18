import {
  ApplicationCommandOptionTypes,
  ApplicationCommandTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";
import { failureResponse } from "../lib/j2c/action-response.ts";

const blockFromVcCommandData: CreateApplicationCommand = {
  name: "Block from VC",
  type: ApplicationCommandTypes.User,
};

const blockFromVcCommand: CommandModule = {
  data: blockFromVcCommandData,
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
    if (!interaction.targetUserId) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        embeds: failureResponse("Specify a member to block.").embeds,
        ephemeral: true,
      });
      return;
    }
    if (interaction.targetUserId === interaction.applicationId) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        embeds: failureResponse("You cannot add this bot to your block list.").embeds,
        ephemeral: true,
      });
      return;
    }
    await context.vc.execute({
      ...interaction,
      commandName: "vc",
      options: [
        {
          name: "block",
          type: ApplicationCommandOptionTypes.SubCommand,
          options: [
            {
              name: "member",
              type: ApplicationCommandOptionTypes.User,
              value: interaction.targetUserId,
            },
          ],
        },
      ],
    });
  },
};

export default blockFromVcCommand;
