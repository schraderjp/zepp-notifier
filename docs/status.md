# NOW — 2026-11-05, morning

> Read this block first. Everything below it is history, appended over days, and
> contains conclusions that later measurement overturned. This block is the state of
> play and is meant to be rewritten rather than appended to.

## Installed

**0.5.6** (code 58) — `dist/10262217-Notify_Relay-0.5.6-20261105095528.zab`.
Armed silently (silent arm = `show=0`, so no diagnostic notification per wake).
Side Service instance is fresh from the 09:57 install/arm.

## Relay fix — answered-before-rendered (2026-11-08)

An item answered **before** its render report arrived was served again, counted in
`queue_depth`, relabelled `expired` when its TTL passed, and finally parked as
`abandoned`; a late report also demoted `answered` to `rendered`, which dropped it from
the `cancel` list so the answered notification stayed on the wrist. Root cause: every
terminal-state check tested for `"acked"`, a value nothing writes. Delivery now keys off
`answers` plus `TERMINAL_STATES`, in one predicate used by all four sites. Relay-only —
no watch rebuild, no state migration. `tools/test-contract.py`: **117 passed, 0 failed**
(98 before; all 11 new assertions were shown failing first). Details:
`docs/plan-fix-answered-items.md`, contract §5.1/§5.5/§5.6.

## Dashboard login is now the only human credential (2026-11-08)

`DASHBOARD_USER`/`DASHBOARD_PASS` used to cover only `/` and `/state`, so the page still
asked for the operator token before it could manage apps or send a test notification.
The login is now a scoped role (`dashboard`) that `/state`, `/v1/apps` and `/v1/notify`
accept, and the token field is no longer rendered when a login is configured. It cannot
touch `/v1/inbox`, `/v1/seen`, `/v1/ack`, `/v1/log`, `/v1/reset`, `/v1/events` or
`/v1/notification/*` — the watch keeps the operator token, and the human password must
not impersonate it. Dashboard writes carry `X-Relay-Dashboard: 1` (a cross-site form
cannot set it; no CORS preflight is served), so the ambient Basic credential is not
usable as CSRF. With a token but no dashboard login, `/state` now needs the token instead
of being anonymously readable; the page falls back to its token field. Relay-only, no
config change: `tools/test-contract.py` **130 passed, 0 failed**. Details:
`docs/hosting.md` → "Dashboard login".

## What 0.5.6 changed (and why)

| change | reason |
|---|---|
| Side answers the watch's poll **from a 12 s cache**; a background timer refreshes it with `GET /v1/inbox?peek=1` | The poll used to block on an HTTP fetch *inside* the freshly-woken App Service's execution budget. On an idle phone/watch the response arrived after that context was reaped, so the notification was silently lost — measured 2026-11-05 as two consecutive misses followed by a success on the third serve. |
| Relay ignores `peek=1` for serve accounting | The cache refresh calls `/v1/inbox` every 12 s. Counting those as handovers inflated `served_count`, which would make `stuck` fire on any item older than ~30 s. Verified: 3 peeks leave `served_count` unset, 1 real poll sets it to 1. |
| Delivery is **ack-driven** (0.5.3) | The relay serves every unrendered item until the watch reports it rendered. A dropped response costs one cycle, not the notification. Bounded at `MAX_SERVES = 10`, then parked as `abandoned`. |
| `stuck` detection (0.5.4) | After 3 serves without a render report the relay sets `stuck`, the side reports `side.stuck`, and the page hint says `delivery stuck (ids) - reopen this app`. Automatic socket rebinding was abandoned: the Messaging API has no `removeListener`, so `stop()`+`listen()` stacks handlers. |

## Acceptance result — 2026-11-05, 10:00-13:45 (0.5.6)

**16 of 16 delivered.** Wakes: 231, mean gap 60.4 s, single 94.9 s hole at the
install. `notify.stuck`, `notify.abandoned` and `poll.nores`: zero. Against
yesterday's 16 queued / 9 receipts / 6 confirmed on the watch, this is the
acceptance bar met, and the failure mode is unchanged in kind: what remains is
*receipt* loss, not delivery loss.

Two post-soak experiments:

* **Batches work.** Two items served in one wake (`count=2`) both rendered and both
  reported. An earlier `count=2` reported only the second, which looked like a batch
  bug and was not — so do not "fix" single-item rendering on that evidence.
* **Receipt loss still causes duplicates.** A batch served at 13:51:41 produced no
  report; it was re-served at 13:52:42 and reported at 13:53:41. Under at-least-once
  that is a duplicate on the wrist, bounded by `MAX_SERVES = 10`. Expected, not a
  regression.

Latency ranged 105 s to 157 s through the run (11 s when queued by hand during an
active moment). That is the beat between the side's ~16.6 s cache refresh and the
watch's 60.4 s poll — not a fault, and acceptable for a 5-minute product cadence.

### Ground truth from the operator

**No notification appeared twice**, and the phone went untouched for stretches of two
hours or more inside the run, as did the watch. So today's delivery held under the
idle conditions that were present last night, with zero duplicate clutter.

### Monitor run (10:05-14:05, `server/watch_run.py`)

```
wakes 239 | gap min/med/max 53.0 / 60.3 / 67.6 s | render reports 20 | clean
```

No gap above 67.6 s in four hours. Yesterday's side instance was 3 h 08 m old when
delivery died; today's reached the same age at 13:05 and delivered. The one variable
removed between the two runs is the network call inside the wake budget.

### Doze is not a concern on this setup (operator, 2026-11-05)

The phone is **plugged in overnight**, and the Zepp app is **excluded from battery
optimisation**. Android doze only suppresses network for an unplugged, stationary
device, and charging keeps it out of doze entirely, so the side's cache refresh keeps
running overnight and app-standby throttling does not apply. This removes the last
phone-side explanation for last night's loss as well, leaving the network call inside
the wake budget as the only mechanism consistent with the evidence.

## Done since the acceptance run

* **Auth is real now, and still easy in dev.** `--token-file` / `RELAY_TOKEN_FILE`
  supported alongside `RELAY_TOKEN`; every endpoint except `/health` and the static
  dashboard shell is gated *when a token is configured*; startup prints
  `auth: DISABLED` plus an exposure warning on a non-loopback bind; `/health` reports
  `auth: bool`; the dashboard asks for the token and stores it in `localStorage`; an
  unreadable token file exits 2 instead of running open. Verified as a matrix: no
  token ⇒ 401 on `/state`, `/v1/inbox`, POSTs, 200 on `/health`; good token ⇒ 200/201;
  bad token ⇒ 401. Rationale and a compose/nginx/Caddy example are in
  `docs/hosting.md`. Note the watch's phone-side `relay_token` setting must match.

