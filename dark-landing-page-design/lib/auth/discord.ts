import "server-only"

import { cookies } from "next/headers"
import { z } from "zod"

const SESSION_COOKIE = "pure_dashboard_session"
const STATE_COOKIE = "pure_oauth_state"
const DISCORD_API = "https://discord.com/api/v10"
const ADMINISTRATOR = BigInt(1) << BigInt(3)
const MANAGE_GUILD = BigInt(1) << BigInt(5)

const sealedSessionSchema = z.object({ accessToken: z.string().min(1), expiresAt: z.number() })
const viewerSchema = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullish(),
  avatar: z.string().nullish(),
})
const guildSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullish(),
  owner: z.boolean().default(false),
  permissions: z.string(),
})
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() })

interface DiscordOAuthConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly sessionSecret: string
}

interface SealedSession {
  readonly accessToken: string
  readonly expiresAt: number
}

export interface DiscordViewer {
  readonly id: string
  readonly username: string
  readonly globalName?: string
  readonly avatar?: string
}

export interface DiscordGuild {
  readonly id: string
  readonly name: string
  readonly icon?: string
  readonly owner: boolean
  readonly permissions: string
}

export interface DashboardSession {
  readonly viewer: DiscordViewer
  readonly guilds: readonly DiscordGuild[]
}

function readConfig(): DiscordOAuthConfig | undefined {
  const clientId = process.env.DISCORD_CLIENT_ID
  const clientSecret = process.env.DISCORD_CLIENT_SECRET
  const redirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET
  if (!clientId || !clientSecret || !redirectUri || !sessionSecret) return undefined
  if (sessionSecret.length < 32) throw new Error("DASHBOARD_SESSION_SECRET must be at least 32 characters")
  return { clientId, clientSecret, redirectUri, sessionSecret }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"])
}

async function seal(value: SealedSession, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  )
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`
}

async function unseal(value: string, secret: string): Promise<SealedSession | undefined> {
  const [encodedIv, encodedCiphertext] = value.split(".")
  if (!encodedIv || !encodedCiphertext) return undefined
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(encodedIv, "base64url") },
      await encryptionKey(secret),
      Buffer.from(encodedCiphertext, "base64url"),
    )
    const parsed = sealedSessionSchema.parse(JSON.parse(new TextDecoder().decode(decrypted)))
    if (parsed.expiresAt <= Date.now()) return undefined
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt }
  } catch {
    return undefined
  }
}

async function discordGet(path: string, accessToken: string): Promise<unknown> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  })
  if (!response.ok) throw new Error(`Discord OAuth API request failed (${response.status})`)
  return response.json()
}

export function isDiscordOAuthConfigured(): boolean {
  return readConfig() !== undefined
}

export function canManageGuild(guild: DiscordGuild): boolean {
  if (guild.owner) return true
  const permissions = BigInt(guild.permissions)
  return (permissions & ADMINISTRATOR) !== BigInt(0) || (permissions & MANAGE_GUILD) !== BigInt(0)
}

export async function createDiscordAuthorizationUrl(): Promise<string> {
  const config = readConfig()
  if (!config) throw new Error("Discord OAuth is not configured")
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const cookieStore = await cookies()
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/",
  })
  const url = new URL("https://discord.com/oauth2/authorize")
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", config.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", "identify guilds")
  url.searchParams.set("state", state)
  return url.toString()
}

export async function completeDiscordAuthorization(code: string, state: string): Promise<boolean> {
  const config = readConfig()
  if (!config) return false
  const cookieStore = await cookies()
  const expectedState = cookieStore.get(STATE_COOKIE)?.value
  cookieStore.delete(STATE_COOKIE)
  if (!expectedState || expectedState !== state) return false

  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
    cache: "no-store",
  })
  if (!response.ok) return false
  const parsedToken = tokenSchema.safeParse(await response.json())
  if (!parsedToken.success) return false
  const token = parsedToken.data
  const expiresAt = Date.now() + token.expires_in * 1_000
  cookieStore.set(SESSION_COOKIE, await seal({ accessToken: token.access_token, expiresAt }, config.sessionSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.max(60, token.expires_in - 60),
    path: "/",
  })
  return true
}

export async function clearDiscordSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE)
}

export async function getDashboardSession(): Promise<DashboardSession | undefined> {
  const config = readConfig()
  if (!config) return undefined
  const cookieStore = await cookies()
  const value = cookieStore.get(SESSION_COOKIE)?.value
  if (!value) return undefined
  const session = await unseal(value, config.sessionSecret)
  if (!session) return undefined
  try {
    const [rawViewer, rawGuilds] = await Promise.all([
      discordGet("/users/@me", session.accessToken),
      discordGet("/users/@me/guilds", session.accessToken),
    ])
    const parsedViewer = viewerSchema.parse(rawViewer)
    const parsedGuilds = z.array(guildSchema).parse(rawGuilds)
    const viewer: DiscordViewer = {
      id: parsedViewer.id,
      username: parsedViewer.username,
      ...(parsedViewer.global_name ? { globalName: parsedViewer.global_name } : {}),
      ...(parsedViewer.avatar ? { avatar: parsedViewer.avatar } : {}),
    }
    const guilds: DiscordGuild[] = parsedGuilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      owner: guild.owner,
      permissions: guild.permissions,
      ...(guild.icon ? { icon: guild.icon } : {}),
    }))
    return { viewer, guilds: guilds.filter(canManageGuild) }
  } catch {
    return undefined
  }
}
