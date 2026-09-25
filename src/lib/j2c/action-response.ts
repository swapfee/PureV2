/** Custom Discord application emojis for user-facing action outcomes. */
export const ACTION_EMOJIS = {
  success: "<:success:1543407529302949908>",
  error: "<:error:1543407530380624037>",
  loading: "<:iconloading:1552886322589470781>",
} as const;

export interface ActionEmbed {
  readonly description: string;
}

/** Ephemeral slash-command reply payload (embed-only). */
export interface ActionMessage {
  readonly embeds: readonly [ActionEmbed];
}

/**
 * Formal success embed: `<emoji> Message.`
 */
export function successResponse(message: string): ActionMessage {
  return {
    embeds: [
      {
        description: formatActionDescription(ACTION_EMOJIS.success, message),
      },
    ],
  };
}

/**
 * Formal failure embed: `<emoji> Message.`
 */
export function failureResponse(message: string): ActionMessage {
  return {
    embeds: [
      {
        description: formatActionDescription(ACTION_EMOJIS.error, message),
      },
    ],
  };
}

/** Initial ephemeral response for operations that continue asynchronously. */
export function loadingResponse(message: string, userId?: string): ActionMessage {
  const addressedMessage = userId ? `<@${userId}>: ${message}` : message;
  return {
    embeds: [
      {
        description: formatActionDescription(ACTION_EMOJIS.loading, addressedMessage),
      },
    ],
  };
}

function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatActionDescription(emoji: string, message: string): string {
  return `${emoji} ${ensureTerminalPunctuation(message)}`;
}
