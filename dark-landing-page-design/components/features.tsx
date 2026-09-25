import { Ban, Gauge, Lock, ShieldCheck, SlidersHorizontal, Users } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { SectionHeading } from "@/components/section-heading"

type Feature = {
  icon: LucideIcon
  title: string
  description: string
  className?: string
  visual?: React.ReactNode
}

const FEATURES: Feature[] = [
  {
    icon: SlidersHorizontal,
    title: "Full channel ownership",
    description:
      "The moment a room is created, it belongs to the member who made it. Rename it, change the region, set a user limit, and edit bitrate — no admin needed.",
    className: "md:col-span-2",
    visual: <ControlsVisual />,
  },
  {
    icon: Lock,
    title: "Lock & hide",
    description: "Make a room private in one tap. Only approved members can see or join a locked channel.",
  },
  {
    icon: Users,
    title: "Trusted & blocked users",
    description: "Whitelist your friends so they always get in, and permanently block anyone you never want back.",
  },
  {
    icon: ShieldCheck,
    title: "Owner moderation",
    description:
      "Kick, mute, and transfer ownership from a slash command or the dashboard. Owners run their room like a mini-server.",
    className: "md:col-span-2",
    visual: <ModVisual />,
  },
  {
    icon: Gauge,
    title: "Instant & lightweight",
    description: "Channels spin up in milliseconds and clean themselves up the second the last person leaves.",
  },
  {
    icon: Ban,
    title: "No clutter",
    description: "Empty temporary channels delete automatically, so your server list stays clean and organized.",
  },
]

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHeading
        eyebrow="Features"
        title="Everything a voice channel should be"
        description="Pure hands control back to your members while keeping your server tidy. Powerful for owners, effortless for everyone."
      />

      <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
        {FEATURES.map((f) => (
          <article
            key={f.title}
            className={`group relative overflow-hidden rounded-2xl border border-border bg-card p-6 transition-colors hover:border-foreground/20 ${f.className ?? ""}`}
          >
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-background">
              <f.icon className="size-5 text-foreground" />
            </div>
            <h3 className="mt-5 text-lg font-medium tracking-tight">{f.title}</h3>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{f.description}</p>
            {f.visual}
          </article>
        ))}
      </div>
    </section>
  )
}

function ControlsVisual() {
  const rows = [
    { label: "Channel name", value: "Alex's room" },
    { label: "User limit", value: "6" },
    { label: "Bitrate", value: "96 kbps" },
    { label: "Region", value: "Auto" },
  ]
  return (
    <div className="mt-6 space-y-2 font-mono text-xs">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2"
        >
          <span className="text-muted-foreground">{r.label}</span>
          <span className="text-foreground">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function ModVisual() {
  const cmds = [
    { cmd: "/lock", desc: "Room set to private" },
    { cmd: "/limit 6", desc: "User limit updated" },
    { cmd: "/transfer @jordan", desc: "Ownership handed over" },
  ]
  return (
    <div className="mt-6 space-y-2 font-mono text-xs">
      {cmds.map((c) => (
        <div
          key={c.cmd}
          className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2"
        >
          <span className="text-foreground">{c.cmd}</span>
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            {c.desc}
          </span>
        </div>
      ))}
    </div>
  )
}
