import type { EventModule } from "../handlers/types.ts";

const voiceStateUpdateEvent: EventModule<"voiceStateUpdate"> = {
  name: "voiceStateUpdate",
  async execute(context, payload) {
    const eventId = context.currentEventId ?? `voice:${payload.guildId}:${payload.userId}:${payload.channelId ?? "null"}`;
    if (context.j2c) await context.j2c.voice.handle(payload, eventId);
    if (context.stats) await context.stats.handle(payload, eventId);
  },
};

export default voiceStateUpdateEvent;
