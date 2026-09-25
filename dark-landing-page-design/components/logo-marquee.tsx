const COMMUNITIES = [
  "Nexus Gaming",
  "Study Lounge",
  "Valorant Hub",
  "Dev Café",
  "The Arcade",
  "Chill Zone",
  "Anime Union",
  "Late Night",
]

export function LogoMarquee() {
  return (
    <section className="border-y border-border bg-background/50 py-10">
      <p className="mb-8 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
        Powering voice on 12,000+ Discord servers
      </p>
      <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_12%,#000_88%,transparent)]">
        <div className="flex w-max animate-marquee items-center gap-16 pr-16">
          {[...COMMUNITIES, ...COMMUNITIES].map((name, i) => (
            <span
              key={`${name}-${i}`}
              className="whitespace-nowrap text-xl font-semibold tracking-tight text-muted-foreground/70"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