## Sender API v1 — implemented 2026-11-05

`server/spike_server.py` now implements the contract in `docs/contract.md`; there was no
watch build, because the device-facing shapes (`/v1/inbox`, `/v1/seen`, `/v1/ack`) are
unchanged.

| capability | note |
|---|---|
| `key` | replace while unrendered (same id, `replaced` fact), successor with `supersedes` once rendered, identical-payload retry returns `duplicate: true` with 200 |
| `tag` | dotted-prefix filtering: `?tag=meds` matches `meds.evening` |
| `expires_at` / `not_before` | serve-time gates; expiry emits an `expired` fact with `reason: ttl`, and `not_before` after `expires_at` is rejected |
| `extras` | opaque flat string map, round-tripped only |
| `GET /v1/events` | sender-facing fact log (`queued/replaced/rendered/answered/expired/abandoned`), `since` as cursor, `all` or a duration (`10m`), `kind`/`tag`/`limit` filters, long-poll `wait` |
| `GET /v1/notification/<id>` | single-item reconciliation |
| answers | append-only `answers[]` with `(id, action)` dedupe; legacy `answer` mirrored |
| chain health | on every queue response and on `/health`; `queue_full` returns 429 with `Retry-After` |
| validation | rejects with `{error:{code,message,field}}`; title/body still truncate |

Facts and the poll clock are persisted, so `key` idempotency survives a restart, and
state written before v1 is migrated on load (the legacy single `answer` is seeded into
`answers[]`).

Covered by `tools/test-contract.py` — 60 assertions including idempotency, replacement,
supersede, expiry, `not_before`, filters, cursors, long-poll, validation, persistence,
retention (409 `cursor_too_old`), the queue cap, and a check that a sender's 20-second
long-poll does not stall the watch's `/v1/inbox`.

**End-to-end confirmed on hardware, no watch rebuild:** `70-b0b6e6` (tag `e2e.v1`)
queued, rendered, and answered on the installed 0.5.6, with the fact trail reading
`queued → rendered → answered {action: got_it}` and `answers[]` populated. Note
`served_count` reads 0, which is expected: the side serves from its cache, so the relay
never sees the handover. `tools/schema-check.py --live docs/schema-as-implemented.json` passes
against the running relay.

### One bug this exposed

Chain liveness had to change: the side answers the watch from its cache and therefore
only ever calls `/v1/inbox` with `peek=1`, so the relay's `LAST_POLL_MS` (set only by a
non-peek inbox) never updated and `chain` reported `silent` on a healthy chain. Liveness
now follows the side's `poll.served` report, which is sent when the watch actually asks.

## Watch 0.6.0 — retraction, clear-on-answer, honest render reporting

Built as `dist/10262217-Notify_Relay-0.6.0-20261105155254.zab` (code 59).
`npm run verify` clean. **Not yet installed** at time of writing, so the live relay shows
`centre_id: None` — that is the expected gap, not a fault.

| change | why |
|---|---|
| `notify()`'s return value is checked | it returns `0` on failure and the centre id otherwise. Ignoring it meant an OS-level drop was reported as `rendered`, so the relay stopped serving an item the user never saw. |
| `render()` builds a relay id -> centre id map and `/v1/seen` carries it | enables cancellation without the watch persisting anything across contexts |
| poll response `cancel: [centreId...]` is honoured with `cancel()` | answered, superseded, or expired-with-retract notifications are deleted from the centre on the **next** wake (≤ ~60 s) |
| device confirms deletions via `seen.cancelled` | the relay repeats the list until confirmed, so a lost frame costs a retry rather than stranding clutter |

Relay-side counterpart is implemented and covered by `tools/test-contract.py` (68
assertions, including centre mapping, the cancel list, confirmation, and supersede).

### Verified on hardware 2026-11-05 ~16:02 (0.6.0)

Replace-on-render exercised end to end with no tap needed:

* `72-39b1a6` queued with `key=e2e:replace:1` -> rendered, `centre_id=4294963205`
* correction posted with the same key -> `73-9ad567` with `supersedes=72-39b1a6`
* next wake: `notify.rendered mapped=1 cancelled=1`; A got `cancelled_at=16:02:19`,
  B rendered with `centre_id=4294963206`
* fact trail: `queued A -> rendered A -> queued B -> rendered B`; cancel list now
  empty, queue depth 0, chain online

Operator ground truth: the original vanished when the corrected one arrived, and the
corrected one is sitting in the notification centre now.

Clear-on-answer uses the same machinery (answered items join the same `cancel` list)
and the contract tests cover it, but it has not yet been tapped through on hardware.

## Watch 0.7.0 — dismissed fact (swiped away vs still there)

Built as `dist/10262217-Notify_Relay-0.7.0-20261105162256.zab` (code 60).
`npm run verify` clean, 76 contract assertions pass. **Not yet installed.**

| change | why |
|---|---|
| device reports `live` (getAllNotifications()) on every wake | the relay can tell dismissal from presence |
| relay derives `dismissed` when a rendered-but-unanswered item with a known centre id is absent from `live` | "swiped away unanswered" becomes a fact instead of silence |
| absent `live` (old builds) infers nothing | no false dismissals during the upgrade window |
| vanished answered/superseded/expired-retract items count as `cancelled` | the live set is a second confirmation path if the `cancelled` frame was lost |

Covered by 8 new contract assertions (dismissed once, never twice, not on the cancel
list, absent-live infers nothing, answered-vanish is cancellation).

### Verification once installed

1. Install, open, Arm 30s (silent).
2. Queue a notification with no tap; swipe it away on the watch.
3. Expect a `dismissed` fact for its id and `dismissed_at` set on the item, with no
   `cancel` entry for it.

## Watch 0.7.3 — dismissed via the page (service cannot see the centre)

Built as `dist/10262217-Notify_Relay-0.7.3-20261105164936.zab` (code 63).
**Not yet installed.**

Measured on 0.7.2: `getAllNotifications()` throws on every App Service wake
(`live.report` beacons show `live=null` with an empty error, render and idle wakes
alike), while `notify()`/`cancel()` work fine there. Presence cannot come from the
tick, so the page reports `live` on open and the relay derives `dismissed` when a
previously-live id vanishes. Delayed (dismissal lands when the app is next opened),
but honest: absent `live` still infers nothing, and the `live_seen` gate stays.

