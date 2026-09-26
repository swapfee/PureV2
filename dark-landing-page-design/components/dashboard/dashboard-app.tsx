"use client"

import { type ReactNode, useEffect, useRef, useState } from "react"
import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Gauge,
  Headphones,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  Menu,
  MessageSquareText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Volume2,
  X,
} from "lucide-react"

import { LogoMark } from "@/components/wordmark"
import { VoiceActivityChart } from "@/components/dashboard/voice-activity-chart"
import type {
  ActivityRangeDays,
  DashboardSection,
  DashboardSnapshot,
  JoinToCreateConfiguration,
  ManagedVoiceChannel,
} from "@/lib/dashboard/contracts"
import { dashboardSnapshotSchema } from "@/lib/dashboard/contracts"
import { cn } from "@/lib/utils"

const NAVIGATION: readonly { id: DashboardSection; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "join-to-create", label: "Join to Create", icon: Sparkles },
  { id: "channels", label: "Active channels", icon: Volume2 },
  { id: "members", label: "Member access", icon: Users },
  { id: "statistics", label: "Statistics", icon: BarChart3 },
  { id: "settings", label: "Server settings", icon: Settings },
]

const SAVED_TOAST_VISIBLE_MS = 3_400
const SAVED_TOAST_EXIT_MS = 700

const DASHBOARD_NOTIFICATIONS = [
  { id: "channel-created", title: "Channel created", detail: "FonZ opened late night talks", time: "2m", section: "channels" as const },
  { id: "settings-updated", title: "Settings updated", detail: "Join to Create defaults were saved", time: "18m", section: "join-to-create" as const },
  { id: "weekly-summary", title: "Weekly summary ready", detail: "Voice activity increased by 18%", time: "1h", section: "statistics" as const },
]

