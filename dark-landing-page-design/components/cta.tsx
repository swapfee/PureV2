import { ArrowRight } from "lucide-react"

export function CTA() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-24">
      <div className="relative overflow-hidden rounded-3xl border border-border bg-card px-6 py-20 text-center">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-grid opacity-60 mask-fade" />
          <div className="absolute left-1/2 top-0 h-64 w-[640px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,oklch(1_0_0_/_12%),transparent_65%)] blur-2xl" />
        </div>

        <div className="relative">
          <h2 className="text-balance mx-auto max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Give your members their own voice
          </h2>
          <p className="text-balance mx-auto mt-4 max-w-lg text-lg text-muted-foreground">
            Add Pure to your server in under a minute and turn one channel into unlimited private rooms.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#"
              className="group inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.03] active:scale-95"
            >
              Add to Discord
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a
              href="#"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-6 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Join support server
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