Side telemetry now reports `live=-1` for absent vs `0` for empty, so the two are
distinguishable in the trace. 77 contract assertions pass.

### Verification once installed

1. Install, open, Arm 30s (silent) — the open itself reports the first `live`.
2. Queue one with no buttons; Delete it (popup or centre, note which).
3. Open the app again; expect a `dismissed` fact for its id.

## Watch 0.7.4 — dismissed removed

Installed and verified 2026-11-05 ~17:03 (code 64): fresh side instance (`side.online`
17:00:35), polls at 60 s, chain `online` (last poll 4 s), queue 0, no `seen` traffic
while idle and no `live.report` since the strip (the 3 in the window predate it).

Per your call: dismissal detection is gone. `getAllNotifications()` throws in the App
Service, page-reported presence would only land when the app is opened (which is only
to arm), so a fact that never fires is dead code with a contract entry. Removed from
the relay (`live`/`dismissed`/`live_seen`), the service, the side, the page, the tests
and both schemas. A reminder cleared without answering stays `rendered`, which is
honest: the relay cannot tell "still there" from "swiped away". `clear`,
replace-on-render and retraction are untouched — they ride the centre-id map, which
works fine from the service.

## Watch 0.8.0 — reboot test (STORE=true, oneshot chain only)

Built as `dist/10262217-Notify_Relay-0.8.0-20261105170731.zab` (code 65).
`npm run verify` clean. **Not yet installed.**

What changed: `STORE=false` → `true` in `watch/shared/alarm.js`, with the oneshot-only
constraint documented in the comment. Everything else identical to 0.7.4.

Why oneshot only: each wake cancels the stored id then sets one delay-60 alarm, so at
most one alarm exists and a reboot can produce at most one extra wake. A persistent
REPEAT alarm re-armed every wake is the shape that stormed in 0.4.23 — untested, and
must NOT be armed on this build. Guards stay on: `armNext` refuses at >=3 pending, the
service storm guard (>3 → cancel all + disarm) still fires.

## Watch 0.8.1 — repeat fenced off, oneshot+store is the default

Built as `dist/10262217-Notify_Relay-0.8.1-20261105175436.zab` (code 66). **Not yet installed.**

Per your call not to run the repeat test: `MODE_REPEAT` is refused in `setTickAlarm`,
`ensureTickAlarm` and `armNext` (loud `{ok:false, fenced:true}`, never a silent
downgrade); the page repeat button is replaced with a "fenced off" label; app auto-arm
is oneshot; no-options defaults to oneshot. A stale repeat alarm from an earlier build
would wake with `via=alarm` (no `mode=oneshot`) and hit the fence every wake, so the
install steps are Disarm (sweep) first, then Arm 30s.

## Watch 0.9.0 — cadence as a setting

Built as `dist/10262217-Notify_Relay-0.9.0-20261105180404.zab` (code 67).
`npm run verify` clean. **Not yet installed.**

| change | why |
|---|---|
| steady cadence stored in `relay_cadence` (default 60, steps 20/30/60, clamped 20-120) | delivery is wake-quantised, so cadence is latency: 60 s sips battery, 20 s answers in ~20-40 s at 3x the wakes |
| page "Cadence: Ns (tap: change)" button cycles 60→30→20→60; status line shows `every Ns` | one row, reuses the fenced-off repeat button's slot |
| tick re-arm reads the stored cadence (`armNextOneshot` delay) | first wake stays 30 s (quick proof); every wake after is the setting |
| side cache 12 s → 8 s | at 20 s cadence a 12 s refresh is staler than the interval on a throttled phone (measured median 16.6 s on a 12 s timer); LAN cost negligible |

No relay change. `MIN_DELAY_SEC=20` already floors the setting.

### Verified on hardware 2026-11-05 ~18:16 (code 67)

20 s cadence holds: polls every ~20 s (`18:13:13 → :34 → :55 → :15 → :35 …`),
chain online, no storm. Latency on a stable chain: `78-042268` queued 18:16:04,
rendered 18:16:17 — **13 s queue-to-render** against 105–157 s at 60 s. (`77-eb7541`
took 216 s, but it was queued mid-rearm while the old 60 s alarm was being replaced;
the next item on the settled chain is the honest number.)

Note: `served_count` reads 0 on cache-served items by design (only a non-peek inbox
counts as a handover), so age-based `stuck` is the signal at any cadence.

## API v1 final — 2026-11-05

The contract (`docs/contract.md`) is marked final and the code matches it: 68
contract assertions pass, both schemas validate (examples and `--live` against the
running relay), and the reference sender (`tools/sender-example.py`) was exercised
live. Decisions closed: retraction shipped (sender-set, next-wake cancel), `key` with
`supersedes`, no `unanswered` fact (senders compute it — the example shows how), single
`tag` with prefix matching, per-sender tokens deferred until a second app arrives,
`dismissed` dropped. Remaining API-adjacent work is per-sender tokens on trigger, not
on principle.

## API v1 final, second pass — app keys (Gotify-style)

`server/spike_server.py` now manages sender applications at runtime: `GET/POST /v1/apps`
+ `DELETE /v1/apps/<id>` (operator-only), app tokens bound to one tag prefix (exact or
dotted child, overlaps get `409 prefix_taken`), plaintext token returned exactly once
(only a `sha256` hash persists), revoke kills the token immediately. Enforcement:
app token outside its prefix → `403 forbidden_tag` on queue/filter, `404` on
single-item read; device + ops endpoints stay operator-only (the phone side keeps the
operator token). Dashboard has an Applications section (create shows the token once,
revoke is one click). No relay code, config, or restart to add a sender.

Covered by 15 new contract assertions (83 pass total): create, overlap-409, token-once,
in-prefix queue, out-of-prefix/wrong-tag 403s, scoped events, cross-app 404, device
403, revoke, operator bypass. Decision 5 closed accordingly; per-sender trigger met by
building it now rather than later.

## Docker / homelab packaging — done, verified without compose

