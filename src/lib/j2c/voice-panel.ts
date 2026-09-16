/** Custom application emojis for the voice control panel. */
export const PANEL_EMOJIS = {
  lock: { name: "iconlock", id: "1543420521516105838" },
  unlock: { name: "iconunlock", id: "1543420522228875326" },
  hide: { name: "iconinvisible", id: "1543420519783731200" },
  unhide: { name: "iconvisible", id: "1543420523575386173" },
  rename: { name: "iconname", id: "1543472299930427422" },
  limit: { name: "iconlimit", id: "1543420520601485355" },
  transfer: { name: "icontransfer", id: "1543421054867996672" },
  claim: { name: "iconclaim", id: "1543420518965846107" },
  info: { name: "iconinfo", id: "1543421120332566579" },
  delete: { name: "icondelete", id: "1543421011200966827" },
  confirm: { name: "iconconfirm", id: "1543476218802999346" },
  cancel: { name: "iconcancel", id: "1543476216303190016" },
} as const;

export function emojiMention(emoji: { readonly name: string; readonly id: string }): string {
  return `<:${emoji.name}:${emoji.id}>`;
}

export const VOICE_PANEL_PREFIX = "voice-panel";
export const VOICE_MODAL_PREFIX = "voice-modal";
export const VOICE_SELECT_PREFIX = "voice-select";
export const VOICE_DELETE_PREFIX = "voice-delete";
export const VOICE_PANEL_VERSION = 3;
export const OWNER_TRANSFER_GRACE_MS = 5 * 60_000;
export const IS_COMPONENTS_V2 = 1 << 15;

export type VoicePanelAction =
  | "claim"
  | "delete"
  | "hide"
  | "info"
  | "limit"
  | "lock"
  | "rename"
  | "transfer"
  | "unhide"
  | "unlock";

export function isVoicePanelAction(value: string): value is VoicePanelAction {
  switch (value) {
    case "claim":
    case "delete":
    case "hide":
    case "info":
    case "limit":
    case "lock":
    case "rename":
    case "transfer":
    case "unhide":
    case "unlock":
      return true;
    default:
      return false;
  }
}

const ComponentTypes = {
  ActionRow: 1,
  Button: 2,
  TextInput: 4,
  UserSelect: 5,
  TextDisplay: 10,
  Separator: 14,
  Container: 17,
} as const;

const ButtonStyles = {
  Secondary: 2,
  Danger: 4,
} as const;

function panelButton(action: VoicePanelAction, channelId: string, ownerId: string, emoji: {
  readonly name: string;
  readonly id: string;
}) {
  return {
    type: ComponentTypes.Button,
    style: ButtonStyles.Secondary,
    custom_id: `${VOICE_PANEL_PREFIX}:${action}:${channelId}:${ownerId}`,
    emoji: { id: emoji.id, name: emoji.name },
  };
}

