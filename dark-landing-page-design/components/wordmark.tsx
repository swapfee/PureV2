import { cn } from "@/lib/utils"

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className="size-6" />
      <span className="text-[15px] font-semibold tracking-tight text-foreground">Pure</span>
    </span>
  )
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="currentColor" className="text-foreground" />
      {/* stylized voice / waveform mark */}
      <g fill="var(--background)">
        <rect x="6.5" y="10" width="1.8" height="4" rx="0.9" />
        <rect x="10.1" y="7.5" width="1.8" height="9" rx="0.9" />
        <rect x="13.7" y="9" width="1.8" height="6" rx="0.9" />
        <rect x="17.3" y="11" width="1.8" height="2" rx="0.9" opacity="0.7" />
      </g>
    </svg>
  )
}
