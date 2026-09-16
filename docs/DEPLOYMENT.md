# PureV2 deployment guide (Ubuntu 22.04)

Controlled packaging for one Docker container (coordinator + in-process Bun workers).
MongoDB is Atlas. Do not run Mongo or Redis on the VPS.

This guide assumes Docker Engine and the Compose plugin are already installed on the server.

---

## Move the bot from your computer to the VPS

Do all packaging validation on your computer first. Only then copy artifacts and start on the server.

### On your computer (Windows / local)

1. Ensure local checks pass:

```bash
bun install
bun run typecheck
bun run lint
bun test
docker compose config
docker build -t purev2:local .
```

2. Prepare a **secret-free** transfer package (source + lockfile + Docker files). Do **not** copy your local `.env`.

Options:

- Prefer git: push to a private remote, then `git clone` on the VPS.
- Or copy a zip/tarball that excludes `.env`, `node_modules`, `.git` (optional), and logs.

3. On the Discord Developer Portal, use a **development/test** application for the first guild rollout. Keep production credentials separate.

4. In Atlas, create/use a database intended for this environment (not a shared scratch DB). Enable backups before public use.

### On the VPS (after copy)

1. Log in as a non-root user with Docker permissions (`sudo usermod -aG docker <user>` then re-login).
2. Place the project at a path such as `/home/<user>/purev2`.
3. Create `.env` from `.env.example` (see below). Never commit it.
4. Run index maintenance, guild command registration, then `docker compose up`.

Detailed steps follow.

---

## 1. Docker Engine and Compose

If Docker is not installed, use the official Docker documentation for Ubuntu (`docker-ce` + `docker-compose-plugin`). Avoid unofficial third-party packages.

Verify:

```bash
docker --version
docker compose version
```

## 2. Non-root deployment user

```bash
sudo adduser --disabled-password --gecos "" puredeploy
sudo usermod -aG docker puredeploy
```

Use this user for routine operation. Do not log in as root for day-to-day deploys.

## 3. Place the repository on the server

```bash
sudo mkdir -p /opt/purev2
sudo chown puredeploy:puredeploy /opt/purev2
# as puredeploy: clone or unpack into /opt/purev2
cd /opt/purev2
```

## 4. Create production `.env`

```bash
cp .env.example .env
chmod 600 .env
nano .env   # or your preferred editor
```

Required highlights:

| Variable | Notes |
| --- | --- |
| `DISCORD_TOKEN` | Coordinator-only. Never passed to workers. |
| `DISCORD_APPLICATION_ID` | Application snowflake. |
| `MONGODB_URI` | Atlas URI with TLS (`mongodb+srv://...`). Separate prod DB. |
| `BOT_WORKER_COUNT` | Start with `1`. A second worker partitions shards; it does not add Discord shards by itself. |
| `REST_PROXY_HOST` | Must be `127.0.0.1`. |
| `REST_PROXY_PORT` | `8081` (never published). |
| `REST_PROXY_AUTHORIZATION` | Generate: `openssl rand -hex 32` |
| `HEALTH_HOST` | `0.0.0.0` inside Docker only. |
| `HEALTH_PORT` | `3000` |

Compose publishes health only as `127.0.0.1:3000:3000`.

Development and production bots/databases must use different credentials.

## 5. Restrict `.env` permissions

```bash
chmod 600 .env
# confirm owner
ls -l .env
```

## 6. MongoDB Atlas

See [ATLAS.md](./ATLAS.md). Configure network access for the VPS public IP where practical. Do not skip TLS. Enable backups before public use.

## 7. Build the image

```bash
cd /opt/purev2
docker compose build
# or: docker build -t purev2:local .
```

## 8–9. Index maintenance (dry-run → apply → verify)

Normal bot startup **verifies** indexes only; it does **not** create or drop them.

Run the CLI against Atlas (requires Bun on the host **or** a one-off container with the same image and env). Recommended host Bun workflow if Bun 1.4.2 is installed:

```bash
bun run indexes:plan
bun run indexes:apply -- --apply --confirm-production
bun run indexes:verify
```

One-off container (no Bun on host):

```bash
docker compose run --rm --entrypoint bun purev2 run src/cli/indexes.ts
docker compose run --rm --entrypoint bun purev2 run src/cli/indexes.ts -- --apply --confirm-production
docker compose run --rm --entrypoint bun purev2 run src/cli/indexes.ts -- --verify
```

Exit nonzero on conflicts or failed verification. Resolve conflicting same-named indexes manually. The CLI never drops indexes by default.

## 10. Register commands (development guild first)

Registration does **not** start Gateway, MongoDB, or workers. Dry-run is the default.

```bash
# Dry-run
bun run commands:register -- --guild <guild-id>

# Apply to one development guild
bun run commands:register -- --guild <guild-id> --apply
```

Global registration (avoid until ready):

```bash
bun run commands:register -- --global --confirm-global --apply
```

Never print or paste the bot token into logs/tickets.

## 11. Start the container

```bash
docker compose up -d
docker compose ps
```

One service only: `purev2`. Workers are Bun child processes inside that container.

## 12. Inspect health and readiness

On the VPS:

```bash
curl -sS http://127.0.0.1:3000/healthz
curl -sS http://127.0.0.1:3000/readyz
curl -sS http://127.0.0.1:3000/metrics
```

Expect `/readyz` to report `ok: true` and `j2cReady: true` after cold start completes. Do not expose port 3000 on the public firewall.

## 13. Inspect bounded logs

```bash
docker compose logs -f --tail=200
```

JSON file logging is rotated (`max-size` / `max-file` in `compose.yaml`). Confirm logs contain no tokens, URIs with passwords, or `REST_PROXY_AUTHORIZATION`.

## 14. Stop, restart, and update safely

```bash
docker compose stop
docker compose start
# update:
git pull   # or upload new sources
docker compose build
docker compose up -d
```

Compose sends SIGTERM; the process handles graceful shutdown.

## 15. Roll back

Tag images when deploying:

```bash
docker tag purev2:local purev2:previous
# after a bad build:
docker tag purev2:previous purev2:local
docker compose up -d
```

Or check out the previous git revision and rebuild.

## 16. Back up Atlas before destructive DB work

Take an Atlas backup/snapshot before any manual index repair or data migration. The index CLI does not drop indexes by default; still back up first.

---

## Firewall

See [FIREWALL.md](./FIREWALL.md).

## Soak testing

See [SOAK-TEST.md](./SOAK-TEST.md) for the development-guild checklist.
