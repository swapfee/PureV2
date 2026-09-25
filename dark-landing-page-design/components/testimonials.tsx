import { SectionHeading } from "@/components/section-heading"

const TESTIMONIALS = [
  {
    quote:
      "Pure cut our channel list from 30 dead voice rooms to one. Members make their own space and it disappears when they're done. Our server has never been this clean.",
    name: "Rhys Carter",
    role: "Owner, Nexus Gaming (18k members)",
    initials: "RC",
  },
  {
    quote:
      "The Join to Create flow is so intuitive nobody asks how it works anymore. They just join and get their own room. Setup took me under a minute.",
    name: "Mika Tan",
    role: "Admin, Study Lounge",
    initials: "MT",
  },
  {
    quote: "Being able to lock a channel and pull up the trusted-user list from the dashboard is a game changer for our ranked teams.",
    name: "Diego Ramos",
    role: "Moderator, Valorant Hub",
    initials: "DR",
  },
  {
    quote: "Zero downtime, instant channels, and it just gets out of the way. Easily the most reliable bot on our server.",
    name: "Elena Novak",
    role: "Owner, Dev Café",
    initials: "EN",
  },
  {
    quote: "Members love owning their space — renaming rooms, setting limits, kicking trolls. Pure gives them control without giving them admin.",
    name: "Sam Whitfield",
    role: "Community Lead, Chill Zone",
    initials: "SW",
  },
]

export function Testimonials() {
  return (
    <section id="customers" className="scroll-mt-20 border-t border-border bg-background/50 py-24">
      <div className="mx-auto max-w-6xl px-5">
        <SectionHeading
          eyebrow="Communities"
          title="Trusted by server owners"
          description="From gaming guilds to study groups, Pure keeps voice channels organized and members in control."
        />
      </div>

      <div className="mx-auto mt-14 grid max-w-6xl grid-cols-1 gap-4 px-5 md:grid-cols-2 lg:grid-cols-3">
        {TESTIMONIALS.map((t, i) => (
          <figure
            key={t.name}
            className={`flex flex-col justify-between rounded-2xl border border-border bg-card p-6 ${
              i === 0 ? "lg:row-span-2" : ""
            }`}
          >
            <blockquote className="text-pretty text-[15px] leading-relaxed text-foreground">
              &ldquo;{t.quote}&rdquo;
            </blockquote>
            <figcaption className="mt-6 flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                {t.initials}
              </span>
              <span className="flex flex-col">
                <span className="text-sm font-medium text-foreground">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.role}</span>
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}
