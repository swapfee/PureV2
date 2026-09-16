import type { CommandModule } from "../handlers/types.ts";

const pingCommand: CommandModule = {
  data: {
    name: "ping",
    description: "Check whether the bot worker is responsive",
  },
  cooldownMs: 3_000,
  async execute(context, interaction) {
    await context.discord.respondToInteraction({
      interactionId: interaction.id,
      interactionToken: interaction.token,
      content: `Pong from worker ${context.workerId}`,
      ephemeral: true,
    });
  },
};

export default pingCommand;
