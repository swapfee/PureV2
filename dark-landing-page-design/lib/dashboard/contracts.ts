import { z } from "zod"

export type ActivityRangeDays = 7 | 30

export type DashboardSection =
  | "overview"
  | "join-to-create"
  | "channels"
  | "members"
  | "statistics"
  | "settings"

export interface DashboardGuild {
  readonly id: string
  readonly name: string
  readonly initials: string
  readonly memberCount: number
  readonly iconTone: "light" | "muted" | "dark"
}

export interface ManagedVoiceChannel {
  readonly id: string
  readonly name: string
  readonly ownerName: string
  readonly memberCount: number
  readonly userLimit: number
  readonly locked: boolean
  readonly hidden: boolean
  readonly createdMinutesAgo: number
}

export interface ActivityPoint {
  readonly label: string
  readonly minutes: number
}

export interface RecentActivity {
  readonly id: string
  readonly title: string
  readonly detail: string
  readonly occurredAt: string
  readonly kind: "created" | "updated" | "deleted" | "member"
}

export interface JoinToCreateConfiguration {
  readonly enabled: boolean
  readonly lobbyChannelName: string
  readonly categoryName: string
  readonly channelNameTemplate: string
  readonly defaultUserLimit: number
  readonly ownerCanEdit: boolean
  readonly interfaceEnabled: boolean
}

export interface DashboardSnapshot {
  readonly viewer: {
    readonly displayName: string
    readonly username: string
    readonly avatarUrl?: string
  }
  readonly guild: DashboardGuild
  readonly guilds: readonly DashboardGuild[]
  readonly channels: readonly ManagedVoiceChannel[]
  readonly activity: readonly RecentActivity[]
  readonly voiceActivity: readonly ActivityPoint[]
  readonly configuration: JoinToCreateConfiguration
  readonly summary: {
    readonly activeChannels: number
    readonly connectedMembers: number
    readonly voiceSessions: number
    readonly averageSessionMinutes: number
  }
}

export const dashboardSnapshotSchema = z.object({
  viewer: z.object({ displayName: z.string(), username: z.string(), avatarUrl: z.string().optional() }),
  guild: z.object({
    id: z.string(), name: z.string(), initials: z.string(), memberCount: z.number(),
    iconTone: z.enum(["light", "muted", "dark"]),
  }),
  guilds: z.array(z.object({
    id: z.string(), name: z.string(), initials: z.string(), memberCount: z.number(),
    iconTone: z.enum(["light", "muted", "dark"]),
  })),
  channels: z.array(z.object({
    id: z.string(), name: z.string(), ownerName: z.string(), memberCount: z.number(),
    userLimit: z.number(), locked: z.boolean(), hidden: z.boolean(), createdMinutesAgo: z.number(),
  })),
  activity: z.array(z.object({
    id: z.string(), title: z.string(), detail: z.string(), occurredAt: z.string(),
    kind: z.enum(["created", "updated", "deleted", "member"]),
  })),
  voiceActivity: z.array(z.object({ label: z.string(), minutes: z.number() })),
  configuration: z.object({
    enabled: z.boolean(), lobbyChannelName: z.string(), categoryName: z.string(),
    channelNameTemplate: z.string(), defaultUserLimit: z.number(), ownerCanEdit: z.boolean(),
    interfaceEnabled: z.boolean(),
  }),
  summary: z.object({
    activeChannels: z.number(), connectedMembers: z.number(), voiceSessions: z.number(),
    averageSessionMinutes: z.number(),
  }),
})