`server/Dockerfile` (stdlib-only `python:3.12-slim`, runs as `nobody`, `/data` volume,
healthcheck), `compose.yaml` (secret-file primary with a commented Dockhand-variable
alternative, loopback-only port, restart policy), `.env.example`,
`secrets/relay_token.example`. No compose plugin on the dev box, so verification was
`docker build` + `docker run`: banner + `auth: bearer token required`, 401s without a
token, app create → in-prefix 201 / out-of-prefix 403, operator inbox 200, then
container replaced with the same volume → app token still valid, app still listed,
queue depth 2 (both items survived). Gotchas recorded in `docs/hosting.md`: SELinux
`:z` on the secrets bind, secret readability for the `nobody` user, one-time
`state.json` migration into the volume.

Seed-on-first-start (`server/entrypoint.sh` + `server/seed-state.json`): a fresh volume
self-seeds an empty state with a log line; a present non-empty `state.json` is never
touched (both paths verified in containers). Deploying is now clone + secret + up.

## API docs on the relay itself — done

`GET /docs` (human index + endpoint table), `/docs/index.json` (machine entry point),
`/docs/contract.md`, `/docs/hosting.md`, `/docs/schema-as-implemented.json`,
`/docs/schema-v1.json` — all open without a token (they carry no secrets), linked
from the dashboard, baked into the image via `COPY docs`. Verified in a token-locked
container and on the live relay; traversal returns 401/404, never a file. Contract
tests grew to 88 assertions.

## Watch 0.9.1 — page simplified, MIT licensed

Built as `dist/10262217-Notify_Relay-0.9.1-20261105190313.zab` (code 68).
`npm run verify` clean. **Not yet installed.**

The page was still a lab bench: 7 buttons including a tick-proof arm, an alarm
diagnostic that buzzed the wrist, and a load test labelled "wedges". Now 4:

* **Arm notifications** (oneshot 30 s, silent) — the only way to arm
* **Cadence: Ns (tap: change)** — 60 → 30 → 20 → 60
* **Disarm** — the kill switch, unchanged
* **Device log >** — read-only diagnostics, the only window into the watch

Status line speaks plainly: `Armed · every 20s` / `Disarmed`, plus a second line
only when something needs attention (permission missing, or an armed chain with
no alarm pending). Removed: tick-proof arm (chain long since proven), `diag()`,
`startTick()` + its import. `LICENSE` is MIT.

## Dashboard login — done

`DASHBOARD_USER`/`DASHBOARD_PASS` in env: browser-native Basic Auth on `/` and
`/state`, remembered per session, half-configured refuses to start. API untouched
(bearer everywhere, `/health` + `/docs` open). 98 contract assertions pass, live relay
restarted with it, compose + `.env.example` carry the vars (empty = open dashboard).

## Next work, agreed earlier and still open

1. `docs/contract.md` and the sender API: `key` (replace + idempotency), `tag`
   (routing label carried into facts), `expires_at` (opt-in expiry, drop at serve
   time, record `notify.expired`), and `GET /v1/events?since&kind&wait` as the single
   append-only fact log with long-poll.
2. **`store: true` reboot survival**, now that the chain is trustworthy.
2a. **Deployment target: the relay ultimately lives on the homelab**, not this desktop. That
   raises the bar on three things already in the contract: a token on every endpoint (§4.4),
   a stable address the phone can reach (LAN or Tailscale, so `RELAY_URL` stops being a
   dev default), and a state file that survives restarts and is worth backing up. Also
   relevant: the watch-reported `rendered` semantics (§5.0) and the future `dismissed`
   fact, both of which sending apps will interpret differently once it is a shared service.
2b. **Next device build** should carry two cheap fixes: check `notify()`'s return value
   (`0` = failure) before reporting `rendered`, and (with v2) report centre IDs in
   `/v1/seen` so retraction and dismissal tracking become possible.
3. Cadence as a setting (60 s default, 20-30 s for latency at 2-3x the wakes).

Nothing is running now; the chain is armed and the relay is up on port 8097.

Check without waiting:

```sh
cd /home/jimmy/Projects/zepp-notifier
jq -r 'select(.event!="side.alive") | [(.received_at/1000|strflocaltime("%H:%M:%S")), .event, (.count//""|tostring)] | @tsv' server/log/events.jsonl | tail -20
curl -s localhost:8097/state | python3 -c "import json,sys;d=json.load(sys.stdin);print({k:(v.get('state'),v.get('served_count')) for k,v in (d.get('notifications') or {}).items()})"
```

Note: relay-generated events (`notify.rendered`, `notify.stuck`, `probe.answered`) carry
their fields at the **top level** of the JSON line, not under `.data`; only watch-sent
beacons nest under `.data`.

## Open questions, in priority order

1. **Does delivery survive hours?** Yesterday: 16 queued, 9 with a render receipt, 6 confirmed on the watch. This run's bar is 16/16, and unlike yesterday every miss now surfaces as `stuck`.
2. **Is the cause degradation of a long-lived Side Service instance?** Installing spins a fresh one and delivery worked instantly on 2026-11-05 09:19, while an 11.5 h / 680-poll instance delivered nothing. Yesterday the failures began ~3 h in; this run is 4 h, so ~13:00 is the honest failure window.
3. **Is screen-off the trigger?** Still unproven. The 5-minute screen-off test was contaminated: the watch's built-in "Take a walk" activity reminder lit the screen at 09:49. Any screen-off experiment must verify the screen is actually off.
4. **If payloads still fail: shrink the wire format.** Options: one item per poll, short keys, or a two-phase "ids first, content on request". Only worth doing once we know size is the constraint.

## Expected gaps that are NOT faults

* **sleep mode** — freezes the chain, resumes fully afterwards
* **install / relaunch** — installing kills the Side Service; polls resume only when the app is reopened
* **phone reboot** — same as above

Anything else is a real fault, and `watch_run.py` is what tells us.

---

# Current state (v0.4.8 — experiment E1)

> Six builds were lost to one missing line in `app.json`: `device:os.alarm`.
> `alarmMgr.set()` refuses without it, so no alarm ever existed. Read 0.4.8 below
> before trusting any earlier section's conclusion about alarms.

0.4.0 is a **rewrite of the transport**, not a feature release. It implements the
"definitive architecture" at the bottom of `docs/findings.md`: no continuous App
Service, no side-service push, no poll loop on the phone. One alarm, one
single-execution wake, one device-initiated round trip, exit.

## What changed

