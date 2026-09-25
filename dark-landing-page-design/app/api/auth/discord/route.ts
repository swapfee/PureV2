import { NextResponse } from "next/server"

import { createDiscordAuthorizationUrl } from "@/lib/auth/discord"

export async function GET() {
  try {
    return NextResponse.redirect(await createDiscordAuthorizationUrl())
  } catch {
    return NextResponse.json({ error: "Discord sign-in is not configured" }, { status: 503 })
  }
}
