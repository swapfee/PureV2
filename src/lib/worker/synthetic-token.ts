/**
 * Synthetic worker token adapter.
 *
 * Discordeno `createBot` requires a token string so `getBotIdFromToken` can derive bot.id.
 * Workers never receive DISCORD_TOKEN. This adapter synthesizes a non-secret token whose
 * first segment base64-decodes to DISCORD_APPLICATION_ID.
 *
 * Invariants (enforced by tests and call sites):
 * - Never sent to Discord (REST goes through the coordinator proxy with proxy auth)
 * - Never forwarded over IPC
 * - Never treated as the coordinator token
 * - Used only to satisfy local Discordeno object construction
 */

export const SYNTHETIC_WORKER_TOKEN_MARKER = "purev2.worker-proxy-only";

export interface WorkerBotTokenAdapter {
  readonly token: string;
  readonly applicationId: string;
  readonly purpose: "local_discordeno_construction_only";
  readonly neverSendToDiscord: true;
  readonly neverForwardOverIpc: true;
}

export function syntheticWorkerToken(applicationId: string): string {
  return `${btoa(applicationId)}.${SYNTHETIC_WORKER_TOKEN_MARKER}`;
}

export function isSyntheticWorkerToken(token: string): boolean {
  return token.includes(`.${SYNTHETIC_WORKER_TOKEN_MARKER}`);
}

export function createWorkerBotAdapter(input: {
  readonly applicationId: string;
}): WorkerBotTokenAdapter {
  return {
    token: syntheticWorkerToken(input.applicationId),
    applicationId: input.applicationId,
    purpose: "local_discordeno_construction_only",
    neverSendToDiscord: true,
    neverForwardOverIpc: true,
  };
}
