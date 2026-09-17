const USERNAME_TOKENS = [
  "{username}",
  "{displayname}",
  "{display_name}",
  "{displayUsername}",
  "{user.username}",
] as const;

export function renderChannelName(template: string, username: string): string {
  const safeName = username.trim().slice(0, 80) || "user";
  let rendered = template;
  for (const token of USERNAME_TOKENS) {
    if (rendered.includes(token)) {
      rendered = rendered.split(token).join(safeName);
    }
  }
  const trimmed = rendered.trim().slice(0, 100);
  return trimmed.length > 0 ? trimmed : `${safeName}'s channel`;
}

/** Sequential names: "Gaming 1", "Gaming 2", … (Discord max 100 chars). */
export function renderSequentialChannelName(baseName: string, sequence: number): string {
  const n = Number.isInteger(sequence) && sequence > 0 ? sequence : 1;
  const suffix = ` ${n}`;
  const base = baseName.trim().replace(/\s+/g, " ") || "Channel";
  const maxBase = Math.max(1, 100 - suffix.length);
  return `${base.slice(0, maxBase)}${suffix}`;
}
