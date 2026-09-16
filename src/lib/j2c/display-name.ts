/**
 * Prefer guild nickname, then Discord display name, then username.
 * Returns undefined when nothing usable is available.
 */
export function pickDisplayName(input: {
  readonly nick?: string | null | undefined;
  readonly globalName?: string | null | undefined;
  readonly username?: string | null | undefined;
}): string | undefined {
  for (const value of [input.nick, input.globalName, input.username]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 80);
  }
  return undefined;
}

/** Extract display name fields from a raw Discord voice-state `member` object. */
export function displayNameFromVoiceMember(member: unknown): {
  readonly displayName?: string;
  readonly isBot: boolean;
} {
  if (typeof member !== "object" || member === null) {
    return { isBot: false };
  }

  const nickRaw = Reflect.get(member, "nick");
  const user = Reflect.get(member, "user");
  let globalName: string | undefined;
  let username: string | undefined;
  let isBot = false;

  if (typeof user === "object" && user !== null) {
    const globalNameRaw = Reflect.get(user, "global_name") ?? Reflect.get(user, "globalName");
    const usernameRaw = Reflect.get(user, "username");
    if (typeof globalNameRaw === "string") globalName = globalNameRaw;
    if (typeof usernameRaw === "string") username = usernameRaw;
    isBot = Reflect.get(user, "bot") === true;
  }

  const displayName = pickDisplayName({
    nick: typeof nickRaw === "string" ? nickRaw : undefined,
    globalName,
    username,
  });

  return {
    isBot,
    ...(displayName === undefined ? {} : { displayName }),
  };
}
