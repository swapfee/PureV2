import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import { loadingResponse } from "./action-response.ts";

/**
 * Sends the initial ephemeral progress message for an interaction.
 * Callers must replace it with editInteractionResponse when work completes.
 */
export async function beginEphemeralProgress(options: {
  readonly discord: DiscordApiPort;
  readonly interaction: InteractionCreatePayload;
  readonly message: string;
}): Promise<void> {
  await options.discord.respondToInteraction({
    interactionId: options.interaction.id,
    interactionToken: options.interaction.token,
    embeds: loadingResponse(options.message, options.interaction.userId).embeds,
    ephemeral: true,
  });
}
