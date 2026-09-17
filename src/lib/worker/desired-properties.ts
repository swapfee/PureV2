/** Minimal desired properties for skeleton command/event handling and Join-to-Create. */
export const workerDesiredProperties = {
  interaction: {
    id: true,
    applicationId: true,
    type: true,
    token: true,
    guildId: true,
    channelId: true,
    data: true,
    user: true,
    member: true,
  },
  user: {
    id: true,
    username: true,
    globalName: true,
    bot: true,
  },
  member: {
    id: true,
    user: true,
    guildId: true,
    permissions: true,
    nick: true,
  },
  channel: {
    id: true,
    guildId: true,
    name: true,
    type: true,
    parentId: true,
    permissionOverwrites: true,
    bitrate: true,
    userLimit: true,
  },
  guild: {
    id: true,
    name: true,
    voiceStates: true,
  },
  voiceState: {
    guildId: true,
    channelId: true,
    userId: true,
    sessionId: true,
    mute: true,
  },
} as const;