| before (0.2.x-0.3.x) | now (0.4.0) |
|---|---|
| continuous App Service holding a BLE session | one-shot tick service, `exit()` on every path |
| `@zos/alarm` watchdog that poked the live service | repeating alarm is the *only* driver, `repeat_period: 1` |
| Side Service polled `/v1/inbox` on a `setTimeout` loop | Side Service is a pure `onRequest` server; the watch asks |
| side pushed `{t:'n'}` down the link | side never initiates anything |
| Arm = `appServiceMgr.start({reload:true})` | Arm = keep exactly one alarm (`getAllAlarms()` dedupe) |
| cursor advanced on handover (at-most-once) | `pending` deferred by one poll only - still at-most-once; real fix = commit on `rendered` receipts (see findings) |

Removed with it: the leader lock, `ping.unanswered`, `watch.silent`, `MSG.PING`,
`MSG.NOTIFY`, `MSG.CANCEL`, `rebind()`, `Time.onPerMinute` heartbeats, and
`getAllAppServices()` as a liveness signal (it never was one).

## The tick

```
alarm (60 s, store:true)
  -> onInit(param='via=alarm') / onEvent
  -> beacon {t:'l', e:'tick.wake'}            (before the handshake, on purpose)
  -> connect() -> shake -> appSidePort known
  -> Request {t:'probe'}  (E1)  /  {t:'poll'} (E2)
  -> response arrives -> render (E2) -> exit()
```

`MessageBuilder.request()` is **not** used: it wraps the call in a
`setTimeout` race, which is not documented as available in a service. The tick
uses `requestOnce()`, which sends a `Request` frame with a known `traceId` and
resolves on the matching `response` event - no timer, and if no answer comes the
OS reaps the tick, which is the correct outcome.

## 0.4.23 — the service was dying on a ReferenceError, every wake

A second pair of eyes found it. In `app-service/notifier.js`, `quit()` and
`bleStatus()` were **called 16 times and defined nowhere**:

```
app-service/notifier.js -> UNDEFINED CALLS: bleStatus, quit
```

Cause: the 0.4.12 edit removed the inlined alarm block with a `find`/slice between
`// --- alarm arming ---` and `// --- transport ---`. `quit()`, `bleStatus()` and
`exitState()` sat between those markers and went with it. Rollup does not fail on
undefined identifiers and `node --check` sees valid syntax, so nine builds shipped.

What every wake did:

```js
chain = armNext(show, 60)                 // succeeds, so the chain survives
if (show) notify({ ... bleStatus() })     // ReferenceError
// -> onInit's catch -> quit(...)          // ReferenceError again, uncaught
// no beacon, no probe, no notification, no log
```

That is exactly the symptom: the alarm fires, the watch is silent, the server sees
nothing, and the alarm table grows because re-arming happened before the throw. It
explains the last few builds; it does not explain 0.4.16's single notification,
which argues the deletion landed later than the edit history says. Either way the
file was broken when the checker first ran against it.

Fixed, plus the four other findings from that review:

1. `quit()`, `bleStatus()`, `apiLevel()` restored (no `exit()` - see 0.4.12).
2. **Re-arm only on alarm wakes** (`via=alarm`), never on a tap: a tap cold-starts
   the same file and was adding an alarm per tap. When `pendingIds().length > 1`,
   cancel-all-then-set-one, bounding the table at 2 without ever cancelling the
   alarm that is currently firing.
3. **The registry is per-context storage**, so the page always sees it empty even
   after the service armed alarms. `ensureTickAlarm` now treats the OS list as
   truth: registry empty + pending non-empty -> sweep, then set one. Previously
   `app.js` added an alarm on every launch.
4. `api=__API_LEVEL__` in the `Tick` notification, so the build target is visible
   on the device.
5. **Tap path**: the ack is a fire-and-forget beacon *first* (a small Notify frame
   goes out before the shake resolves), then a probe as a flush barrier. No
   double-ack, and a hung handshake no longer loses the ack.

### The guard

`watch/tools/undef-check.mjs` (acorn walk) fails if any file calls a bare
identifier that is neither declared, imported, nor a known runtime global.

```sh
cd watch
npm run check     # undef-check only
npm run verify    # undef-check && zeus build
```

It caught two more of the same mistake within minutes of being written
(`pendingIds`/`cancelAllTickAlarms` used in the tick without being imported).

---

## 0.4.12 — the `exit` import was killing the service at load

Timeline that finally makes sense of everything:

| build | `@zos/app-service` import in the service | did the service execute? |
|---|---|---|
| 0.4.3 | no | **yes** - one notification |
| 0.4.5 - 0.4.11 | yes (`import { exit }`) | **never** |

So importing the module that *manages* app services into an app service is a
load-time failure here: `AppService({...})` is never registered, `start()` still
returns `0`, and nothing runs. The earlier note saying exactly that was right; it
got contradicted two builds later and cost five more.

Combined with `Disarm (sweep)` reporting `swept: 0` - ids 38/39/40 had left the
table without any notification - the most consistent reading is now:

> the alarms **do fire and are consumed**, and the service they woke could not
> load, because every build since 0.4.5 had the bad import.

Which means alarm delivery was probably never broken; only the code it delivered
was. 0.4.12 tests that with no ambiguity.

Consequences encoded in 0.4.12:

- **no `@zos/app-service` import in the service.** `exit` is also not a global
  (`typeof exit === 'undefined'`, measured in 0.4.3), so the tick simply returns.
- therefore the service must **never** be `start()`ed: without `exit()` that
  creates a continuous instance that holds the single App Service slot forever.
  Every real path now wakes it by alarm, which the OS runs as single-execution
  and reaps on return. The page keeps one button that does it anyway
  (`Load test (wedges)`), labelled for what it costs.
- `Arm 10s test` shortens the loop: arm, wait ten seconds, look at the watch.

If the 10 s test renders, the chain continues by itself (the wake arms the next
one-shot 60 s out) and E1 - the transport question - becomes measurable again.

---

## 0.4.9 — `set()` succeeds, the alarm vanishes

0.4.8: `Arm: oneshot` returns `ok` and an id, no notification after 30 s, and
`Alarm diag` shows `cnt=0`. So the permission is fixed and the argument is
accepted, but the stored ONCE record is **gone without having fired**.

Two remaining explanations, and they are distinguishable only by reading the
record back from the OS:

1. `date` is misinterpreted. A `date` the OS reads as milliseconds when we sent
   seconds (or the reverse) lands in the past or in 1970, and a past-dated alarm
   is discarded rather than fired - leaving exactly `cnt=0` and no wake.
2. The record is scheduled correctly and then consumed without delivering the
   service (delivery blocked, file not launchable, or the OS drops it silently).

