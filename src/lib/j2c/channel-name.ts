const USERNAME_TOKEN = "{username}";

export function renderChannelName(template: string, username: string): string {
  const safeName = username.trim().slice(0, 80) || "user";
  const rendered = template.includes(USERNAME_TOKEN)
    ? template.split(USERNAME_TOKEN).join(safeName)
    : template;
  const trimmed = rendered.trim().slice(0, 100);
  return trimmed.length > 0 ? trimmed : `${safeName}'s channel`;
}
