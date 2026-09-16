import type { DiscordGatewayPayload } from "discordeno";

/**
 * Minimal surface required to dispatch a gateway payload on a worker.
 * Avoids coupling unit tests to the full Discordeno Bot type.
 */
export interface GatewayHandlerBot {
  readonly handlers: object;
}

/**
 * Single worker gateway dispatch path for discordeno@21.0.0.
 *
 * Discordeno's default gateway.events.message calls raw then handlers.
 * Workers do not own a gateway; they invoke handlers directly.
 * Calling both raw and handlers would be unnecessary here — handlers alone
 * transform the payload and invoke bot.events.* (including our wired modules).
 */
export async function dispatchWorkerGatewayEvent(
  bot: GatewayHandlerBot,
  payload: DiscordGatewayPayload,
  shardId: number,
): Promise<void> {
  const eventName = payload.t;
  if (!eventName) return;

  const handler = Reflect.get(bot.handlers, eventName);
  if (typeof handler !== "function") return;
  await handler(bot, payload, shardId);
}

export function isDiscordGatewayPayload(value: unknown): value is DiscordGatewayPayload {
  return typeof value === "object" && value !== null && "op" in value && typeof value.op === "number";
}
