# PureV2 dashboard deployment

The dashboard is a separate Next.js container. It talks to the coordinator over
the private Docker network; it never connects to MongoDB, Redis, Discord Gateway,
or the worker REST proxy.

## Security boundaries

- `8081` is the worker REST proxy and remains loopback-only inside the bot container.
- `8082` is the authenticated dashboard control API and is not published by Compose.
- `3100` is published only to VPS loopback (`127.0.0.1`).
- Only a host reverse proxy should publish the dashboard to the internet over HTTPS.
- The dashboard container receives no bot token and no MongoDB URI.
- Every dashboard request is re-authorized with Discord OAuth. Only server owners,
  administrators, and members with Manage Server are shown a guild.

## Discord Developer Portal

1. Open the existing Pure application and select **OAuth2**.
2. Copy the OAuth client secret into the VPS `.env` as `DISCORD_CLIENT_SECRET`.
3. Add the exact redirect URL:

   `https://dashboard.example.com/api/auth/discord/callback`

4. Replace `dashboard.example.com` with the real dashboard domain. The callback
   must exactly match `DISCORD_OAUTH_REDIRECT_URI`.
5. No additional Gateway intents are required for dashboard sign-in. OAuth uses
   only `identify` and `guilds`.

## VPS environment

From `/opt/purev2`, edit the existing `.env` and add:

```env
DASHBOARD_API_HOST=0.0.0.0
DASHBOARD_API_PORT=8082
DASHBOARD_API_AUTHORIZATION=GENERATE_A_RANDOM_VALUE
DASHBOARD_API_BODY_LIMIT_BYTES=32768

PUREV2_DASHBOARD_GUILD_ID=1539918723396407357
DISCORD_CLIENT_SECRET=PASTE_THE_OAUTH_CLIENT_SECRET
DISCORD_OAUTH_REDIRECT_URI=https://dashboard.example.com/api/auth/discord/callback
DASHBOARD_SESSION_SECRET=GENERATE_A_DIFFERENT_RANDOM_VALUE
```

Generate the two independent random values without printing them into source:

```bash
openssl rand -hex 32
openssl rand -hex 32
chmod 600 .env
```

Do not reuse `REST_PROXY_AUTHORIZATION` for either value.

## First private test through SSH

Build and start both containers:

```bash
cd /opt/purev2
git fetch origin
git switch web-dev
git pull --ff-only origin web-dev
docker compose config --quiet
docker compose build --no-cache
docker compose up -d --force-recreate
docker compose ps
docker compose logs --tail=200 purev2 dashboard
```

Before DNS is configured, create a tunnel from the computer:

```bash
ssh -L 3100:127.0.0.1:3100 YOUR_DEPLOY_USER@YOUR_VPS_HOST
```

Then open `http://127.0.0.1:3100`. For this temporary HTTP test, add
`http://127.0.0.1:3100/api/auth/discord/callback` to the Discord application and
temporarily use that exact value for `DISCORD_OAUTH_REDIRECT_URI`.

## Public HTTPS

Point the dashboard DNS record at the VPS. Install Caddy from its official Ubuntu
repository, then use this host configuration:

```caddyfile
dashboard.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

Reload Caddy only after validating its configuration. Allow inbound `80/tcp` and
`443/tcp`; do not allow `3000`, `3100`, `8081`, or `8082` through the firewall.
Verify bindings with:

```bash
sudo ss -lntp
docker compose ps
curl -fsS http://127.0.0.1:3000/readyz
curl -fsS http://127.0.0.1:3100/
```

## Promote to master

Test `web-dev` first. After review, merge `web-dev` into `master` on the computer
or through a pull request. Then the normal VPS update is:

```bash
cd /opt/purev2
git switch master
git pull --ff-only origin master
docker compose build
docker compose up -d --force-recreate
docker compose ps
docker compose logs --tail=200 purev2 dashboard
```

No command registration or database index changes are required for dashboard-only
updates. Run those maintenance commands only when the bot command definitions or
required MongoDB indexes changed.
