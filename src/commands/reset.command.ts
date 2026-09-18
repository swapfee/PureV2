import type { CreateApplicationCommand } from "discordeno";

import type { CommandModule } from "../handlers/types.ts";
import { failureResponse } from "../lib/j2c/action-response.ts";

const resetCommandData: CreateApplicationCommand = {
  name: "reset",
  description: "Reset the Join to Create system for this server",
};

const resetCommand: CommandModule = {
  data: resetCommandData,
  cooldownMs: 30_000,
  async execute(context, interaction) {
    if (!context.setup) {
      await context.discord.respondToInteraction({
        interactionId: interaction.id,
        interactionToken: interaction.token,
        embeds: failureResponse("Reset is currently unavailable.").embeds,
        ephemeral: true,
      });
      return;
    }
    await context.setup.execute(interaction);
  },
};

export default resetCommand;
