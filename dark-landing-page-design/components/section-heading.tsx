import { cn } from "@/lib/utils"

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  className,
}: {
  eyebrow?: string
  title: string
  description?: string
  align?: "center" | "left"
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex max-w-2xl flex-col",
        align === "center" ? "mx-auto items-center text-center" : "items-start text-left",
        className,
      )}
    >
      {eyebrow && (
        <span className="mb-4 inline-flex items-center rounded-full border border-border bg-card px-3 py-1 font-mono text-xs uppercase tracking-widest text-muted-foreground">
          {eyebrow}
        </span>
      )}
      <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">{title}</h2>
      {description && (
        <p className="text-balance mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">{description}</p>
      )}
    </div>
  )
}
