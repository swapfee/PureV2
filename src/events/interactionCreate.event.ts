import type { EventModule } from "../handlers/types.ts";

const interactionCreateEvent: EventModule<"interactionCreate"> = {
  name: "interactionCreate",
  async execute(context, payload) {
    await context.commands.dispatch(payload);
  },
};

export default interactionCreateEvent;
