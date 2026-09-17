/**
 * Discord dynamic timestamp markdown.
 * @see https://discord.com/developers/docs/reference#message-formatting-timestamp-styles
 */
export function discordTimestamp(unixSeconds: number, style: "R" | "t" | "T" | "d" | "D" | "f" | "F" = "R"): string {
  return `<t:${unixSeconds}:${style}>`;
}

/** Absolute Unix seconds when a cooldown expires (rounded up so the client never shows past). */
export function cooldownExpiresUnixSeconds(remainingMs: number, nowMs = Date.now()): number {
  return Math.ceil((nowMs + Math.max(0, remainingMs)) / 1000);
}

/** Professional cooldown refusal using Discord's live relative timestamp. */
export function cooldownFailureMessage(remainingMs: number, nowMs = Date.now()): string {
  const when = discordTimestamp(cooldownExpiresUnixSeconds(remainingMs, nowMs), "R");
  return `This command is on cooldown. Try again ${when}`;
}