0.4.9 therefore calls `alarmMgr.get(id)` immediately after a successful `set()`
and reports what the OS stored: the arm hint now ends in `d=<date>`, and
`Alarm diag` adds `st=<remembered id> last=<stored date or error>`.

| reading | meaning |
|---|---|
| `d` ~ now+30 (10 digits) | scheduled correctly -> explanation 2, the record is being dropped |
| `d` ~ (now+30)*1000, or a tiny number | explanation 1, unit mismatch -> flip the unit |
| `last=err` | `alarmMgr.get` unsupported here; fall back to `cnt` only |

0.4.9 also relabels `Start tick` to **`Start tick (arms chain)`**, because with
the real `exit()` import (0.4.5) it no longer wedges the slot. That matters: the
0.1.4 shape - the page only starts the service, the service arms its own next
wake - is the one mechanism that never depended on a page-set alarm firing.

Test order for 0.4.9:

1. `Arm: oneshot` -> read `d=` in the hint
2. `Alarm diag` -> `st=` / `last=`
3. `Start tick (arms chain)` -> expect an immediate `Tick` notification, then a
   second one ~60 s later. That second one is a service-armed alarm wake, which
   is the only firing path left if page-set alarms are being dropped.

---

## 0.4.8 — `device:os.alarm` was never declared

The arm notification answered it in one line:

```
sec:            PERMISSION DENIED device:os.alarm
msec:           PERMISSION DENIED device:os.alarm
sec-norepeat:   PERMISSION DENIED device:os.alarm
```

`alarmMgr.set()` refuses **before** it validates the argument, so all four shapes
failed identically and every earlier conclusion about alarms was wrong: there was
never an "alarm that does not fire", there was never an alarm at all. The
permission was simply absent from `app.json`:

```json
"permissions": [
  "data:os.device.info",
  "device:os.local_storage",
  "device:os.notification",
  "device:os.bg_service",
  "device:os.alarm"
]
```

Why it stayed invisible for six builds: 0.1.4's alarms demonstrably fired, so the
permission existed then; it was lost when `app.json` was rewritten for 0.2.x, and
from that moment every attempt failed with an error that only became readable once
it was rendered as a notification instead of squeezed into an 11 px hint.

Two rules for the rest of this spike:

1. every `@zos/*` module used needs its `device:os.*` permission present in
   `app.json` - check the module list, not the error messages
2. every thrown error must be readable **on the device** (notification, not hint)

0.4.8 requests both permissions (`bg_service` + `alarm`) and shows them in the
status block as `perm ok` / `perm bg0 al0 (!)`; `Alarm diag` reports `bg=` and
`al=` separately.

---

## 0.4.6 — `alarmMgr.set` rejects the argument

`Arm: oneshot` returns `ok:false, reason: alarm set error` — a **thrown** error, not
a silent no-op. So the alarm was never created (which is why `Alarm diag` said
`cnt=0`), and the argument shape is wrong rather than the scheduling being
ignored.

0.4.x deviated from the only known-good example in two ways at once:

| | official `notification/app-service/delay.js` | 0.4.x sent |
|---|---|---|
| first fire | `date` in **seconds** | `date` in seconds **and** `delay` |
| kind | `repeat_type: alarmMgr.ONCE` **always** | omitted for oneshot |
| persistence | `store: true` | `store: true` |

`delay` is not a documented field on this call, and an unrecognised field is a
plausible cause of a validator error.

0.4.6 stops guessing one shape at a time. `setTickAlarm()` tries four, in order,
and reports which the OS accepted:

1. `sec` — `date` in seconds, `repeat_type` set (ONCE for oneshot,
   REPEAT_MINUTE for repeat), `store: true`
2. `msec` — same with `date` in milliseconds
3. `sec-norepeat` — no `repeat_type` at all
4. `sec-nostore` — no `store`

The hint reads `ok <shape> id=<n>` on success; on total failure every shape's
error is rendered as a **notification** (`sec:... | msec:... | ...`), because the
hint line cannot show a 120-character error legibly on a 390 px screen. That was
also fixed: the hint is now 14 px and wraps.

Success means a wake ~30 s later should render a `Tick` notification by itself —
the firing proof E1 needs.

---

## 0.4.5 — the service ran once and then wedged the slot

Evidence: `start code=0 perm=2`, an immediate `Tick` notification, then nothing
on later presses, and `Alarm diag` showing `cnt=0`.

That is not a failing alarm. It is a service that **executed and never exited**:

```js
if (typeof exit === 'function') exit()   // 0.4.0-0.4.3
```

`exit` is a module export of `@zos/app-service`, not a global. For an undeclared
identifier `typeof` returns `'undefined'` instead of throwing, so the guard was
silently false every single time and the tick never exited. A `start()`-ed
service that does not exit is a *continuous* service, and only one may exist:
every later `start()` returns `0` (accepted) and executes nothing because the slot
is already taken. First press works, everything after it is silent.

