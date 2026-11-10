# zepp-notifier — Notify Relay

Server-driven rich notifications for Zepp OS (Amazfit) watches: a notification
arrives in the watch's notification centre with **buttons defined by whoever sent
it**, and a button press posts the answer back to the sender's server. The relay
exists for one reason ordinary push doesn't cover: **two-way response** — answers
that reach your own apps.

Target device: **Amazfit Active 2 (Square)** — API_LEVEL 4.2, 390×450.

Status: **working system, API v1 final.** 16/16 acceptance soak delivered, reboot
survival proven, 20 s cadence verified at ~13 s queue-to-render. See
[`docs/status.md`](docs/status.md) for the state of play and
[`docs/contract.md`](docs/contract.md) for the API contract.

## Why it is shaped like this

Zepp OS mini programs are three runtimes with very different capabilities:

| runtime | runs on | can | cannot |
|---|---|---|---|
| Device App (`page/`) | watch | UI, `notify()` | any HTTP at all |
| App Service (`app-service/`) | watch, no UI | `notify()`, BLE, alarms | timers; 600 ms single-execution budget |
| Side Service (`app-side/`) | inside the Zepp phone app | `fetch()` (HTTP) | UI, sockets, push |

So the watch renders and reports, the phone does all networking, and the server
owns all meaning. **The watch pulls and the phone only answers** — every exchange
is initiated by a one-shot alarm wake on the watch; a long-lived BLE session dies
silently once the mini app leaves the foreground (measured, repeatedly).

```
alarm, every 20–60 s (store:true, oneshot)     relay (LAN/homelab, :8097)
                  │                              ▲            │
                  ▼                              │            ▼
tick service (single execution)        GET /v1/inbox      POST /v1/ack
  │  Request {t:'poll'}                (side cache,         (answer)
  ▼   (answered from phone-side cache)  8 s refresh)
 Side Service ─────────────────────────┘
  │  Response {items, cancel}
  ▼
render + report + exit
Notification Centre ──tap──► cold-start ack (~1 s)
```

Deliberate choices:

- **Ack-driven, at-least-once delivery.** The relay serves every unrendered item
  until the watch reports it rendered. A lost response costs one wake, not the
  notification; a lost report costs a duplicate, bounded at 10 serves.
- **Actions are IDs the sender resolves**, never URLs on the device. Small
  payloads, no credentials on the watch, behaviour changes without reinstalls.
- **Senders own policy.** The relay records facts and never picks a winner —
  which answer counts, when to escalate, whether to re-ask is the sending app's
  business (see `tools/sender-example.py`).
- **The relay holds the notification-centre id map**, so answered / replaced /
  expired reminders delete themselves on the next wake. No device persistence needed.

## Layout

```
watch/                    Zepp OS mini app (appId 10262217, v0.9.0)
  app.json / app.js       target active-2-square, permissions, auto-arm
  page/index.js           control panel: arm / disarm / cadence / diagnostics
  app-service/notifier.js one-shot tick: poll → render → cancel → report → exit
  app-side/index.js       Side Service: 8 s inbox cache, answers polls from memory
  shared/                 alarm chain, protocol, vendored BLE messaging
server/spike_server.py    relay: sender API + device API + dashboard + /docs
server/Dockerfile         stdlib-only image, runs as nobody
compose.yaml              Dockhand/git deploy: secret, volume, loopback port
tools/test-contract.py    139 assertions — the executable half of the contract
tools/schema-check.py     dependency-free schema validator
tools/check-checklist.py  checks docs/client-checklist.md against schema-v1.json
tools/sender-example.py   reference sender: queue, long-poll, escalate
tools/watch_run.py        unattended-run monitor (exits on first anomaly)
docs/contract.md          API v1 final — the contract, and the reasoning behind it
docs/client-checklist.md  every endpoint's exact fields, types and literal reply
watch/tools/test-tap.mjs  tap path under a simulated wake (durability, arming, retries)
docs/schema-*.json        machine-readable schemas (served live at /docs/)
docs/hosting.md           docker, TLS, migration, operator runbook
docs/api-prior-art.md     ntfy/Gotify comparison that shaped v1
docs/status.md            state of play (rewritten, not appended)
docs/findings.md          dated measurement log — why things are the way they are
```

## Build and install (watch)

