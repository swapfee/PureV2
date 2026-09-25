# Pure web experience

This package contains Pure's public landing page and the first dashboard frontend.
It uses Next.js, React, Tailwind CSS, and Bun 1.4.2. The visual system is original
to Pure and intentionally follows the bot's black-and-white identity.

## Run locally

```bash
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:3000` for the landing page or
`http://localhost:3000/dashboard` for the dashboard.

Use `bun run check` before committing. It runs strict TypeScript checking and a
production Next.js build.

## Current architecture

- `app/` owns routes and server-rendered route entry points.
- `components/` owns reusable landing-page and dashboard UI.
- `lib/dashboard/contracts.ts` defines the data contract consumed by the UI.
- `lib/dashboard/demo-data.ts` is used only for an unconfigured local preview.
- `lib/auth/discord.ts` implements encrypted, HTTP-only Discord OAuth sessions.
- `lib/dashboard/control-api.ts` is the server-only coordinator API adapter.

The dashboard does not connect directly to MongoDB, Redis, Discord Gateway, or the
bot's worker REST proxy. Configuration saves are sent through an authenticated
Next.js route to the private coordinator control API, which uses Discordeno's
central REST manager for Discord mutations.

## Backend integration boundary

The production dashboard should replace `getDashboardSnapshot()` with an
authenticated server-side API adapter. That adapter should:

1. Authenticate with Discord OAuth and keep tokens server-side.
2. Verify that the user can manage the selected guild.
3. Call a narrow Pure control-plane API for reads and mutations.
4. Revalidate every permission on the server; never trust browser state.
5. Send operational Discord mutations through the existing coordinator and
   Discordeno REST architecture rather than introducing a second Discord client.

No bot token, MongoDB URI, Redis endpoint, or internal proxy authorization value
belongs in a `NEXT_PUBLIC_` variable or client bundle.
