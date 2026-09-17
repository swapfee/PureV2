import {
  ApplicationCommandOptionTypes,
  ApplicationCommandTypes,
  type CreateApplicationCommand,
} from "discordeno";

import type { CommandModule } from "../handlers/types.ts";
import { failureResponse } from "../lib/j2c/action-response.ts";

const unblockFromVcCommandData: CreateApplicationCommand = {
  name: "Unblock from VC",
  type: ApplicationCommandTypes.User,
};

const unblockFromVcCommand: CommandModule = {
  data: unblockFromVcCommandData,
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
    if (!interaction.targetUserId) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        embeds: failureResponse("Provide a member to unblock.").embeds,
        ephemeral: true,
      });
      return;
    }
    await context.vc.execute({
      ...interaction,
      commandName: "vc",
      options: [
        {
          name: "unblock",
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

export default unblockFromVcCommand;
