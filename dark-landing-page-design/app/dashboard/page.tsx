import { DashboardApp } from "@/components/dashboard/dashboard-app"
import { getDashboardSnapshot } from "@/lib/dashboard/demo-data"

export const metadata = {
  title: "Dashboard — Pure",
  description: "Configure and monitor Pure Join to Create voice channels.",
}

export default async function DashboardPage() {
  const snapshot = await getDashboardSnapshot()
  return <DashboardApp initialSnapshot={snapshot} />
}
