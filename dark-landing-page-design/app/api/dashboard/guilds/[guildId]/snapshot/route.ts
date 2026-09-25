import { NextRequest, NextResponse } from "next/server"

import { getDashboardSession } from "@/lib/auth/discord"
import { getControlDashboardSnapshot } from "@/lib/dashboard/control-api"

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ guildId: string }> },
) {
  const session = await getDashboardSession()
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  const { guildId } = await context.params
  try {
    return NextResponse.json({ snapshot: await getControlDashboardSnapshot(guildId, session.guilds, session.viewer) })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load dashboard" },
      { status: 502 },
    )
  }
}
