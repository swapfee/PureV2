import type { EventModule } from "../handlers/types.ts";

const voiceStateUpdateEvent: EventModule<"voiceStateUpdate"> = {
  name: "voiceStateUpdate",
  async execute(context, payload) {
    if (!context.j2c) return;
    const eventId = context.currentEventId ?? `voice:${payload.guildId}:${payload.userId}:${payload.channelId ?? "null"}`;
    await context.j2c.voice.handle(payload, eventId);
  },
};

export default voiceStateUpdateEvent;
