import { DashboardApp } from "@/components/dashboard/dashboard-app"
import { getDashboardSession, isDiscordOAuthConfigured } from "@/lib/auth/discord"
import { getControlDashboardSnapshot } from "@/lib/dashboard/control-api"
import { getDashboardSnapshot } from "@/lib/dashboard/demo-data"
import { redirect } from "next/navigation"

export const metadata = {
  title: "Dashboard — Pure",
  description: "Configure and monitor Pure Join to Create voice channels.",
}

export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  if (!isDiscordOAuthConfigured()) {
    if (process.env.NODE_ENV === "production") {
      return <main className="grid min-h-screen place-items-center bg-black px-6 text-center text-white"><div><h1 className="text-2xl font-semibold">Dashboard unavailable</h1><p className="mt-2 text-sm text-white/60">Discord sign-in has not been configured on this server.</p></div></main>
    }
    return <DashboardApp initialSnapshot={await getDashboardSnapshot()} />
  }

  const session = await getDashboardSession()
  if (!session) redirect("/api/auth/discord")
  if (session.guilds.length === 0) {
    return <main className="grid min-h-screen place-items-center bg-black px-6 text-center text-white"><div><h1 className="text-2xl font-semibold">No manageable servers</h1><p className="mt-2 text-sm text-white/60">You must own a server or have Manage Server permission.</p></div></main>
  }
  const preferredGuildId = process.env.PUREV2_DASHBOARD_GUILD_ID
  const selectedGuild = session.guilds.find((guild) => guild.id === preferredGuildId) ?? session.guilds[0]
  const snapshot = await getControlDashboardSnapshot(selectedGuild.id, session.guilds, session.viewer)
  return <DashboardApp initialSnapshot={snapshot} />
}
