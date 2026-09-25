import { Check, Hash, Lock, Users, Volume2 } from "lucide-react"
import { SectionHeading } from "@/components/section-heading"

const BENEFITS = [
  "Edit any channel's name, limit, and bitrate remotely",
  "Manage trusted and blocked user lists per server",
  "Set server-wide defaults for every new room",
  "See live activity across all active channels",
]

export function Dashboard() {
  return (
    <section id="dashboard" className="scroll-mt-20 border-t border-border bg-background/50 py-24">
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-5 lg:grid-cols-2">
        <div>
          <SectionHeading
            align="left"
            eyebrow="Dashboard"
            title="Control everything from the web"
            description="Skip the slash commands when you want to. The Pure dashboard gives owners and admins a full view of every channel on the server."
          />
          <ul className="mt-8 space-y-3">
            {BENEFITS.map((b) => (
              <li key={b} className="flex items-center gap-3 text-sm text-muted-foreground">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                  <Check className="size-3 text-foreground" />
                </span>
                {b}
              </li>
            ))}
          </ul>
          <a
            href="/dashboard"
            className="mt-9 inline-flex items-center gap-2 rounded-full border border-border bg-background px-6 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Open dashboard
          </a>
        </div>

        <DashboardPreview />
      </div>
    </section>
  )
}

function DashboardPreview() {
  const channels = [
    { name: "Alex's room", members: 3, locked: false, limit: "6" },
    { name: "chill & code", members: 5, locked: true, limit: "10" },
    { name: "ranked grind", members: 2, locked: false, limit: "5" },
    { name: "movie night", members: 8, locked: false, limit: "∞" },
  ]

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/50">
      <div className="flex items-center justify-between border-b border-border bg-background/60 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Hash className="size-4 text-muted-foreground" />
          Active channels
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          4 live
        </span>
      </div>

      <div className="divide-y divide-border">
        {channels.map((c) => (
          <div key={c.name} className="flex items-center gap-3 px-5 py-4">
            <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
              {c.locked ? <Lock className="size-4" /> : <Volume2 className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-foreground">{c.name}</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {c.locked ? "Private" : "Public"} · limit {c.limit}
              </div>
            </div>
            <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
              <Users className="size-3" />
              {c.members}
            </span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border bg-background/40 px-5 py-4">
        <span className="font-mono text-[11px] text-muted-foreground">18 rooms created today</span>
        <span className="font-mono text-[11px] text-foreground">Nexus Gaming</span>
      </div>
    </div>
  )
}
