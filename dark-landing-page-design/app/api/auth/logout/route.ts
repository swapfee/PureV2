import { NextRequest, NextResponse } from "next/server"

import { clearDiscordSession } from "@/lib/auth/discord"

export async function POST(request: NextRequest) {
  await clearDiscordSession()
  return NextResponse.redirect(new URL("/", request.url), { status: 303 })
}
