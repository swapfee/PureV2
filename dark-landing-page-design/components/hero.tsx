import { ArrowRight, Hash, Lock, Mic, Plus, Settings2, UserPlus, Users, Volume2 } from "lucide-react"

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-16">
      {/* backdrop layers */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-0 bg-grid mask-fade" />
        <div className="animate-glow absolute left-1/2 top-[-10%] -z-10 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,oklch(1_0_0_/_14%),transparent_60%)] blur-2xl" />
        <div className="grain absolute inset-0 opacity-[0.035]" />
      </div>

      <div className="mx-auto max-w-6xl px-5 pb-24 pt-20 sm:pt-28">
        <div className="flex flex-col items-center text-center">
          <a
            href="#"
            className="group mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 py-1.5 pl-1.5 pr-3 text-xs text-muted-foreground backdrop-blur"
          >
            <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">New</span>
            Web dashboard — control every channel from your browser
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </a>

          <h1 className="text-balance text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl md:text-7xl">
            A voice channel
            <br />
            for every member.
          </h1>

          <p className="text-balance mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Pure is the Join to Create bot for Discord. Members join one channel and instantly get a private room they
            fully own — rename it, lock it, set a limit, and moderate it, all in a click.
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <a
              href="#"
              className="group inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.03] active:scale-95"
            >
              Add to Discord
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href="#dashboard"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-6 py-3 text-sm font-medium text-foreground backdrop-blur transition-colors hover:bg-card"
            >
              View the dashboard
            </a>
          </div>

          <p className="mt-5 font-mono text-xs text-muted-foreground/70">
            $5 per month · Full Join to Create controls · Web dashboard included
          </p>
        </div>

        {/* Product preview */}
        <div className="relative mx-auto mt-16 max-w-5xl">
          <div className="absolute -inset-x-8 -top-8 bottom-0 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_top,oklch(1_0_0_/_8%),transparent_70%)]" />
          <DiscordPreview />
        </div>
      </div>
    </section>
  )
}

function DiscordPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/60">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-border bg-background/60 px-4 py-3">
        <div className="flex gap-1.5">
          <span className="size-3 rounded-full bg-muted-foreground/30" />
          <span className="size-3 rounded-full bg-muted-foreground/30" />
          <span className="size-3 rounded-full bg-muted-foreground/30" />
        </div>
        <div className="ml-3 flex-1">
          <div className="mx-auto w-fit rounded-md border border-border bg-muted/50 px-3 py-1 font-mono text-[11px] text-muted-foreground">
            discord.com/channels/pure
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12">
        {/* channel list */}
        <div className="col-span-4 flex-col gap-1 border-r border-border bg-background/40 p-3 sm:col-span-3 sm:flex">
          <div className="px-1.5 pb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Voice channels
          </div>

          <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-foreground">
            <Plus className="size-3.5 shrink-0" />
            Join to Create
          </div>

          {[
            { name: "Alex's room", active: true, locked: false, count: "3" },
            { name: "chill & code", active: false, locked: true, count: "5" },
            { name: "ranked grind", active: false, locked: false, count: "2" },
          ].map((c) => (
            <div
              key={c.name}
              className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-xs ${
                c.active ? "bg-muted text-foreground" : "text-muted-foreground"
              }`}
            >
              {c.locked ? <Lock className="size-3.5 shrink-0" /> : <Volume2 className="size-3.5 shrink-0" />}
              <span className="truncate">{c.name}</span>
              <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/70">
                <Users className="size-3" />
                {c.count}
              </span>
            </div>
          ))}
        </div>

        {/* channel control panel */}
        <div className="col-span-8 bg-dots p-5 sm:col-span-9 sm:p-6">
          <div className="mx-auto max-w-md space-y-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Hash className="size-4 text-muted-foreground" />
                Alex&apos;s room
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-emerald-400" />
                  Owner
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                {[
                  { icon: Settings2, label: "Rename" },
                  { icon: Lock, label: "Lock" },
                  { icon: Users, label: "Set limit" },
                  { icon: UserPlus, label: "Invite" },
                ].map((b) => (
                  <div
                    key={b.label}
                    className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground"
                  >
                    <b.icon className="size-3.5" />
                    {b.label}
                  </div>
                ))}
              </div>
            </div>

            {/* members */}
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                In channel — 3
              </div>
              <div className="space-y-2">
                {[
                  { n: "Alex", tag: "Owner", muted: false },
                  { n: "Jordan", tag: "", muted: false },
                  { n: "Sam", tag: "", muted: true },
                ].map((m) => (
                  <div key={m.n} className="flex items-center gap-2.5">
                    <span className="flex size-7 items-center justify-center rounded-full border border-border bg-background text-[10px] font-medium text-foreground">
                      {m.n[0]}
                    </span>
                    <span className="text-xs text-foreground">{m.n}</span>
                    {m.tag && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                        {m.tag}
                      </span>
                    )}
                    <Mic
                      className={`ml-auto size-3.5 ${m.muted ? "text-muted-foreground/40" : "text-foreground"}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