```sh
cd watch && npm install && npm run verify   # undef-check + zeus build
# -> dist/10262217-Notify_Relay-<version>-<ts>.zab
```

Install with the Zepp app (Developer Mode → scan the `zeus preview` QR code),
open **Notify Relay** once, grant the background permission, **Disarm (sweep)**
if anything is pending, set **Cadence** (60 s battery / 20 s latency), then
**Arm 30s (silent)**. First wake in ~30 s, steady cadence after.

Installing a build starts a **new Side Service instance and never stops the old
one** (`onDestroy` never fires; force-stop does not kill them). Two live instances
both refresh the cache and both answer the Messaging socket, which shows up in
`events.jsonl` as `cache.refresh` entries whose `requests` counter alternates
between two values. After every install, **force-stop the Zepp app once** (Android
settings → Apps → Zepp → Force stop) and reopen it. Since 0.9.6 the side also
reports `side.duplicate` when it sees another instance's marker, so the condition
is visible instead of being guessed at.

If the watch has been asleep (overnight, or off the wrist), the OS freezes the
alarm chain and no wake happens until something re-arms it. Opening **Notify
Relay** is enough from 0.9.6: the page asks the phone when it last heard from the
tick and re-arms itself when the answer is "never" or "hours ago".

## Run the relay

Dev:

```sh
server/relay.sh start 8097        # managed: start/stop/status/logs
```

Docker / Dockhand (see [`docs/hosting.md`](docs/hosting.md) for the full runbook):

```sh
cp .env.example .env              # optional
printf 'your-token\n' > secrets/relay_token && chmod 600 secrets/relay_token
# The dashboard login is optional but recommended: it is the only credential a
# human types, so the operator token never has to be looked up to manage apps.
docker compose up -d --build      # or deploy this repo from Dockhand via git
```

Dashboard: `http://<host>:8097/` (log in with `DASHBOARD_USER`/`DASHBOARD_PASS`;
it only asks for the bearer token when no dashboard login is configured).
API docs, human and machine: `http://<host>:8097/docs` (always open — no
secrets in them; an integrating agent starts at `/docs/index.json`).

## Try it

```sh
curl -s -X POST http://localhost:8097/v1/notify \
  -H 'Content-Type: application/json' --data-binary @- <<'JSON'
{"title":"Medication","body":"Did you take your morning medication?",
 "actions":[{"id":"yes","label":"Yes"},{"id":"no","label":"No"}],
 "key":"med:2026-11-05:0700","tag":"meds","vibrate":4}
JSON
```

```json
{"id":"70-b0b6e6","key":"med:2026-11-05:0700","tag":"meds","state":"queued",
 "duplicate":false,"chain":{"chain":"online","last_poll_age_s":14,"queue_depth":0}}
```

Senders observe through one append-only log (`GET /v1/events?since&kind&tag&wait`,
long-polled), queue with idempotent `key`s, and escalate locally on
rendered-without-answered. The reasoning is in `docs/contract.md`, the exact wire
shapes in `docs/client-checklist.md` (checked against `docs/schema-*.json`), and the
happy path in `tools/sender-example.py`.

## Tests

```sh
python3 tools/test-contract.py        # 139 assertions, throwaway relay instances
python3 tools/schema-check.py --live docs/schema-as-implemented.json
python3 tools/schema-check.py docs/schema-v1.json --defs
python3 tools/check-checklist.py      # checklist fields vs schema, no drift
cd watch && npm run check             # undefined-call check + tap-path harness
```

Hardware proofs (measured, in `docs/findings.md`): 16/16 soak delivered with zero
duplicates, reboot survival with no missed wake, replace-on-render, clear-on-answer,
20 s cadence at 13 s queue-to-render, tap-to-ack ~1 s.

## Security notes

- Bearer tokens (operator + per-app) travel as headers; over plain HTTP they are
  readable on the wire. Trust the LAN/Tailscale, or terminate TLS at a reverse
  proxy and keep the relay on loopback (examples in `docs/hosting.md`).
- App tokens are scoped to one tag prefix and shown exactly once at creation;
  the operator token administers and is what the phone side holds.
- The relay binds `0.0.0.0` in the container but publishes on loopback; the
  `compose.yaml` port mapping is `127.0.0.1:`-bound by default.
