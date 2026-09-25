import { Check } from "lucide-react"
import { SectionHeading } from "@/components/section-heading"

const FEATURES = [
  "Join to Create setup and automation",
  "Temporary channel owner controls",
  "Automatic empty-channel cleanup",
  "Voice activity statistics",
  "Web dashboard access",
] as const

export function Pricing() {
  return (
    <section id="pricing" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
      <SectionHeading
        eyebrow="Pricing"
        title="One plan. Everything included."
        description="Run Pure's complete Join to Create system with owner controls, statistics, and dashboard access."
      />

      <div className="mx-auto mt-14 max-w-xl">
        <div className="relative flex flex-col rounded-2xl border border-foreground/30 bg-card p-8 ring-1 ring-foreground/10 sm:p-10">
          <span className="absolute -top-3 left-8 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">
            Complete access
          </span>
          <h3 className="text-sm font-medium uppercase tracking-widest text-muted-foreground">Pure</h3>
          <div className="mt-4 flex items-baseline gap-1">
            <span className="text-5xl font-semibold tracking-tight">$5</span>
            <span className="text-sm text-muted-foreground">/ month</span>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">One straightforward tier with every core feature included.</p>

          <a
            href="#top"
            className="mt-7 inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.02] active:scale-95"
          >
            Add Pure to Discord
          </a>

          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-3 text-sm text-muted-foreground">
                <Check className="size-4 shrink-0 text-foreground" />
                {feature}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