This also re-reads finding 11 ("an alarm targeting the running service destroys
it") - a live instance left behind by a manual start is the same shape of problem.

0.4.5:

- `import { exit } from '@zos/app-service'` and call it; report `ex=fn|no` in the
diagnostic notification so this can never again be mistaken for a dead alarm
- **`Arm: oneshot (test)` is now the primary path**: the page sets a `ONCE` alarm
  ~30 s out, the OS cold-starts the service as a single-execution invocation, and
  the OS reaps it. No `exit()` required, no continuous instance, no slot to wedge
- `Start tick` is relabelled *holds slot* and is no longer the recommended test
- the alarm helpers stay inlined in the service (it should not pull the page's
  `queryPermission`/`requestPermission` UI APIs into a background context), but
  `@zos/app-service` itself is imported - the earlier suspicion that importing it
  broke the service was wrong, and it cost two builds

Recovery from the wedged slot: **uninstall, reinstall**. A force-stop does not
clear it (finding: no `onDestroy` ever fires). Uninstalling also clears the stale
alarms from the 0.4.0/0.4.1 attempts.

Test after reinstall: `Alarm diag` (`bg=2`, `cnt=0`) -> `Arm: oneshot (test)` ->
wait 40-70 s -> a notification should appear without touching the watch. Then
`Alarm diag` again: `cnt=1` means the wake re-armed the chain.

> **0.4.7 correction:** that order was wrong. The permission is requested when the
> page opens (0.4.7) or as part of Arm, never by `Alarm diag` alone, so a diag
> pressed before anything else correctly reported `bg=0` - "never asked", not
> "denied". 0.4.7 asks on `build()`, shows `perm` in the status block, and makes
> `Alarm diag` request it before rendering. Pressing diag first is now meaningful.

---

## 0.4.2 — two regressions, not a dead subsystem

0.4.1 produced no notifications from **either** alarm mode. That is not evidence
that `@zos/alarm` is broken here: 0.1.4 measured `alarm.wake onInit` *and*
`alarm.wake onEvent` after a reboot (finding 7), so the subsystem works on this
firmware. Both failures are mine:

1. **The `device:os.bg_service` request was dropped.** 0.2.x asked for it every
   time Arm was pressed. 0.4.0 replaced Arm with "set an alarm" and the request
   went with it. An App Service that was never granted the permission is neither
   startable (`start()` -> code 3) nor launchable by an alarm, and both failures
   are silent.
2. **The first alarm is armed from the page.** The one build whose alarms are
   known to have fired (0.1.4) armed from *inside* the service, with the page only
   calling `start()`. 0.4.x armed from the Device App and never fired once.

0.4.2 restores both: `Start tick + arm next` asks for the permission, starts the
service with `mode=oneshot&show=1`, and the service arms the next one-shot before
doing anything else. The hint reports `start code=<n> perm=<n>` — the string that
should have existed from the beginning.

| hint | meaning |
|---|---|
| `code=0 perm=2` | started, permission granted; a notification should appear within ~60 s |
| `code=3 perm=0` | permission denied -> nothing background can ever run |
| `code=2` | service state error (an instance is already running) |
| `code=0`, no notification, no `tick start` in the log | the service was accepted but never executed |

Reading the device log: service lines reach the page through the `@zos/fs` sink,
and `@zos/fs` writes are only permitted while the screen is off. So press Start
tick, let the screen go dark, wait a minute, *then* open Device log - reading it
immediately after pressing shows only the page's own lines.

---

## 0.4.1 — the alarm never fired (diagnostic build)

0.4.0 produced **no `tick.wake` and no `probe.answered`** in the trace. That is
consistent with three different failures, and the build could not tell them
apart:

| failure | what it looks like |
|---|---|
| `alarmMgr.set()` from the page is a no-op | no alarm, no wake, nothing in the log |
| the alarm exists but never fires | same |
| the alarm fires, the tick runs, but its frame never reaches the phone | same, because `tick.wake` travels over the dead link |

Two concrete suspects in 0.4.0:

1. **`date` was omitted.** The only official sample
   (`notification/app-service/delay.js`) sets `date` (seconds since epoch) and no
   `delay`. 0.4.0 sent only `delay: 30`, which came from a discussion thread and
   was never verified on this firmware.
2. **`repeat_type` was guessed.** `alarmMgr.REPEAT_MINUTE` was used when present,
   else the literal `1`. If that constant is not `1` on this API level, the alarm
   may be scheduled hourly or daily - indistinguishable from "never fires"
   inside a two-hour window.

0.4.1 therefore tests both mechanisms and removes the BLE dependency from the
proof:

- `Arm: repeat` -> `repeat_type/period/duration` + `date` (the plan's shape)
- `Arm: oneshot` -> `ONCE` + `date`, re-armed by the tick on every wake, so it
  cannot expire and needs no repeat support
- both arm with `show=1`, so **every wake renders a notification** - proof of
  firing that needs neither BLE nor a shared storage context
- `tick start wake=...` is written to the device log before anything that can
  hang, so "did the service execute" is answerable offline
- `Alarm diag` renders the API surface itself: `set/list/cancel/get`, the value
  of `REPEAT_MINUTE`, `bg_service` permission state, and `getAllAlarms()` raw
- bounded self-arm from the tick (repeat mode only, and only when
  `getAllAlarms()` confirms the alarm is missing)

Read it: arm one mode, watch the watch. Per-minute notifications = that
mechanism works; nothing after 2 minutes = try the other. If **neither** fires,
the alarm subsystem itself is unavailable on this firmware - which also kills the
"local scheduled reminders" fallback, because that needs the same alarms. In that
case the only remaining path is phone-side notifications mirrored by Zepp.

---

## E1: what this build is allowed to claim

`TICK_KIND = 'probe'` in `app-service/notifier.js`. Nothing is rendered, nothing
is fetched. E1 answers exactly one question:

> Does an alarm-woken single-execution service get a BLE answer while the mini
> app is closed, the screen is off, and the watch is idle?

Pass = one `probe.answered {from:"alarm"}` per minute for two hours.

| trace | meaning |
|---|---|
| `tick.wake` then `probe.answered` | healthy: alarm fired, link answered |
| `tick.wake` alone, no `probe.answered` | alarm fires, handshake or response never arrives -> transport still foreground-scoped, architecture is dead |
| neither | the alarm did not fire, or the Side Service is not running |
| `probe.answered` gaps of 2-3 min | alarm throttling; measure, do not assume |

```sh
jq -r 'select(.event=="probe.answered") | .ts' server/log/events.jsonl | wc -l
python3 server/summarize.py --since $(date -d '-2 hours' +%H:%M)
```

If E1 passes: flip `TICK_KIND` to `'poll'` for E2 (render + latency). If E1
fails on `tick.wake`-only, the transport really is foreground-scoped and the
fallback is local scheduled reminders - which needs a **file-backed** payload
store (`LocalStorageFile`), because page and service `localStorage` are separate
stores.

## Install / run (E1)

1. `cd watch && npx zeus build` -> `dist/10262217-Notify_Relay-0.4.0-*.zab`
2. install via Zepp app (Developer Mode), open **Notify Relay**
3. set the relay URL in the phone-side app settings
4. press **Arm alarm** - the hint shows `{"ok":true,"id":...}` and the status
   block shows `alarms: 1 (1/min)`
5. press **Tick now** - one manual tick without waiting; the top line should
   change to `last tick: Ns ago` within a few seconds
6. close the app, turn the screen off, leave the watch alone for 2 h

Watch for the pile-up failure mode: if the status block shows `alarms: 2+`, the
`getAllAlarms()` dedupe is not working on this firmware (the fallback reports
`dedupe:"stored-id"` in the arm hint).

---

# History: v0.2.4 (superseded, kept for the reasoning)

Where the notifier spike actually stands, so this survives transcript loss.

## Build on the watch: v0.2.4 (`watch/app.json` version code 15)
No watchdog, no alarms, no `ensureContinuous()`. Permissions:
`data:os.device.info`, `device:os.local_storage`, `device:os.notification`,
`device:os.bg_service`.

## What is proven on hardware
- notification render with up to 3 sender-defined buttons; tap -> ack -> server
  (including from a cold start in < 1 s, inside the 600 ms single-execution budget)
- device-side SQLITE-shaped work is irrelevant; the **page** can do a full BLE
  request/response round trip to the Side Service (the "BLE probe" button:
  `probe.answered` at 21:13:26 after a fresh reinstall)
- phone Side Service polls HTTP reliably at 15 s and survives app restarts
- relay contract: queue, cursor by `created_at`, action ids, events.jsonl

## What is broken (as of 21:20)
After the 19:57 reinstall, the watch App Service produced **no `service.online` and no
pongs in 80+ minutes**, while the page reported `Service: RUNNING`, the Side Service
kept polling, and the page's BLE probe succeeded. No `ack.received` either, when a
local test notification was tapped.

Three candidate explanations, none confirmed:
1. the App Service is not actually running and `getAllAppServices()` lists
   *configured* services rather than running ones (so "RUNNING" is meaningless);
2. the service runs but the BLE link it created in `onInit` is dead, and
   `Time.onPerMinute()` does not fire in a service context, so nothing can heal it;
3. `start()` returned code 2 and the old code reported that as
   `{ok:true, already:true}` — i.e. "Armed" meant "the OS refused to start it".

## Next action (pending user)
Install **v0.2.4** and report two things:
- the `svc:` line in the status block (raw `getAllAppServices()` payload)
- the Arm hint (does it contain `"code": 2`?)

v0.2.4 changes, all diagnostics:
- `start()` code 2 is reported as failure, not success
- status block shows the raw services list
- that state is also written to the device log

## If the answer is "code 2 / strings-only list"
The service has been wedged since the reinstall; everything measured after 19:57 is a
phantom. Recovery: uninstall (clears the slot and any OS alarms), reinstall, re-enter
relay URL `http://192.168.68.61:8097`, empty token, interval `15000`, Arm once.

## If the answer is "code 0, really running"
`onPerMinute` does not fire in a service context -> the per-minute self-healing idea
is dead -> the continuous-service design has no remaining mechanism, and the
architecture decision is between local scheduled reminders (alarm -> page, proven
BLE path) and phone-notification mirroring (ntfy/Android, unverified on Active 2).

## Baseline to beat
16-cycle soak: 9/16 rendered, median queue->render 361 s, max 5156 s,
2128 `ping.unanswered` vs 224 `pong`.

---

## 21:25 update — the "RUNNING" indicator was fake
User reported: the page says `RUNNING` and `Armed: yes` **on first open, before
pressing Arm**. Both are defaults, not states:

- `getAllAppServices()` returns the services **declared in `app.json`**, so
  `notifierState().running` is permanently true. `app.js` gated its auto-arm on
  `if (notifierState().running) return`, so **auto-arm never once ran**.
- `isArmed()` returns true when the key is absent (deliberate, so a missed write
  can't leave the watch silently unarmed).

So there is no evidence the App Service ran at all after the 19:57 reinstall, and my
"running but mute" reading was unfounded.

### v0.2.5 (code 16) — fixes and one honest signal
- `app.js` auto-arms on launch when `isArmed()`, no longer gated on the fake flag.
- `restartOrStart()` asks `start()` first and only stop/starts on code 2.
- Status block no longer claims RUNNING; it shows `Armed/Disarmed`, the bg_service
  permission, and the count of declared services labelled "(not liveness)".
- **New top line, the one that cannot lie:** `watch->phone: 12s ago` / `service
  NEVER spoke` / `LINK FAIL`. It comes from the Side Service's age of last
  device message (`sinceDeviceMs` in the probe response), i.e. measured on the
  phone, not self-reported by the watch. Updated on build, after Arm, and by the
  "Refresh link status" button.

### Reading v0.2.5
| top line after Arm | meaning |
|---|---|
| `watch->phone: 2s ago` | service is running and its messages arrive — earlier failure was the arm path, not BLE |
| `service NEVER spoke` | link works (probe answers) but the App Service has never sent anything -> it isn't running, or its BLE is dead |
| `LINK FAIL` | the phone-side listener or the device BLE is down |

### Incident
A `str.replace("", new)` in a patch script duplicated `shared/service.js` 600x
(97k lines). Not a git repo, so it was recovered by splitting the mangled file on
the repeated block and re-joining the single characters between copies: no loss.
Backups of the pre-patch file: `/tmp/service.recovered.js`.

---

## 22:16 — the transport is app-scoped, not service-scoped

v0.3.2 instrumented the phone side. Result from the instance that started 22:07:19:

    side.alive  polls=20  sock="1"  dev_ms=-1      ← peerSocket OPEN
    push.sent   polls=12, 15, 21                   ← accepted, never rendered
    notify.shown: none        ble.send_failed: none

Device side (v0.3.0/0.3.1 self-test, service running, clock working):

    mb=1 p=1018 snd=ok hb=1 raw=1 msg=0 call=0 sil=never

Interpretation, with the earlier rounds:
- the device received **exactly one** frame in its lifetime: the Shake reply to its
  own `onInit`/heartbeat send. Everything the phone sends spontaneously is absent.
- removing the inbound port filter (0.2.8) did not help, so it was not port staleness.
- `fork()` (0.2.8) re-shakes before every send; `snd=ok` proves `ble.send` is accepted,
  and the side reports no send failures — so neither end reports an error.
- `Time.onPerMinute` DOES fire in the App Service (`hb=3`, `hb=1`), so the service runs
  and has a clock. `isArmed()` is true there. The rebind path executes (`rb=1`).

Conclusion: while the mini program is not in the foreground, the OS suspends the
device<->side BLE session in *both* directions, silently, with no API error on either
side. The App Service keeps executing JS but is deaf and dumb. This matches:
- the maintainer's model (zml#3: device-app is the browser, side-service the server),
- every trial today (fresh context: works for seconds-to-minutes; afterwards: silent),
- the soak result (9/16 delivered, median 6 min, worst 86 min).

Watch-side work cannot fix this. The remaining options are the ones already listed:
local scheduled reminders (alarm -> single-execution service -> notify), or phone
notifications mirrored by Zepp.

### One experiment left before declaring it
Keep the mini app **open on the watch** (screen on the app page, watch awake) for
10 minutes while notifications are sent, and compare with the same 10 minutes with
the app closed. If open = all delivered and closed = none, the transport is
foreground-scoped and the background design is finished.
