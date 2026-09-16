import type { EventModule } from "../handlers/types.ts";

const readyEvent: EventModule<"ready"> = {
  name: "ready",
  async execute(context, payload) {
    context.logger.info("Shard ready on worker", {
      shardId: payload.shardId,
      applicationId: payload.applicationId,
      guildCount: payload.guildIds.length,
    });
  },
};

export default readyEvent;
