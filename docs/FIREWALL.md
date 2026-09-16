# VPS firewall guidance (Ubuntu 22.04)

Conservative policy for PureV2. The bot needs outbound HTTPS and Discord Gateway connectivity. No inbound Discord port is required.

## Before enabling the firewall

Allow SSH first so you do not lock yourself out:

```bash
sudo ufw allow OpenSSH
# Prefer restricting SSH by source when practical:
# sudo ufw allow from <your-admin-ip>/32 to any port 22 proto tcp
sudo ufw enable
sudo ufw status verbose
```

## Do not expose application ports publicly

- Do **not** allow inbound TCP 3000 (health) from the internet.
- Do **not** allow inbound TCP 8081 (REST proxy) from the internet.
- Compose already binds health as `127.0.0.1:3000:3000`.
- The REST proxy must remain on container loopback and must never be published.

## Verify published sockets

Docker networking can interact with host firewall rules. After deploy, review:

```bash
ss -tulpn | grep -E ':3000|:8081|:22'
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Expect health only on `127.0.0.1:3000`. Expect **no** host binding for `8081`.

## Outbound requirements

The container needs outbound access to:

- Discord HTTPS API
- Discord Gateway WebSocket endpoints
- MongoDB Atlas

No inbound Discord listener is required on the VPS.
