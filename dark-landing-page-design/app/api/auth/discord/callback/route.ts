import { NextRequest, NextResponse } from "next/server"

import { completeDiscordAuthorization } from "@/lib/auth/discord"

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")
  const state = request.nextUrl.searchParams.get("state")
  if (!code || !state || !(await completeDiscordAuthorization(code, state))) {
    return NextResponse.redirect(new URL("/?login=failed", request.url))
  }
  return NextResponse.redirect(new URL("/dashboard", request.url))
}