export function buildVoiceControlPanelComponents(options: {
  readonly botUsername: string;
  readonly channelId: string;
  readonly ownerId: string;
}): unknown[] {
  const { botUsername, channelId, ownerId } = options;
  const heading = {
    type: ComponentTypes.TextDisplay,
    content: `# ${botUsername}'s Interface\nManage your personal voice channel with ease.\n**Channel Owner** <@${ownerId}>`,
  };
  const separator = {
    type: ComponentTypes.Separator,
    divider: true,
    spacing: 1,
  };
  const commandList = {
    type: ComponentTypes.TextDisplay,
    content: [
      `${emojiMention(PANEL_EMOJIS.lock)} **Lock** — Prevent members from joining`,
      `${emojiMention(PANEL_EMOJIS.unlock)} **Unlock** — Restore inherited access`,
      `${emojiMention(PANEL_EMOJIS.hide)} **Hide** — Hide the channel from everyone`,
      `${emojiMention(PANEL_EMOJIS.unhide)} **Unhide** — Restore inherited visibility`,
      `${emojiMention(PANEL_EMOJIS.rename)} **Rename** — Change the channel name`,
      `${emojiMention(PANEL_EMOJIS.limit)} **Limit** — Set the user limit`,
      `${emojiMention(PANEL_EMOJIS.transfer)} **Transfer** — Transfer channel ownership`,
      `${emojiMention(PANEL_EMOJIS.claim)} **Claim** — Claim an ownerless channel`,
      `${emojiMention(PANEL_EMOJIS.info)} **Info** — View the current channel settings`,
      `${emojiMention(PANEL_EMOJIS.delete)} **Delete** — Delete the temporary channel`,
    ].join("\n"),
  };
  const row1 = {
    type: ComponentTypes.ActionRow,
    components: [
      panelButton("lock", channelId, ownerId, PANEL_EMOJIS.lock),
      panelButton("hide", channelId, ownerId, PANEL_EMOJIS.hide),
      panelButton("rename", channelId, ownerId, PANEL_EMOJIS.rename),
      panelButton("transfer", channelId, ownerId, PANEL_EMOJIS.transfer),
      panelButton("info", channelId, ownerId, PANEL_EMOJIS.info),
    ],
  };
  const row2 = {
    type: ComponentTypes.ActionRow,
    components: [
      panelButton("unlock", channelId, ownerId, PANEL_EMOJIS.unlock),
      panelButton("unhide", channelId, ownerId, PANEL_EMOJIS.unhide),
      panelButton("limit", channelId, ownerId, PANEL_EMOJIS.limit),
      panelButton("claim", channelId, ownerId, PANEL_EMOJIS.claim),
      panelButton("delete", channelId, ownerId, PANEL_EMOJIS.delete),
    ],
  };

  return [
    {
      type: ComponentTypes.Container,
      components: [heading, separator, commandList, separator, row1, row2],
    },
  ];
}

export function buildRenameModal(channelId: string): {
  readonly title: string;
  readonly customId: string;
  readonly components: readonly unknown[];
} {
  return {
    title: "Rename Voice Channel",
    customId: `${VOICE_MODAL_PREFIX}:rename:${channelId}`,
    components: [
      {
        type: ComponentTypes.ActionRow,
        components: [
          {
            type: ComponentTypes.TextInput,
            custom_id: "value",
            style: 1,
            label: "New channel name",
            placeholder: "Enter a new channel name",
            required: true,
            min_length: 1,
            max_length: 100,
          },
        ],
      },
    ],
  };
}

export function buildLimitModal(channelId: string): {
  readonly title: string;
  readonly customId: string;
  readonly components: readonly unknown[];
} {
  return {
    title: "Set Voice Channel Limit",
    customId: `${VOICE_MODAL_PREFIX}:limit:${channelId}`,
    components: [
      {
        type: ComponentTypes.ActionRow,
        components: [
          {
            type: ComponentTypes.TextInput,
            custom_id: "value",
            style: 1,
            label: "User limit (0 = unlimited)",
            placeholder: "Enter a number from 0 to 99",
            required: true,
            min_length: 1,
            max_length: 2,
          },
        ],
      },
    ],
  };
}

export function buildTransferSelect(channelId: string): readonly unknown[] {
  return [
    {
      type: ComponentTypes.ActionRow,
      components: [
        {
          type: ComponentTypes.UserSelect,
          custom_id: `${VOICE_SELECT_PREFIX}:transfer:${channelId}`,
          placeholder: "Select the new owner",
          min_values: 1,
          max_values: 1,
        },
      ],
    },
  ];
}

export function buildDeleteConfirmation(channelId: string): readonly unknown[] {
  return [
    {
      type: ComponentTypes.ActionRow,
      components: [
        {
          type: ComponentTypes.Button,
          style: ButtonStyles.Danger,
          custom_id: `${VOICE_DELETE_PREFIX}:confirm:${channelId}`,
          emoji: { id: PANEL_EMOJIS.confirm.id, name: PANEL_EMOJIS.confirm.name },
        },
        {
          type: ComponentTypes.Button,
          style: ButtonStyles.Secondary,
          custom_id: `${VOICE_DELETE_PREFIX}:cancel:${channelId}`,
          emoji: { id: PANEL_EMOJIS.cancel.id, name: PANEL_EMOJIS.cancel.name },
        },
      ],
    },
  ];
}

export function parseColonId(customId: string): readonly string[] {
  return customId.split(":");
}
