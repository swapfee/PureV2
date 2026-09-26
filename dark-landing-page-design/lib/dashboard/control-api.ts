import "server-only"

import { z } from "zod"

import type { DiscordGuild, DiscordViewer } from "@/lib/auth/discord"
import type { ActivityRangeDays, DashboardSnapshot } from "@/lib/dashboard/contracts"

interface ControlSnapshot {
  readonly guildId: string
  readonly timeZone: string
  readonly configuration: DashboardSnapshot["configuration"] & {
    readonly lobbyChannelId: string
    readonly categoryId: string
    readonly updatedAt: string
  }
  readonly channels: readonly {
    readonly id: string
    readonly name: string
    readonly ownerId: string
    readonly memberCount: number
    readonly userLimit: number
    readonly locked: boolean
    readonly hidden: boolean
    readonly createdAt: string
  }[]
  readonly summary: {
    readonly activeChannels: number
    readonly connectedMembers: number
    readonly voiceSeconds: number
    readonly voiceSessions: number
  }
  readonly voiceActivity: readonly { readonly day: string; readonly seconds: number }[]
}

interface ControlResponse {
  readonly ok: boolean
  readonly snapshot?: ControlSnapshot
  readonly error?: { readonly code?: string; readonly message?: string }
}

const controlSnapshotSchema = z.object({
  guildId: z.string(),
  timeZone: z.string(),
  configuration: z.object({
    enabled: z.boolean(),
    lobbyChannelId: z.string(),
    lobbyChannelName: z.string(),
    categoryId: z.string(),
    categoryName: z.string(),
    channelNameTemplate: z.string(),
    defaultUserLimit: z.number(),
    ownerCanEdit: z.boolean(),
    interfaceEnabled: z.boolean(),
    updatedAt: z.string(),
  }),
  channels: z.array(z.object({
    id: z.string(),
    name: z.string(),
    ownerId: z.string(),
    memberCount: z.number(),
    userLimit: z.number(),
    locked: z.boolean(),
    hidden: z.boolean(),
    createdAt: z.string(),
  })),
  summary: z.object({
    activeChannels: z.number(),
    connectedMembers: z.number(),
    voiceSeconds: z.number(),
    voiceSessions: z.number(),
  }),
  voiceActivity: z.array(z.object({ day: z.string(), seconds: z.number() })),
})
const controlResponseSchema = z.object({
  ok: z.boolean(),
  snapshot: controlSnapshotSchema.optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
})

export interface DashboardConfigurationUpdate {
  readonly enabled?: boolean
  readonly lobbyChannelName?: string
  readonly categoryName?: string
  readonly channelNameTemplate?: string
  readonly defaultUserLimit?: number
  readonly ownerCanEdit?: boolean
}

function controlConfiguration(): { url: string; authorization: string } {
  const url = process.env.PUREV2_CONTROL_API_URL
  const authorization = process.env.PUREV2_CONTROL_API_AUTHORIZATION
  if (!url || !authorization) throw new Error("PureV2 control API is not configured")
  return { url: url.replace(/\/$/, ""), authorization }
}

async function controlRequest(path: string, init?: RequestInit): Promise<ControlSnapshot> {
  const config = controlConfiguration()
  const headers = new Headers(init?.headers)
  headers.set("authorization", config.authorization)
  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  })
  const payload: ControlResponse = controlResponseSchema.parse(await response.json())
  if (!response.ok || !payload.ok || !payload.snapshot) {
    throw new Error(payload.error?.message ?? `PureV2 control API failed (${response.status})`)
  }
  return payload.snapshot
}

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "P"
}

function guildView(guild: DiscordGuild): DashboardSnapshot["guild"] {
  return {
    id: guild.id,
    name: guild.name,
    initials: initials(guild.name),
    memberCount: 0,
    iconTone: "light",
  }
}

function activityLabel(day: string, days: ActivityRangeDays): string {
  const value = new Date(`${day}T00:00:00.000Z`)
  return new Intl.DateTimeFormat("en-US", days === 7
    ? { weekday: "short", timeZone: "UTC" }
    : { month: "short", day: "numeric", timeZone: "UTC" }).format(value)
}

function mapSnapshot(
  raw: ControlSnapshot,
  selectedGuild: DiscordGuild,
  guilds: readonly DiscordGuild[],
  viewer: DiscordViewer,
  days: ActivityRangeDays = 7,
): DashboardSnapshot {
  const now = Date.now()
  return {
    timeZone: raw.timeZone,
    viewer: {
      displayName: viewer.globalName ?? viewer.username,
      username: viewer.username,
      ...(viewer.avatar ? { avatarUrl: `https://cdn.discordapp.com/avatars/${viewer.id}/${viewer.avatar}.png?size=128` } : {}),
    },
    guild: guildView(selectedGuild),
    guilds: guilds.map(guildView),
    channels: raw.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      ownerName: `User ${channel.ownerId.slice(-4)}`,
      memberCount: channel.memberCount,
      userLimit: channel.userLimit,
      locked: channel.locked,
      hidden: channel.hidden,
      createdMinutesAgo: Math.max(0, Math.floor((now - Date.parse(channel.createdAt)) / 60_000)),
    })),
    activity: [],
    voiceActivity: raw.voiceActivity.map((point) => ({
      label: activityLabel(point.day, days),
      minutes: Math.round(point.seconds / 60),
    })),
    configuration: {
      enabled: raw.configuration.enabled,
      lobbyChannelName: raw.configuration.lobbyChannelName,
      categoryName: raw.configuration.categoryName,
      channelNameTemplate: raw.configuration.channelNameTemplate,
      defaultUserLimit: raw.configuration.defaultUserLimit,
      ownerCanEdit: raw.configuration.ownerCanEdit,
      interfaceEnabled: raw.configuration.interfaceEnabled,
    },
    summary: {
      activeChannels: raw.summary.activeChannels,
      connectedMembers: raw.summary.connectedMembers,
      voiceSessions: raw.summary.voiceSessions,
      averageSessionMinutes: raw.summary.voiceSessions === 0
        ? 0
        : Math.round(raw.summary.voiceSeconds / raw.summary.voiceSessions / 60),
    },
  }
}

export async function getControlDashboardSnapshot(
  guildId: string,
  guilds: readonly DiscordGuild[],
  viewer: DiscordViewer,
  days: ActivityRangeDays = 7,
  timeZone = "UTC",
): Promise<DashboardSnapshot> {
  const selectedGuild = guilds.find((guild) => guild.id === guildId)
  if (!selectedGuild) throw new Error("Guild is not authorized")
  const snapshot = await controlRequest(
    `/v1/dashboard/guilds/${guildId}/snapshot?days=${days}&timezone=${encodeURIComponent(timeZone)}`,
  )
  return mapSnapshot(snapshot, selectedGuild, guilds, viewer, days)
}

export async function updateControlDashboardConfiguration(
  guildId: string,
  update: DashboardConfigurationUpdate,
  guilds: readonly DiscordGuild[],
  viewer: DiscordViewer,
  requestId: string,
  days: ActivityRangeDays = 7,
  timeZone = "UTC",
): Promise<DashboardSnapshot> {
  const selectedGuild = guilds.find((guild) => guild.id === guildId)
  if (!selectedGuild) throw new Error("Guild is not authorized")
  const snapshot = await controlRequest(`/v1/dashboard/guilds/${guildId}/config?days=${days}&timezone=${encodeURIComponent(timeZone)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify(update),
  })
  return mapSnapshot(snapshot, selectedGuild, guilds, viewer, days)
}
