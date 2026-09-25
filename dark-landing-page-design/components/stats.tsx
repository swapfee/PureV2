const STATS = [
  { value: "12K+", label: "Servers powered" },
  { value: "4.8M", label: "Channels created" },
  { value: "99.9%", label: "Bot uptime" },
  { value: "<50ms", label: "Channel spin-up" },
]

export function Stats() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-24">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border md:grid-cols-4">
        {STATS.map((s) => (
          <div key={s.label} className="bg-card px-6 py-10 text-center">
            <div className="text-4xl font-semibold tracking-tight sm:text-5xl">{s.value}</div>
            <div className="mt-2 text-sm text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
