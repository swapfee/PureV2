import { NextRequest, NextResponse } from "next/server"

import { getDashboardSession } from "@/lib/auth/discord"
import { updateControlDashboardConfiguration, type DashboardConfigurationUpdate } from "@/lib/dashboard/control-api"

const ALLOWED_FIELDS = new Set([
  "enabled",
  "lobbyChannelName",
  "categoryName",
  "channelNameTemplate",
  "defaultUserLimit",
  "ownerCanEdit",
])

function readUpdate(value: unknown): DashboardConfigurationUpdate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.some(([key]) => !ALLOWED_FIELDS.has(key))) return undefined
  const record: Record<string, unknown> = Object.fromEntries(entries)
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") return undefined
  if (record.lobbyChannelName !== undefined && typeof record.lobbyChannelName !== "string") return undefined
  if (record.categoryName !== undefined && typeof record.categoryName !== "string") return undefined
  if (record.channelNameTemplate !== undefined && typeof record.channelNameTemplate !== "string") return undefined
  if (record.defaultUserLimit !== undefined && typeof record.defaultUserLimit !== "number") return undefined
  if (record.ownerCanEdit !== undefined && typeof record.ownerCanEdit !== "boolean") return undefined
  return {
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(typeof record.lobbyChannelName === "string" ? { lobbyChannelName: record.lobbyChannelName } : {}),
    ...(typeof record.categoryName === "string" ? { categoryName: record.categoryName } : {}),
    ...(typeof record.channelNameTemplate === "string" ? { channelNameTemplate: record.channelNameTemplate } : {}),
    ...(typeof record.defaultUserLimit === "number" ? { defaultUserLimit: record.defaultUserLimit } : {}),
    ...(typeof record.ownerCanEdit === "boolean" ? { ownerCanEdit: record.ownerCanEdit } : {}),
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ guildId: string }> },
) {
  const session = await getDashboardSession()
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  const update = readUpdate(await request.json().catch(() => undefined))
  if (!update) return NextResponse.json({ error: "Invalid configuration" }, { status: 400 })
  const { guildId } = await context.params
  try {
    const requestId = request.headers.get("x-request-id")?.slice(0, 100) || crypto.randomUUID()
    const snapshot = await updateControlDashboardConfiguration(guildId, update, session.guilds, session.viewer, requestId)
    return NextResponse.json({ snapshot })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save configuration" },
      { status: 502 },
    )
  }
}
