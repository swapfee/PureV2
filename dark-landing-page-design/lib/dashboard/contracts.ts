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
  readonly guild: DashboardGuild
  readonly guilds: readonly DashboardGuild[]
  readonly channels: readonly ManagedVoiceChannel[]
  readonly activity: readonly RecentActivity[]
  readonly voiceActivity: readonly ActivityPoint[]
  readonly configuration: JoinToCreateConfiguration
  readonly summary: {
    readonly activeChannels: number
    readonly connectedMembers: number
    readonly channelsCreatedToday: number
    readonly averageSessionMinutes: number
  }
}
