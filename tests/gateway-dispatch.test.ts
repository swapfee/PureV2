import { describe, expect, test } from "bun:test";

import {
  dispatchWorkerGatewayEvent,
  isDiscordGatewayPayload,
  type GatewayHandlerBot,
} from "../src/lib/worker/gateway-dispatch.ts";

describe("dispatchWorkerGatewayEvent", () => {
  test("invokes exactly one matching handler and does not require raw", async () => {
    let handlerCalls = 0;

    const bot: GatewayHandlerBot = {
      handlers: {
        READY: async () => {
          handlerCalls += 1;
        },
        INTERACTION_CREATE: async () => {
          handlerCalls += 1;
        },
      },
    };

    await dispatchWorkerGatewayEvent(bot, { op: 0, t: "READY", s: 1, d: {} }, 0);

    expect(handlerCalls).toBe(1);
    expect(isDiscordGatewayPayload({ op: 0 })).toBe(true);
    expect(isDiscordGatewayPayload({})).toBe(false);
  });
});
