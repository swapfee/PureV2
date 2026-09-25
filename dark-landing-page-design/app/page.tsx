import { SiteHeader } from "@/components/site-header"
import { Hero } from "@/components/hero"
import { LogoMarquee } from "@/components/logo-marquee"
import { Features } from "@/components/features"
import { Workflow } from "@/components/workflow"
import { Dashboard } from "@/components/dashboard"
import { Stats } from "@/components/stats"
import { Testimonials } from "@/components/testimonials"
import { Pricing } from "@/components/pricing"
import { CTA } from "@/components/cta"
import { SiteFooter } from "@/components/site-footer"

export default function Page() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main>
        <Hero />
        <LogoMarquee />
        <Features />
        <Workflow />
        <Dashboard />
        <Stats />
        <Testimonials />
        <Pricing />
        <CTA />
      </main>
      <SiteFooter />
    </div>
  )
}
