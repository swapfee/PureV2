import { describe, expect, test } from "bun:test";

import { createCooldownStore } from "../src/handlers/cooldowns.ts";
import type { CommandRegistry } from "../src/handlers/types.ts";
import { createFakeDiscord } from "../src/lib/j2c/fake-discord.ts";
import { VC_REJECT_SELECT_PREFIX } from "../src/lib/j2c/vc-command-service.ts";
import { createLogger } from "../src/lib/logger.ts";
import type { InteractionCreatePayload } from "../src/lib/runtime-types.ts";
import { createInteractionDispatcher } from "../src/lib/worker/dispatch.ts";

describe("interaction dispatcher", () => {
  test("routes /vc reject user-select submissions without a command name", async () => {
    const { discord } = createFakeDiscord();
    const commands: CommandRegistry = new Map();
    let calls = 0;
    const vc = {
      handles(interaction: InteractionCreatePayload) {
        return interaction.customId?.startsWith(`${VC_REJECT_SELECT_PREFIX}:`) === true;
      },
      async execute() {
        calls += 1;
      },
    };
    const dispatcher = createInteractionDispatcher(
      commands,
      createCooldownStore(),
      0,
      createLogger({
        service: "purev2",
        role: "test",
        level: "error",
        write: () => undefined,
      }),
      discord,
      { vc },
    );

    await dispatcher.dispatch({
      id: "100000000000000001",
      token: "interaction-token",
      type: 3,
      applicationId: "555555555555555555",
      guildId: "123456789012345678",
      userId: "999999999999999999",
      customId: `${VC_REJECT_SELECT_PREFIX}:444444444444444444`,
      selectedUserIds: ["888888888888888888"],
    });

    expect(calls).toBe(1);
  });
});
