/** Custom Discord application emojis for user-facing action outcomes. */
export const ACTION_EMOJIS = {
  success: "<:success:1543407529302949908>",
  error: "<:error:1543407530380624037>",
} as const;

export const ACTION_EMBED_COLORS = {
  success: 0x3ba55d,
  error: 0xed4245,
} as const;

export interface ActionEmbed {
  readonly description: string;
  readonly color: number;
}

/** Ephemeral slash-command reply payload (embed-only). */
export interface ActionMessage {
  readonly embeds: readonly [ActionEmbed];
}

/**
 * Formal success embed: `<emoji> Message.` plus optional detail lines.
 */
export function successResponse(message: string, details?: string | readonly string[]): ActionMessage {
  return {
    embeds: [
      {
        description: formatActionDescription(ACTION_EMOJIS.success, message, details),
        color: ACTION_EMBED_COLORS.success,
      },
    ],
  };
}

/**
 * Formal failure embed: `<emoji> Message.` plus optional detail lines.
 */
export function failureResponse(message: string, details?: string | readonly string[]): ActionMessage {
  return {
    embeds: [
      {
        description: formatActionDescription(ACTION_EMOJIS.error, message, details),
        color: ACTION_EMBED_COLORS.error,
      },
    ],
  };
}

function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatActionDescription(
  emoji: string,
  message: string,
  details?: string | readonly string[],
): string {
  const head = `${emoji} ${ensureTerminalPunctuation(message)}`;
  if (details === undefined) return head;
  const body = Array.isArray(details)
    ? details.map((line) => ensureTerminalPunctuation(line)).filter((line) => line.length > 0).join("\n")
    : ensureTerminalPunctuation(details);
  return body.length > 0 ? `${head}\n${body}` : head;
}
