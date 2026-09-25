import type { DashboardSnapshot } from "@/lib/dashboard/contracts"

const guilds = [
  { id: "1539918723396407357", name: "Pure Community", initials: "PC", memberCount: 1284, iconTone: "light" as const },
  { id: "200000000000000001", name: "Night Shift", initials: "NS", memberCount: 462, iconTone: "muted" as const },
  { id: "200000000000000002", name: "Build Club", initials: "BC", memberCount: 219, iconTone: "dark" as const },
] satisfies DashboardSnapshot["guilds"]

/** Demo-only data provider. Replace this boundary with the authenticated Pure API. */
export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  return {
    viewer: { displayName: "FonZ", username: "buystop" },
    guild: guilds[0],
    guilds,
    channels: [
      { id: "310000000000000001", name: "late night talks", ownerName: "FonZ", memberCount: 5, userLimit: 8, locked: false, hidden: false, createdMinutesAgo: 18 },
      { id: "310000000000000002", name: "ranked grind", ownerName: "Ari", memberCount: 3, userLimit: 5, locked: true, hidden: false, createdMinutesAgo: 41 },
      { id: "310000000000000003", name: "music lounge", ownerName: "Mika", memberCount: 7, userLimit: 0, locked: false, hidden: false, createdMinutesAgo: 63 },
      { id: "310000000000000004", name: "staff room", ownerName: "Jordan", memberCount: 2, userLimit: 6, locked: true, hidden: true, createdMinutesAgo: 92 },
    ],
    activity: [
      { id: "activity-1", title: "Channel created", detail: "FonZ opened late night talks", occurredAt: "2 minutes ago", kind: "created" },
      { id: "activity-2", title: "Access updated", detail: "Ari locked ranked grind", occurredAt: "14 minutes ago", kind: "updated" },
      { id: "activity-3", title: "Member joined", detail: "Mika permitted @nova", occurredAt: "28 minutes ago", kind: "member" },
      { id: "activity-4", title: "Channel cleaned up", detail: "movie night was deleted when empty", occurredAt: "46 minutes ago", kind: "deleted" },
    ],
    voiceActivity: [
      { label: "Mon", minutes: 184 },
      { label: "Tue", minutes: 248 },
      { label: "Wed", minutes: 212 },
      { label: "Thu", minutes: 331 },
      { label: "Fri", minutes: 406 },
      { label: "Sat", minutes: 512 },
      { label: "Sun", minutes: 438 },
    ],
    configuration: {
      enabled: true,
      lobbyChannelName: "Join to Create",
      categoryName: "Temporary Voice Channel",
      channelNameTemplate: "{username}'s channel",
      defaultUserLimit: 0,
      ownerCanEdit: true,
      interfaceEnabled: true,
    },
    summary: {
      activeChannels: 4,
      connectedMembers: 17,
      channelsCreatedToday: 28,
      averageSessionMinutes: 47,
    },
  }
}
