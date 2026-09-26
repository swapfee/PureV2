# Development-guild soak-test checklist

Run against a single development/test guild after indexes are applied, guild commands are registered, and `/readyz` reports both `j2cReady: true` and `statsReady: true`.

For every item: perform the action, then confirm the expected observable result.

| # | Test | Expected observable result |
| --- | --- | --- |
| 1 | Bot cold start | Container becomes healthy; `/healthz` 200; `/readyz` eventually `ok: true`, `j2cReady: true`; no secrets in logs |
| 2 | Readiness progression | Components move from pending to healthy in order (mongo → modules → REST → workers → gateway/shards → j2c); readiness stays false until complete |
| 3 | Occupancy warm-up | After shards are healthy, occupancy-dependent reconciliation completes and j2c becomes ready |
| 3a | Statistics warm-up | Redis connects and Mongo/Discordeno voice-state reconciliation completes before `statsReady` becomes true |
| 4 | Join lobby and create channel | Joining the configured lobby creates a temporary voice channel and moves the member |
| 5 | Leave lobby during creation | Leaving mid-creation does not leave orphaned “creating” state indefinitely; reservation/channel cleanup or completion is consistent |
| 6 | Duplicate voice-state events | Duplicate/out-of-order updates do not create a second channel for the same owner |
| 7 | Two members in a temporary channel | Both remain connected; channel is not deleted while occupied |
| 8 | Owner leaves while another member remains | Channel stays up; ownership/control rules for `/vc` still enforce owner (or configured policy) |
| 9 | Empty-channel three-second deletion | Last member leave schedules deletion; channel removed after ~3s when still empty |
| 10 | Rejoin during deletion delay | Rejoining within the delay cancels deletion; channel remains |
| 11 | Worker restart during active use | Supervisor restarts the worker; active temporary channels continue; events resume without duplicate creates |
| 12 | Container restart with existing temporary channels | After restart and j2c ready, existing channels are tracked again; empty ones reconcile toward deletion; occupied ones remain |
| 13 | Reconciliation of missing Discord channels | DB rows for channels deleted outside the bot are cleaned up / reconciled without crashing |
| 14 | `/vc invite` | Owner can invite; unauthorized users get a clear denial; success path does not leak secrets |
| 15 | `/vc rename` | Owner rename succeeds within limits; invalid names rejected |
| 16 | `/vc limit` | Owner sets user limit; out-of-range values rejected |
| 17 | `/vc lock` | Channel locked for non-permitted joiners as designed |
| 18 | `/vc unlock` | Lock cleared; join behavior restored |
| 19 | Cooldown feedback | Rapid repeated mutating commands return cooldown messaging; cooldown only advances on successful mutations |
| 20 | Unauthorized-user responses | Non-owners receive denial without channel mutation |
| 21 | Atlas interruption | Transient Atlas blip surfaces as unhealthy readiness / structured errors; no silent partial mutations; recovery after Atlas returns |
| 22 | Discord REST failure | Failed Discord calls are logged (redacted); retries/backoff behave safely; no duplicate channel storms |
| 22a | `/stat` current member | `/stat` returns a private 1600×900 PNG including current elapsed time, even when the requester is not currently in voice |
| 22b | `/stat member` | A human guild member can be selected; bot or missing targets are rejected privately |
| 22c | `/stat timezone` | A valid IANA timezone such as `America/Los_Angeles` aligns the seven-day graph and tracked-since date to that member-local calendar; an invalid timezone is rejected privately |
| 22d | Redis restart | Restarting Redis makes stats unready; Mongo history remains and cache/session state rebuilds after reconciliation |
| 22e | Statistics restart recovery | Restart the bot with members connected; active sessions reconcile without duplicate session totals |
| 23 | Graceful SIGTERM | `docker compose stop` drains cleanly; container exits without orphan workers; temporary channels left in a reconcilable state |
| 24 | Logs contain no secrets | Spot-check logs during the above: no Discord token, no Mongo password/URI secrets, no REST proxy authorization |

Initial command registration for this checklist must use **guild** registration, not global.
