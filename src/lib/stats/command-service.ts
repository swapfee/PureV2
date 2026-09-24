import type { CooldownStore } from "../../handlers/cooldowns.ts";
import type { Logger } from "../logger.ts";
import type { DiscordApiPort, InteractionCreatePayload } from "../runtime-types.ts";
import { failureResponse, successResponse } from "../j2c/action-response.ts";
import type { VoiceStatsMetrics } from "./metrics.ts";
import type { VoiceStatsCardRenderer } from "./card-renderer.ts";
import type { VoiceStatsService } from "./service.ts";

const COOLDOWN_MS = 15_000;
const MAX_PNG_BYTES = 3_500_000;

function memberOption(interaction: InteractionCreatePayload): string | undefined {
  const value = interaction.options?.find((option) => option.name === "member")?.value;
  return typeof value === "string" ? value : undefined;
}

export function createStatsCommandService(options: {
  readonly stats: VoiceStatsService;
  readonly discord: DiscordApiPort;
  readonly renderer: VoiceStatsCardRenderer;
  readonly cooldowns: CooldownStore;
  readonly metrics: VoiceStatsMetrics;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly renderConcurrency?: number;
  readonly renderCacheLimit?: number;
}): { execute(interaction: InteractionCreatePayload): Promise<void> } {
  const now = options.now ?? Date.now;
  const concurrency = options.renderConcurrency ?? 2;
  const cacheLimit = options.renderCacheLimit ?? 100;
  const renderCache = new Map<string, { readonly expiresAt: number; readonly data: Uint8Array }>();
  const renderInFlight = new Map<string, Promise<Uint8Array>>();
  const waiters: (() => void)[] = [];
  let activeRenders = 0;
  const acquire = async (): Promise<void> => {
    if (activeRenders < concurrency) { activeRenders += 1; return; }
    if (waiters.length >= 20) throw new Error("render_queue_full");
    await new Promise<void>((resolve) => { waiters.push(resolve); });
    activeRenders += 1;
  };
  const release = (): void => {
    activeRenders = Math.max(0, activeRenders - 1);
    waiters.shift()?.();
  };
  const render = async (key: string, load: () => Promise<Uint8Array>): Promise<Uint8Array> => {
    const cached = renderCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.data;
    if (cached) renderCache.delete(key);
    const existing = renderInFlight.get(key);
    if (existing) return existing;
    const pending = (async () => {
      await acquire();
      try {
        const data = await load();
        renderCache.set(key, { data, expiresAt: now() + 30_000 });
        while (renderCache.size > cacheLimit) {
          const oldest = renderCache.keys().next().value;
          if (typeof oldest !== "string") break;
          renderCache.delete(oldest);
        }
        return data;
      } finally { release(); }
    })();
    renderInFlight.set(key, pending);
    try { return await pending; } finally { renderInFlight.delete(key); }
  };
  return {
    async execute(interaction) {
      if (!interaction.guildId) {
        await options.discord.respondToInteraction({
          interactionId: interaction.id,
          interactionToken: interaction.token,
          embeds: failureResponse("Statistics are only available in a server.").embeds,
          ephemeral: true,
        });
        return;
      }
      await options.discord.deferInteraction({ interactionId: interaction.id, interactionToken: interaction.token, ephemeral: true });
      const fail = async (message: string): Promise<void> => options.discord.editInteractionResponse({
        applicationId: interaction.applicationId,
        interactionToken: interaction.token,
        embeds: failureResponse(message).embeds,
      });
      if (!options.stats.isReady()) { await fail("Voice statistics are still warming up. Please try again shortly."); return; }
      const remaining = options.cooldowns.remaining(`stat:${interaction.guildId}:${interaction.userId}`);
      if (remaining > 0) { await fail(`Please wait ${Math.ceil(remaining / 1_000)} seconds before generating another statistics card.`); return; }
      options.cooldowns.check(`stat:${interaction.guildId}:${interaction.userId}`, COOLDOWN_MS);
      const targetUserId = memberOption(interaction) ?? interaction.userId;
      const target = await options.discord.getGuildMember({ guildId: interaction.guildId, userId: targetUserId });
      if (target.kind !== "found") { await fail("That member could not be found in this server."); return; }
      if (target.value.bot) { await fail("Bot accounts do not have managed voice statistics."); return; }
      const displayName = target.value.nick ?? target.value.globalName ?? target.value.username ?? `Member ${targetUserId.slice(-4)}`;
      try {
        const snapshot = await options.stats.getSnapshot(interaction.guildId, targetUserId, displayName);
        const png = await render(`${interaction.guildId}:${targetUserId}`, () => options.renderer.render(snapshot));
        if (png.byteLength > MAX_PNG_BYTES) throw new Error("rendered_png_too_large");
        options.metrics.increment("renders");
        await options.discord.editInteractionResponse({
          applicationId: interaction.applicationId,
          interactionToken: interaction.token,
          requestId: `stat:${interaction.id}:render`,
          embeds: successResponse("Voice statistics generated.").embeds,
          files: [{ name: "voice-stats.png", contentType: "image/png", data: png }],
        });
      } catch (error) {
        options.metrics.increment("renderFailures");
        options.logger.error("Voice statistics command failed", { guildId: interaction.guildId, userId: interaction.userId, targetUserId, interactionId: interaction.id, error });
        await fail("The statistics card could not be generated. Please try again later.");
      }
    },
  };
}
