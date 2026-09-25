"use client"

import { useEffect, useState } from "react"
import { Menu, X } from "lucide-react"
import Link from "next/link"
import { Wordmark } from "@/components/wordmark"
import { cn } from "@/lib/utils"

const NAV = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#workflow" },
  { label: "Dashboard", href: "#dashboard" },
  { label: "Pricing", href: "#pricing" },
]

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
        scrolled ? "border-b border-border bg-background/70 backdrop-blur-xl" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <a href="#top" className="flex items-center gap-2.5" aria-label="Pure home">
          <Wordmark />
        </a>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <a
            href="#"
            className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Support server
          </a>
          <Link
            href="/dashboard"
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.03] active:scale-95"
          >
            Open dashboard
          </Link>
        </div>

        <button
          type="button"
          className="flex size-9 items-center justify-center rounded-md text-foreground md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-border bg-background/95 backdrop-blur-xl md:hidden">
          <nav className="mx-auto flex max-w-6xl flex-col px-5 py-3" aria-label="Mobile">
            {NAV.map((item) => (
              <a
                key={item.label}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
            <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
              <a href="#" className="rounded-md px-2 py-2 text-sm text-muted-foreground">
                Support server
              </a>
              <Link
                href="/dashboard"
                onClick={() => setOpen(false)}
                className="rounded-full bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground"
              >
                Open dashboard
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  )
}
