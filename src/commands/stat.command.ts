import { ApplicationCommandOptionTypes } from "discordeno";

import type { CommandModule } from "../handlers/types.ts";

const statCommand: CommandModule = {
  data: {
    name: "stat",
    description: "View managed voice-channel statistics",
    options: [{ type: ApplicationCommandOptionTypes.User, name: "member", description: "Guild member to view", required: false }],
  },
  async execute(context, interaction) {
    if (!context.stats) throw new Error("Stats command service is unavailable");
    await context.stats.execute(interaction);
  },
};

export default statCommand;
