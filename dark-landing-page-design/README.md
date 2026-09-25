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
- `lib/dashboard/demo-data.ts` is an explicit, temporary demo provider.

The dashboard does not connect directly to Discord, MongoDB, Redis, or the bot's
internal REST proxy. Its current Save action is a local interaction prototype and
does not mutate server configuration.

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
