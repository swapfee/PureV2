import { NextRequest, NextResponse } from "next/server"

import { getDashboardSession } from "@/lib/auth/discord"
import { getControlDashboardSnapshot } from "@/lib/dashboard/control-api"

function validTimeZone(value: string): boolean {
  if (value.length > 100) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ guildId: string }> },
) {
  const session = await getDashboardSession()
  if (!session) return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  const { guildId } = await context.params
  const daysValue = Number(request.nextUrl.searchParams.get("days") ?? "7")
  if (daysValue !== 7 && daysValue !== 30) {
    return NextResponse.json({ error: "Statistics range must be 7 or 30 days" }, { status: 400 })
  }
  const timeZone = request.nextUrl.searchParams.get("timezone") ?? "UTC"
  if (!validTimeZone(timeZone)) {
    return NextResponse.json({ error: "Timezone must be a valid IANA timezone" }, { status: 400 })
  }
  try {
    return NextResponse.json({
      snapshot: await getControlDashboardSnapshot(
        guildId,
        session.guilds,
        session.viewer,
        daysValue,
        timeZone,
      ),
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load dashboard" },
      { status: 502 },
    )
  }
}