export function DashboardApp({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [activeSection, setActiveSection] = useState<DashboardSection>("overview")
  const [mobileOpen, setMobileOpen] = useState(false)
  const [selectedGuildId, setSelectedGuildId] = useState(initialSnapshot.guild.id)
  const [configuration, setConfiguration] = useState(initialSnapshot.configuration)
  const [savedConfiguration, setSavedConfiguration] = useState(initialSnapshot.configuration)
  const [showSavedToast, setShowSavedToast] = useState(false)
  const [savedToastExiting, setSavedToastExiting] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [activityDays, setActivityDays] = useState<ActivityRangeDays>(7)
  const [activityLoading, setActivityLoading] = useState(false)
  const activityRequestSequence = useRef(0)
  const toastExitTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const toastRemoveTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = JSON.stringify(configuration) !== JSON.stringify(savedConfiguration)
  const selectedGuild = snapshot.guilds.find((guild) => guild.id === selectedGuildId) ?? snapshot.guild

  useEffect(() => () => {
    if (toastExitTimeout.current !== undefined) clearTimeout(toastExitTimeout.current)
    if (toastRemoveTimeout.current !== undefined) clearTimeout(toastRemoveTimeout.current)
  }, [])

  function navigate(section: DashboardSection) {
    setActiveSection(section)
    setMobileOpen(false)
  }

  function showSaveToast(error?: string) {
    setSaveError(error)
    setShowSavedToast(true)
    setSavedToastExiting(false)

    if (toastExitTimeout.current !== undefined) clearTimeout(toastExitTimeout.current)
    if (toastRemoveTimeout.current !== undefined) clearTimeout(toastRemoveTimeout.current)

    toastExitTimeout.current = setTimeout(() => setSavedToastExiting(true), SAVED_TOAST_VISIBLE_MS)
    toastRemoveTimeout.current = setTimeout(() => {
      setShowSavedToast(false)
      setSavedToastExiting(false)
    }, SAVED_TOAST_VISIBLE_MS + SAVED_TOAST_EXIT_MS)
  }

  async function commitConfiguration() {
    if (!dirty || saving) return
    const submittedConfiguration = configuration
    const update = {
      ...(configuration.enabled === savedConfiguration.enabled ? {} : { enabled: configuration.enabled }),
      ...(configuration.lobbyChannelName === savedConfiguration.lobbyChannelName ? {} : { lobbyChannelName: configuration.lobbyChannelName }),
      ...(configuration.categoryName === savedConfiguration.categoryName ? {} : { categoryName: configuration.categoryName }),
      ...(configuration.channelNameTemplate === savedConfiguration.channelNameTemplate ? {} : { channelNameTemplate: configuration.channelNameTemplate }),
      ...(configuration.defaultUserLimit === savedConfiguration.defaultUserLimit ? {} : { defaultUserLimit: configuration.defaultUserLimit }),
      ...(configuration.ownerCanEdit === savedConfiguration.ownerCanEdit ? {} : { ownerCanEdit: configuration.ownerCanEdit }),
    }
    if (Object.keys(update).length === 0) return
    setSaving(true)
    try {
      const response = await fetch(`/api/dashboard/guilds/${selectedGuildId}/config?days=${activityDays}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
        body: JSON.stringify(update),
      })
      const result = zDashboardResponse(await response.json())
      if (!response.ok || !result.snapshot) throw new Error(result.error ?? "Unable to save settings")
      const updatedSnapshot = result.snapshot
      setSnapshot(updatedSnapshot)
      setConfiguration((current) => JSON.stringify(current) === JSON.stringify(submittedConfiguration)
        ? updatedSnapshot.configuration
        : current)
      setSavedConfiguration(updatedSnapshot.configuration)
      showSaveToast()
    } catch (error) {
      showSaveToast(error instanceof Error ? error.message : "Unable to save settings")
    } finally {
      setSaving(false)
    }
  }

  async function changeGuild(guildId: string) {
    if (guildId === selectedGuildId) return
    const requestSequence = activityRequestSequence.current + 1
    activityRequestSequence.current = requestSequence
    setActivityLoading(true)
    try {
      const response = await fetch(`/api/dashboard/guilds/${guildId}/snapshot?days=${activityDays}`, { cache: "no-store" })
      const result = zDashboardResponse(await response.json())
      if (!response.ok || !result.snapshot) throw new Error(result.error ?? "Unable to load server")
      if (activityRequestSequence.current !== requestSequence) return
      setSelectedGuildId(guildId)
      setSnapshot(result.snapshot)
      setConfiguration(result.snapshot.configuration)
      setSavedConfiguration(result.snapshot.configuration)
    } catch (error) {
      if (activityRequestSequence.current === requestSequence) {
        showSaveToast(error instanceof Error ? error.message : "Unable to load server")
      }
    } finally {
      if (activityRequestSequence.current === requestSequence) setActivityLoading(false)
    }
  }

  async function changeActivityRange(days: ActivityRangeDays) {
    if (days === activityDays || activityLoading) return
    const requestSequence = activityRequestSequence.current + 1
    activityRequestSequence.current = requestSequence
    setActivityDays(days)
    setActivityLoading(true)
    try {
      const response = await fetch(
        `/api/dashboard/guilds/${selectedGuildId}/snapshot?days=${days}`,
        { cache: "no-store" },
      )
      const result = zDashboardResponse(await response.json())
      if (!response.ok || !result.snapshot) {
        throw new Error(result.error ?? "Unable to load voice activity")
      }
      if (activityRequestSequence.current === requestSequence) setSnapshot(result.snapshot)
    } catch (error) {
      if (activityRequestSequence.current === requestSequence) {
        setActivityDays(activityDays)
        showSaveToast(error instanceof Error ? error.message : "Unable to load voice activity")
      }
    } finally {
      if (activityRequestSequence.current === requestSequence) setActivityLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#070707] text-foreground">
      <div aria-hidden className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_78%_-10%,rgba(255,255,255,0.08),transparent_28%)]" />
      <DashboardSidebar
        activeSection={activeSection}
        guilds={snapshot.guilds}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onGuildChange={(guildId) => void changeGuild(guildId)}
        onNavigate={navigate}
        selectedGuildId={selectedGuild.id}
      />

      <div className="relative min-h-screen lg:pl-[264px]">
        <DashboardHeader guildName={selectedGuild.name} onMenu={() => setMobileOpen(true)} onNavigate={navigate} viewer={snapshot.viewer} />

        <main className="mx-auto max-w-[1500px] px-4 pb-16 pt-7 sm:px-7 lg:px-10">
          {activeSection === "overview" && <Overview activityDays={activityDays} activityLoading={activityLoading} onActivityRangeChange={(days) => void changeActivityRange(days)} snapshot={snapshot} onNavigate={navigate} />}
          {activeSection === "join-to-create" && (
            <JoinToCreateSettings configuration={configuration} onChange={setConfiguration} onCommit={() => void commitConfiguration()} />
          )}
          {activeSection === "channels" && <ChannelDirectory channels={snapshot.channels} />}
          {activeSection === "members" && <MemberAccessPreview />}
          {activeSection === "statistics" && <StatisticsPanel activityDays={activityDays} loading={activityLoading} onRangeChange={(days) => void changeActivityRange(days)} snapshot={snapshot} expanded />}
          {activeSection === "settings" && <ServerSettings />}
        </main>
      </div>
      <SavedToast error={saveError} exiting={savedToastExiting} visible={showSavedToast} />
    </div>
  )
}

function zDashboardResponse(value: unknown): { snapshot?: DashboardSnapshot; error?: string } {
  if (typeof value !== "object" || value === null) return {}
  const snapshot = dashboardSnapshotSchema.safeParse(Reflect.get(value, "snapshot"))
  const error = Reflect.get(value, "error")
  return {
    ...(snapshot.success ? { snapshot: snapshot.data } : {}),
    ...(typeof error === "string" ? { error } : {}),
  }
}

function DashboardSidebar({
  activeSection,
  guilds,
  mobileOpen,
  onClose,
  onGuildChange,
  onNavigate,
  selectedGuildId,
}: {
  activeSection: DashboardSection
  guilds: DashboardSnapshot["guilds"]
  mobileOpen: boolean
  onClose: () => void
  onGuildChange: (guildId: string) => void
  onNavigate: (section: DashboardSection) => void
  selectedGuildId: string
}) {
  const { menuRootRef, openMenu, setOpenMenu } = useDismissibleMenu<"guild">()
  const selectedGuild = guilds.find((guild) => guild.id === selectedGuildId) ?? guilds[0]

  return (
    <>
      {mobileOpen && <button aria-label="Close navigation" className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden" onClick={onClose} />}
      <aside className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col border-r border-white/[0.08] bg-[#0a0a0a] transition-transform duration-300 lg:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}>
        <div className="flex h-[72px] items-center justify-between border-b border-white/[0.08] px-5">
          <a href="/" className="flex items-center gap-3" aria-label="Pure home">
            <LogoMark className="size-8" />
            <div>
              <div className="text-sm font-semibold tracking-tight">Pure</div>
              <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">Control center</div>
            </div>
          </a>
          <button className="text-muted-foreground lg:hidden" onClick={onClose} aria-label="Close menu"><X className="size-5" /></button>
        </div>

        <div className="relative p-4" ref={menuRootRef}>
          <button
            aria-expanded={openMenu === "guild"}
            aria-haspopup="menu"
            className="flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.035] p-2.5 text-left transition hover:bg-white/[0.06]"
            onClick={() => setOpenMenu((current) => current === "guild" ? null : "guild")}
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-white text-xs font-semibold text-black">{selectedGuild?.initials}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{selectedGuild?.name}</span>
              <span className="block text-[11px] text-muted-foreground">{selectedGuild?.memberCount.toLocaleString()} members</span>
            </span>
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", openMenu === "guild" && "rotate-180")} />
          </button>
          {openMenu === "guild" && (
            <div className="absolute left-4 right-4 top-[76px] z-[70] overflow-hidden rounded-xl border border-white/[0.1] bg-[#111] p-1.5 shadow-2xl shadow-black/60 animate-in fade-in zoom-in-95" role="menu" aria-label="Select a server">
              <div className="px-2.5 pb-1.5 pt-2 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Your servers</div>
              {guilds.map((guild) => {
                const selected = guild.id === selectedGuildId
                return (
                  <button
                    aria-checked={selected}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-white/[0.06]"
                    key={guild.id}
                    onClick={() => {
                      onGuildChange(guild.id)
                      setOpenMenu(null)
                    }}
                    role="menuitemradio"
                  >
                    <span className={cn("flex size-8 items-center justify-center rounded-lg border border-white/[0.08] text-[10px] font-semibold", selected ? "bg-white text-black" : "bg-white/[0.04]")}>{guild.initials}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{guild.name}</span><span className="text-[10px] text-muted-foreground">{guild.memberCount.toLocaleString()} members</span></span>
                    {selected && <Check className="size-3.5" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label="Dashboard navigation">
          <div className="px-3 pb-2 pt-2 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Workspace</div>
          {NAVIGATION.map((item) => {
            const Icon = item.icon
            const selected = activeSection === item.id
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition",
                  selected ? "bg-white text-black" : "text-muted-foreground hover:bg-white/[0.05] hover:text-white",
                )}
              >
                <Icon className="size-4" />
                {item.label}
                {item.id === "channels" && <span className={cn("ml-auto rounded-full px-1.5 py-0.5 font-mono text-[9px]", selected ? "bg-black/10" : "bg-white/[0.07]")}>4</span>}
              </button>
            )
          })}
        </nav>

        <div className="m-4 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
          <div className="flex items-center gap-2 text-xs font-medium"><ShieldCheck className="size-4" /> Bot connected</div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><span className="size-1.5 rounded-full bg-white" /> All systems operational</div>
          <a href="/" className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground transition hover:text-white"><ExternalLink className="size-3" /> Back to website</a>
        </div>
      </aside>
    </>
  )
}

function DashboardHeader({ guildName, onMenu, onNavigate, viewer }: {
  guildName: string
  onMenu: () => void
  onNavigate: (section: DashboardSection) => void
  viewer: DashboardSnapshot["viewer"]
}) {
  const { menuRootRef, openMenu, setOpenMenu } = useDismissibleMenu<"help" | "notifications" | "profile">()
  const [readNotificationIds, setReadNotificationIds] = useState<ReadonlySet<string>>(() => new Set())
  const unreadCount = DASHBOARD_NOTIFICATIONS.filter((notification) => !readNotificationIds.has(notification.id)).length

  function openSection(section: DashboardSection) {
    onNavigate(section)
    setOpenMenu(null)
  }

  function readNotification(id: string, section: DashboardSection) {
    setReadNotificationIds((current) => new Set(current).add(id))
    openSection(section)
  }

  return (
    <header className="sticky top-0 z-30 flex h-[72px] items-center justify-between border-b border-white/[0.08] bg-[#070707]/85 px-4 backdrop-blur-xl sm:px-7 lg:px-10">
      <div className="flex items-center gap-3">
        <button className="flex size-9 items-center justify-center rounded-lg border border-white/[0.08] lg:hidden" onClick={onMenu} aria-label="Open menu"><Menu className="size-4" /></button>
        <div>
          <div className="text-sm font-medium">{guildName}</div>
          <div className="text-[11px] text-muted-foreground">Server dashboard</div>
        </div>
      </div>
      <div className="relative flex items-center gap-2" ref={menuRootRef}>
        <button aria-expanded={openMenu === "help"} aria-haspopup="menu" className={headerButtonClass(openMenu === "help")} onClick={() => setOpenMenu((current) => current === "help" ? null : "help")} aria-label="Help"><CircleHelp className="size-4" /></button>
        <button aria-expanded={openMenu === "notifications"} aria-haspopup="menu" className={cn(headerButtonClass(openMenu === "notifications"), "relative")} onClick={() => setOpenMenu((current) => current === "notifications" ? null : "notifications")} aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}><Bell className="size-4" />{unreadCount > 0 && <span className="absolute right-2 top-2 size-1.5 rounded-full bg-white" />}</button>
        <button aria-expanded={openMenu === "profile"} aria-haspopup="menu" className={cn("ml-1 flex size-9 items-center justify-center overflow-hidden rounded-full border text-xs font-semibold transition", openMenu === "profile" ? "border-white bg-white text-black" : "border-white/15 bg-white/[0.06] hover:bg-white/[0.12]")} onClick={() => setOpenMenu((current) => current === "profile" ? null : "profile")} aria-label="Open user profile">{viewer.avatarUrl ? <img alt="" className="size-full object-cover" src={viewer.avatarUrl} /> : viewer.displayName.slice(0, 1).toUpperCase()}</button>

        {openMenu === "help" && (
          <HeaderPopover align="right" label="Help menu" width="w-72">
            <PopoverHeading title="Help & resources" description="Quick guidance for your Pure dashboard." />
            <MenuAction icon={BookOpen} label="Dashboard guide" detail="Review the server overview" onClick={() => openSection("overview")} />
            <MenuAction icon={Sparkles} label="Setup checklist" detail="Configure Join to Create" onClick={() => openSection("join-to-create")} />
            <MenuAction icon={LifeBuoy} label="Support" detail="View member access tools" onClick={() => openSection("members")} />
            <div className="mx-2 mt-1 flex items-center gap-2 border-t border-white/[0.08] px-1 pt-3 text-[10px] text-muted-foreground"><span className="size-1.5 rounded-full bg-white" />All systems operational</div>
          </HeaderPopover>
        )}

        {openMenu === "notifications" && (
          <HeaderPopover align="right" label="Notifications menu" width="w-80">
            <div className="flex items-start justify-between px-2.5 pb-2 pt-2">
              <PopoverHeading title="Notifications" description={unreadCount > 0 ? `${unreadCount} unread updates` : "You are all caught up"} compact />
              {unreadCount > 0 && <button className="text-[10px] text-muted-foreground transition hover:text-white" onClick={() => setReadNotificationIds(new Set(DASHBOARD_NOTIFICATIONS.map(({ id }) => id)))}>Mark all read</button>}
            </div>
            <div className="space-y-1">
              {DASHBOARD_NOTIFICATIONS.map((notification) => {
                const read = readNotificationIds.has(notification.id)
                return (
                  <button className="flex w-full gap-3 rounded-lg px-2.5 py-2.5 text-left transition hover:bg-white/[0.06]" key={notification.id} onClick={() => readNotification(notification.id, notification.section)} role="menuitem">
                    <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", read ? "bg-white/15" : "bg-white")} />
                    <span className="min-w-0 flex-1"><span className={cn("block text-xs", read ? "text-muted-foreground" : "font-medium")}>{notification.title}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{notification.detail}</span></span>
                    <span className="pt-0.5 font-mono text-[9px] text-muted-foreground/70">{notification.time}</span>
                  </button>
                )
              })}
            </div>
          </HeaderPopover>
        )}

        {openMenu === "profile" && (
          <HeaderPopover align="right" label="User profile menu" width="w-64">
            <div className="flex items-center gap-3 px-2.5 py-2.5">
              <span className="flex size-10 items-center justify-center overflow-hidden rounded-full bg-white text-sm font-semibold text-black">{viewer.avatarUrl ? <img alt="" className="size-full object-cover" src={viewer.avatarUrl} /> : viewer.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{viewer.displayName}</span><span className="block truncate text-[10px] text-muted-foreground">@{viewer.username}</span></span>
            </div>
            <div className="my-1 border-t border-white/[0.08]" />
            <MenuAction icon={Settings} label="Server settings" detail={guildName} onClick={() => openSection("settings")} />
            <a className="flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition hover:bg-white/[0.06]" href="/"><ExternalLink className="size-4 text-muted-foreground" /><span className="flex-1 text-xs">Back to website</span><ChevronRight className="size-3 text-muted-foreground" /></a>
            <form action="/api/auth/logout" method="post"><button className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left text-xs transition hover:bg-white/[0.06]" type="submit"><X className="size-4 text-muted-foreground" />Sign out</button></form>
          </HeaderPopover>
        )}
      </div>
    </header>
  )
}

function useDismissibleMenu<T extends string>() {
  const [openMenu, setOpenMenu] = useState<T | null>(null)
  const menuRootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function dismissOnOutsideClick(event: PointerEvent) {
      const root = menuRootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpenMenu(null)
    }

    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null)
    }

    document.addEventListener("pointerdown", dismissOnOutsideClick)
    document.addEventListener("keydown", dismissOnEscape)
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsideClick)
      document.removeEventListener("keydown", dismissOnEscape)
    }
  }, [])

  return { menuRootRef, openMenu, setOpenMenu }
}

function headerButtonClass(active: boolean) {
  return cn(
    "flex size-9 items-center justify-center rounded-lg border transition",
    active ? "border-white bg-white text-black" : "border-white/[0.08] text-muted-foreground hover:bg-white/[0.05] hover:text-white",
  )
}

function HeaderPopover({ align, children, label, width }: { align: "left" | "right"; children: ReactNode; label: string; width: string }) {
  return (
    <div
      aria-label={label}
      className={cn("absolute top-12 z-[80] rounded-xl border border-white/[0.1] bg-[#111] p-1.5 shadow-2xl shadow-black/60 animate-in fade-in zoom-in-95", align === "right" ? "right-0" : "left-0", width)}
      role="menu"
    >
      {children}
    </div>
  )
}

function PopoverHeading({ compact = false, description, title }: { compact?: boolean; description: string; title: string }) {
  return <div className={cn("px-2.5", !compact && "pb-2 pt-2")}><div className="text-xs font-medium">{title}</div><div className="mt-1 text-[10px] text-muted-foreground">{description}</div></div>
}

function MenuAction({ detail, icon: Icon, label, onClick }: { detail: string; icon: typeof CircleHelp; label: string; onClick: () => void }) {
  return (
    <button className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition hover:bg-white/[0.06]" onClick={onClick} role="menuitem">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.025]"><Icon className="size-3.5 text-muted-foreground" /></span>
      <span className="min-w-0 flex-1"><span className="block text-xs font-medium">{label}</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{detail}</span></span>
      <ChevronRight className="size-3 text-muted-foreground" />
    </button>
  )
}

function SavedToast({ error, exiting, visible }: { error?: string; exiting: boolean; visible: boolean }) {
  if (!visible) return null

  return (
    <div
      aria-live="polite"
      className={cn(
        "fixed bottom-5 right-5 z-[70] flex max-w-[calc(100vw-2.5rem)] items-center gap-3 rounded-xl border border-white/[0.12] bg-[#111] px-4 py-3 shadow-2xl shadow-black/50",
        exiting ? "settings-toast-exit" : "settings-toast-enter",
      )}
      role="status"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-black">
        {error ? <X className="size-4" /> : <CheckCircle2 className="size-4" />}
      </span>
      <div>
        <div className="text-xs font-medium">{error ? "Settings not saved" : "Settings saved"}</div>
        <div className="mt-0.5 max-w-72 text-[10px] text-muted-foreground">{error ?? "Your configuration is up to date."}</div>
      </div>
    </div>
  )
}

function Overview({
  activityDays,
  activityLoading,
  snapshot,
  onActivityRangeChange,
  onNavigate,
}: {
  activityDays: ActivityRangeDays
  activityLoading: boolean
  snapshot: DashboardSnapshot
  onActivityRangeChange: (days: ActivityRangeDays) => void
  onNavigate: (section: DashboardSection) => void
}) {
  return (
    <div className="space-y-7">
      <PageHeading eyebrow="Overview" title={`Welcome, ${snapshot.viewer.displayName}.`} description="Here is what is happening across your managed voice channels." />
      <SummaryGrid snapshot={snapshot} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.55fr)]">
        <StatisticsPanel activityDays={activityDays} loading={activityLoading} onRangeChange={onActivityRangeChange} snapshot={snapshot} />
        <RecentActivityList activity={snapshot.activity} />
      </div>
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div><h2 className="text-lg font-semibold tracking-tight">Active voice channels</h2><p className="mt-1 text-xs text-muted-foreground">Live managed rooms in this server.</p></div>
          <button onClick={() => onNavigate("channels")} className="text-xs text-muted-foreground transition hover:text-white">View all channels →</button>
        </div>
        <ChannelGrid channels={snapshot.channels.slice(0, 4)} />
      </section>
    </div>
  )
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div><div className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">{eyebrow}</div><h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p></div>
}

function SummaryGrid({ snapshot }: { snapshot: DashboardSnapshot }) {
  const cards = [
    { label: "Active channels", value: snapshot.summary.activeChannels, detail: "+2 in the last hour", icon: Headphones },
    { label: "Members in voice", value: snapshot.summary.connectedMembers, detail: "Across managed rooms", icon: Users },
    { label: "Voice sessions", value: snapshot.summary.voiceSessions, detail: "Selected activity range", icon: Activity },
    { label: "Average session", value: `${snapshot.summary.averageSessionMinutes}m`, detail: "Past seven days", icon: Clock3 },
  ]
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(({ label, value, detail, icon: Icon }) => <article key={label} className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5"><div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">{label}</span><span className="flex size-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.025]"><Icon className="size-4" /></span></div><div className="mt-5 text-3xl font-semibold tracking-tight">{value}</div><div className="mt-2 text-[11px] text-muted-foreground">{detail}</div></article>)}</div>
}

function StatisticsPanel({
  activityDays,
  loading,
  onRangeChange,
  snapshot,
  expanded = false,
}: {
  activityDays: ActivityRangeDays
  loading: boolean
  onRangeChange: (days: ActivityRangeDays) => void
  snapshot: DashboardSnapshot
  expanded?: boolean
}) {
  return <section className={cn("rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5 sm:p-6", expanded && "min-h-[520px]")}><div className="flex items-start justify-between"><div><h2 className="text-sm font-medium">Voice activity</h2><p className="mt-1 text-[11px] text-muted-foreground">Minutes spent in managed rooms · UTC</p></div><select aria-label="Voice activity range" className="rounded-lg border border-white/[0.08] bg-black px-2.5 py-1.5 text-[11px] text-muted-foreground outline-none disabled:cursor-wait disabled:opacity-50" disabled={loading} onChange={(event) => onRangeChange(event.target.value === "30" ? 30 : 7)} value={activityDays}><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></div><div className={cn("mt-7 min-w-0 transition-opacity", loading && "opacity-45", expanded ? "h-[390px]" : "h-[245px]")}><VoiceActivityChart data={snapshot.voiceActivity} /></div></section>
}

function RecentActivityList({ activity }: { activity: DashboardSnapshot["activity"] }) {
  return <section className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5"><div className="flex items-center justify-between"><div><h2 className="text-sm font-medium">Recent activity</h2><p className="mt-1 text-[11px] text-muted-foreground">Latest managed channel events</p></div><MessageSquareText className="size-4 text-muted-foreground" /></div><div className="mt-5 space-y-1">{activity.map((item) => <div key={item.id} className="flex gap-3 rounded-xl p-3 transition hover:bg-white/[0.025]"><span className="mt-1 size-2 rounded-full border border-white bg-black"/><div className="min-w-0"><div className="text-xs font-medium">{item.title}</div><div className="mt-1 truncate text-[11px] text-muted-foreground">{item.detail}</div><div className="mt-1.5 font-mono text-[9px] text-muted-foreground/70">{item.occurredAt}</div></div></div>)}</div></section>
}

function ChannelGrid({ channels }: { channels: readonly ManagedVoiceChannel[] }) {
  return <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">{channels.map((channel) => <article key={channel.id} className="group rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-4 transition hover:border-white/[0.16]"><div className="flex items-start justify-between"><span className="flex size-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.025]"><Volume2 className="size-4" /></span><div className="flex gap-1.5">{channel.hidden && <span className="rounded-md border border-white/[0.08] px-1.5 py-1 font-mono text-[8px] text-muted-foreground">HIDDEN</span>}{channel.locked && <Lock className="size-3.5 text-muted-foreground" />}</div></div><h3 className="mt-4 truncate text-sm font-medium">{channel.name}</h3><p className="mt-1 text-[11px] text-muted-foreground">Owned by {channel.ownerName}</p><div className="mt-4 flex items-center justify-between border-t border-white/[0.07] pt-3 text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><Users className="size-3" />{channel.memberCount}/{channel.userLimit || "∞"}</span><span>{channel.createdMinutesAgo}m active</span></div></article>)}</div>
}

function ChannelDirectory({ channels }: { channels: readonly ManagedVoiceChannel[] }) {
  return <div className="space-y-7"><PageHeading eyebrow="Voice channels" title="Active managed rooms" description="Monitor every temporary voice channel without interrupting the people inside."/><ChannelGrid channels={channels}/><div className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5 text-center text-xs text-muted-foreground">Channel mutations will be available after Discord OAuth and the authenticated control API are connected.</div></div>
}

function JoinToCreateSettings({ configuration, onChange, onCommit }: { configuration: JoinToCreateConfiguration; onChange: (value: JoinToCreateConfiguration) => void; onCommit: () => void }) {
  const update = <Key extends keyof JoinToCreateConfiguration>(key: Key, value: JoinToCreateConfiguration[Key]) => onChange({ ...configuration, [key]: value })
  return <div className="space-y-7"><PageHeading eyebrow="Configuration" title="Join to Create" description="Set the defaults that Pure applies whenever a member creates a new room."/><div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]"><section className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5 sm:p-7"><div className="flex items-center justify-between border-b border-white/[0.08] pb-5"><div><h2 className="text-sm font-medium">Core configuration</h2><p className="mt-1 text-[11px] text-muted-foreground">Changes save automatically when you leave a field.</p></div><Toggle checked={configuration.enabled} onBlur={onCommit} onChange={(value) => update("enabled", value)} label="System enabled"/></div><div className="mt-6 grid gap-5 sm:grid-cols-2"><Field label="Lobby channel" value={configuration.lobbyChannelName} onBlur={onCommit} onChange={(value) => update("lobbyChannelName", value)}/><Field label="Temporary category" value={configuration.categoryName} onBlur={onCommit} onChange={(value) => update("categoryName", value)}/><Field className="sm:col-span-2" label="Channel name template" value={configuration.channelNameTemplate} hint="Variables: {username}, {displayname}" onBlur={onCommit} onChange={(value) => update("channelNameTemplate", value)}/><Field label="Default user limit" value={String(configuration.defaultUserLimit)} hint="0 means unlimited" inputMode="numeric" onBlur={onCommit} onChange={(value) => update("defaultUserLimit", Math.min(99, Math.max(0, Number.parseInt(value || "0", 10) || 0)))}/></div><div className="mt-7 space-y-3 border-t border-white/[0.08] pt-6"><SettingToggle title="Owner channel editing" description="Let owners rename and configure their rooms." checked={configuration.ownerCanEdit} onBlur={onCommit} onChange={(value) => update("ownerCanEdit", value)}/><div className="flex items-center justify-between gap-5 rounded-xl border border-white/[0.07] bg-black/40 p-4"><div><div className="text-xs font-medium">Voice control interface</div><div className="mt-1 text-[10px] text-muted-foreground">Managed through /setup interface for now.</div></div><span className="text-[10px] text-muted-foreground">{configuration.interfaceEnabled ? "Enabled" : "Disabled"}</span></div></div></section><ConfigurationPreview configuration={configuration}/></div></div>
}

function ConfigurationPreview({ configuration }: { configuration: JoinToCreateConfiguration }) {
  return <aside className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5"><div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Live preview</div><div className="mt-5 rounded-xl border border-white/[0.08] bg-black p-4"><div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"><ChevronDown className="size-3" />{configuration.categoryName}</div><div className="mt-3 space-y-1.5"><div className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2.5 text-xs"><Volume2 className="size-3.5 text-muted-foreground"/>{configuration.lobbyChannelName}</div><div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground"><Volume2 className="size-3.5"/>{configuration.channelNameTemplate.replace("{username}", "FonZ").replace("{displayname}", "FonZ")}</div></div></div><div className="mt-5 space-y-3 text-[11px]"><PreviewRow label="System" value={configuration.enabled ? "Enabled" : "Disabled"}/><PreviewRow label="User limit" value={configuration.defaultUserLimit === 0 ? "Unlimited" : String(configuration.defaultUserLimit)}/><PreviewRow label="Owner controls" value={configuration.ownerCanEdit ? "Allowed" : "Restricted"}/><PreviewRow label="Interface" value={configuration.interfaceEnabled ? "Enabled" : "Disabled"}/></div><div className="mt-6 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 text-[10px] leading-relaxed text-muted-foreground">This preview does not write to Discord. Production saves will pass through an authenticated API and the existing coordinator REST boundary.</div></aside>
}

function MemberAccessPreview() {
  return <div className="space-y-7"><PageHeading eyebrow="Access" title="Member controls" description="Review persistent blocks and room-specific access from one place."/><div className="grid gap-4 md:grid-cols-3">{["Trusted members", "Persistent blocks", "Recent requests"].map((title, index) => <section key={title} className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">{title}</h2><span className="font-mono text-xs text-muted-foreground">{[12, 3, 8][index]}</span></div><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Member identities will load from the authenticated guild context.</p></section>)}</div></div>
}

function ServerSettings() {
  return <div className="space-y-7"><PageHeading eyebrow="Settings" title="Server preferences" description="Dashboard access, moderation roles, notifications, and data controls."/><div className="grid gap-4 md:grid-cols-2"><SettingsCard icon={ShieldCheck} title="Moderator access" description="Choose roles allowed to configure Pure."/><SettingsCard icon={Bell} title="Operational alerts" description="Control setup, reconciliation, and lifecycle notifications."/><SettingsCard icon={Gauge} title="Performance" description="Review worker, queue, and gateway health."/><SettingsCard icon={SlidersHorizontal} title="Data controls" description="Manage statistics retention and factory reset behavior."/></div></div>
}

function SettingsCard({ icon: Icon, title, description }: { icon: typeof Settings; title: string; description: string }) {
  return <button className="flex items-start gap-4 rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-5 text-left transition hover:border-white/[0.16]"><span className="flex size-10 items-center justify-center rounded-xl border border-white/[0.08]"><Icon className="size-4"/></span><span><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{description}</span></span></button>
}

function Toggle({ checked, onChange, onBlur, label }: { checked: boolean; onChange: (value: boolean) => void; onBlur: () => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} onBlur={onBlur} onClick={() => onChange(!checked)} className={cn("relative h-6 w-11 rounded-full border transition", checked ? "border-white bg-white" : "border-white/15 bg-black")}><span className={cn("absolute top-0.5 size-4.5 rounded-full transition", checked ? "left-[21px] bg-black" : "left-0.5 bg-white/60")}/></button>
}

function SettingToggle({ title, description, checked, onChange, onBlur }: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void; onBlur: () => void }) {
  return <div className="flex items-center justify-between gap-5 rounded-xl border border-white/[0.07] bg-black/40 p-4"><div><div className="text-xs font-medium">{title}</div><div className="mt-1 text-[10px] text-muted-foreground">{description}</div></div><Toggle checked={checked} onBlur={onBlur} onChange={onChange} label={title}/></div>
}

function Field({ label, value, hint, className, inputMode, onChange, onBlur }: { label: string; value: string; hint?: string; className?: string; inputMode?: "text" | "numeric"; onChange: (value: string) => void; onBlur: () => void }) {
  return <label className={className}><span className="text-[11px] font-medium">{label}</span><input value={value} inputMode={inputMode} onBlur={onBlur} onChange={(event) => onChange(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-white/[0.09] bg-black px-3 text-xs outline-none transition placeholder:text-muted-foreground focus:border-white/30"/>{hint && <span className="mt-1.5 block text-[9px] text-muted-foreground">{hint}</span>}</label>
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between"><span className="text-muted-foreground">{label}</span><span>{value}</span></div>
}
