import { Wordmark } from "@/components/wordmark"

const COLUMNS = [
  {
    heading: "Product",
    links: ["Features", "How it works", "Dashboard", "Pricing", "Commands"],
  },
  {
    heading: "Community",
    links: ["Support server", "Status", "Changelog", "Feedback", "Vote"],
  },
  {
    heading: "Resources",
    links: ["Docs", "Setup guide", "FAQ", "Blog", "API"],
  },
  {
    heading: "Legal",
    links: ["Privacy", "Terms", "Cookies"],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-6">
          <div className="col-span-2">
            <Wordmark />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              The Join to Create bot for Discord. One channel becomes unlimited private rooms your members fully own.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{col.heading}</h3>
              <ul className="mt-4 space-y-3">
                {col.links.map((link) => (
                  <li key={link}>
                    <a href="#" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-border pt-8 sm:flex-row">
          <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} Pure. Not affiliated with Discord Inc.</p>
          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            All systems operational
          </div>
        </div>
      </div>
    </footer>
  )
}
