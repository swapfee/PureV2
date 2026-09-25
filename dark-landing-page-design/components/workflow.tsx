import { SectionHeading } from "@/components/section-heading"

const STEPS = [
  {
    step: "01",
    title: "Join",
    description:
      "A member clicks the “Join to Create” voice channel. That single hub channel is the only thing you set up.",
  },
  {
    step: "02",
    title: "Create",
    description:
      "Pure instantly spins up a brand-new voice channel and moves the member into it as the owner. No waiting, no commands.",
  },
  {
    step: "03",
    title: "Control",
    description:
      "They rename, lock, limit, and moderate their room from slash commands or the dashboard — then it auto-deletes when empty.",
  },
]

export function Workflow() {
  return (
    <section id="workflow" className="relative scroll-mt-20 border-y border-border bg-background/50">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <SectionHeading
          align="left"
          eyebrow="How it works"
          title="Set it up once, then forget it"
          description="Pure turns one channel into unlimited private rooms. There's nothing for your members to learn."
        />

        <ol className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.step} className="group relative bg-card p-8 transition-colors hover:bg-muted/40">
              <div className="font-mono text-sm text-muted-foreground">{s.step}</div>
              <h3 className="mt-6 text-2xl font-semibold tracking-tight">{s.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{s.description}</p>
              <div className="mt-8 h-px w-full bg-border">
                <div className="h-px w-0 bg-foreground transition-all duration-500 group-hover:w-full" />
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
