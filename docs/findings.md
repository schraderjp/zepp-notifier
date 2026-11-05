# zepp-notifier: what we tried, what works, what doesn't

Hardware: Amazfit Active 2 Square (390x450), Zepp OS 3.0, paired Android phone.
Goal: a homelab service can reliably notify the watch and the user can answer with
buttons. Written after a full day of hardware trials; every claim below is measured,
not inferred, unless marked "unverified".

## What works

| capability | evidence |
|---|---|
| Notification rendering with up to 3 **sender-defined buttons** | `notify.shown actionCount 3`, notification-center ids assigned |
| Tap -> ack -> server | `ack.received action=yes transit_ms ~600` |
| Tap -> ack **from a cold start**, no running service | action param cold-starts the service; ack lands inside the 600 ms single-execution budget |
| Phone side service: HTTP polling every 15 s, cursor, ack outbox, replay | hours of `pong`/`poll` traffic; survives relay restarts |
| Relay: queue, timestamp cursor, persisted state, events.jsonl | survived a process restart and a host reboot |
| **Page context BLE**: page -> side service request/response | `probe.answered` on demand, ~200 ms, never failed once |
| `@zos/alarm` with `store: true` | survives a watch reboot; fires on schedule; arrives on both `onInit` (cold) and `onEvent` (live) |
| Alarm-woken single-execution service renders a notification | works within the 600 ms budget |
| Continuous App Service **runs** in the background | `onInit` logs, rebind executes, JS alive for hours |
| `Time.onPerMinute` inside an App Service | `hb=3` — the minute clock fires; the only periodic hook a service has |
| Local notifications with action buttons | `Local test notification` button, tap acks correctly |
| Device log | works within one screen-on session (see limits) |

## What does not work

| attempt | outcome |
|---|---|
| **Continuous App Service holding the BLE link** (the whole design) | silent two-way death within minutes of the app leaving the foreground: phone socket `readyState=1`, `ble.send` accepted, zero frames delivered, no error on either side. `dev_ms=-1` on the phone: nothing ever arrives from the watch |
| Side Service **pushing** to the device spontaneously | frames never delivered unless the mini app was recently in the foreground |
| Alarm-driven **watchdog** to keep the service alive | alarm wakes produce ~2 s single-execution instances; `start()`/`ensureContinuous()` from inside a service was never promoted to a continuous instance |
| Alarm event delivered to a **running** service | followed by `service.offline` ~30 s later in every observed case |
| Self-re-arming **alarm chain** | each JS context caches its own localStorage, so an instance cancels a stale alarm id while older ones survive -> unbounded pending alarms firing off-schedule |
| Re-shaking before each send (ZML `fork()` port) | `ble.send` accepted, shake replied (`p=1018`), delivery still dead |
| Removing the inbound port filter | no effect |
| Rebuilding the connection on a `Time` tick (`rebind`) | executes (`rb=1`), does not restore delivery |
| `getAllAppServices()` as a liveness check | returns the services **declared in app.json**, so it says RUNNING on a fresh install; every "RUNNING" reading today was meaningless |
| Pruning stale Side Service instances | no `onDestroy` ever fires; force-stop does not kill them; the storage-based leader lock has never stepped one down |
| Device log across sleep | localStorage caches per JS context (service lines lost on service death); `@zos/fs` writes only while the screen is off — neither survives |
| Full soak (16 notifications over ~8 h) | **9/16 delivered**, median queue->render 361 s, worst 5156 s, 2128 unanswered pings vs 224 pongs |

## Platform facts that cost us the most

- **No push, no websockets, no third-party background execution.** The only
  device-side receiver is a continuous App Service, and the OS suspends its BLE
  session when the mini program is not foregrounded.
- **Device app is the "browser", side service is the "server"** (zml#3, Zepp
  maintainer): the side cannot deliver until the device has initiated a link.
- **Single-execution invocations** (alarm, notification tap, system event) are capped
  at 600 ms and cannot promote themselves to continuous.
- **App Service limits**: no `setTimeout`/`setInterval`, no UI, no high-power sensors,
  `@zos/fs` writes only when the screen is off, only one background service slot
  across all installed apps.
- **Permissions** are granted silently at install on production firmware; the
  install-time dynamic prompt in the docs does not appear.
- **Storage is per-context**: page and service `localStorage` are separate stores.
- `@zos/ble` is available in a service, but availability != a working session.

## What is still unproven

- Whether the transport is strictly **foreground-scoped**: 10 minutes with the mini
  app open on the watch vs 10 minutes closed, same notification cadence. This is the
  only remaining experiment, and it decides whether the live-push design exists at all.
- Whether the Active 2 Square **mirrors reply actions** from Android notifications
  (needed for the phone-notification fallback).

## Options remaining

1. **Local scheduled reminders** — one alarm per reminder, payload synced while the
   app is open, alarm-woken service renders it. Uses only mechanisms that work here:
   survives reboot, fires with the phone offline, buttons + ack proven. Content is
   only as fresh as the last sync. Good fit for medication schedules.
2. **Phone notifications mirrored by Zepp** — ntfy or a small Android app posts a
   notification; Zepp's own pipeline carries it. Reliable transport, poor
   expressiveness (one Reply affordance, free text parsed to yes/no).
3. **Live-push mini app, app-open only** — what is actually built, minus the
   pretense that it works in the background.

---

## Prior art that changes the plan: SashaCX75/Weather-service

https://github.com/SashaCX75/Weather-service — a working weather app whose whole purpose
is periodic device->phone network access from a background service. Its shape:

```js
// app.js
App(BaseApp({ globalData: {...}, onCreate() {...} }))

// app-service/weather_service.js
import { BasePage } from '@zeppos/zml/base-page'
const timeSensor = new Time()
const globalData = getApp()._options.globalData          // works inside an App Service

AppService(BasePage({
  onInit() {
    timeSensor.onPerMinute(() => {                       // the only clock a service has
      if (timeSensor.getMinutes() % 10 === 1) this.getDataFromNetwork('weather')
    })
  },
  getDataFromNetwork(type) {
    this.request({ method: 'GET', url, type, ... })      // DEVICE-INITIATED request
      .then((result) => { globalData.weatherJson = result.data; globalData.weatherFile.set(...) })
  },
}))

// app-side/index.js — a pure server: onRequest(req, res) { fetch(...); res(null, data) }
```

Four things we did not have:

1. **`AppService(BasePage({...}))`** — ZML's wrapper, which is what makes `request()`
   legal inside a service: ZML resolves request/response with `@zos/app`'s
   `onMessage`/`postMessage`, not `setTimeout` (the sample's version throws
   "not a function" there).
2. **Device-pull, never side-push.** Every exchange is initiated by the device on a
   minute tick; the side only answers `onRequest`. This matches our measurements
   exactly: only device-initiated exchanges were ever delivered.
3. **`getApp()._options.globalData` is usable inside an App Service** — the service
   shares the App's in-memory state, including the shared messaging object.
4. **A file-backed JSON payload store** (`easy-storage` + a `LocalStorageFile`) so the
   service can read the last synced data without the app running — the same primitive
   the scheduled-reminder fallback needs.

Consequence: the architecture to build is device-pull on `Time.onPerMinute` with
`this.request()`, latency <= 60 s, side service as a pure server. No side push loop,
no continuous BLE session to keep alive, and one request per minute re-establishes the
link when it has been dropped.

---

## The definitive architecture (field-proven, from two independent apps)

Source: zepp-health discussion 270 comment thread (mrklos/T4ASICK, Apr 2025) plus
SashaCX75/Weather-service. Both authors ran continuous App Services that died
overnight or on Bluetooth loss, and fixed it the same way.

**Do not run a continuous App Service.** Wake a short-lived one from a repeating
alarm and let it exit:

```js
// page: dedupe through the OS, never through stored ids (per-context localStorage cache)
const alarms = alarmMgr.getAllAlarms()
if (!alarms.some((a) => a.url === SERVICE_FILE)) {
  alarmMgr.set({
    url: SERVICE_FILE,
    repeat_type: alarmMgr.REPEAT_MINUTE,
    repeat_period: 1,     // a period is one minute
    repeat_duration: 1,   // fire once per period
    store: true,          // survives reboot
    delay: 30,
  })
}

// service: one unit of work, then exit on EVERY path including catch
AppService(BasePage({
  onInit(e) { try { tick(this, e); exit() } catch (err) { exit() } },
  onEvent(e) { try { tick(this, e); exit() } catch (err) { exit() } },
}))
```

Rules that came with it:

1. **`connectStatus()` from `@zos/ble` first.** mrklos: the service "goes dark" when it
   tries to send while Bluetooth is down, and never recovers until the Zepp app is
   killed and restarted. Work only when connected; otherwise exit.
2. **`exit()` on every path.** Their 24/7 fix in full.
3. **Device-pull only**, `this.request({t:'poll'})` from ZML's BasePage; the side is a
   pure `onRequest` server doing the HTTP. Never side-push.
4. **Do not use ZML's `httpRequest` in the service** — reported flaky there; HTTP
   belongs in app-side and comes back through `request`.
5. Alarm dedupe via `getAllAlarms()`, because a stored id is invisible across JS
   contexts.

Why this matches everything measured today: a fresh context works (a notification
rendered, a shake answered, 14 pongs), a long-lived one goes silently deaf, and the
transport treats device-initiated exchanges as the only reliable direction. One alarm
wake = one fresh context = one reliable exchange, then exit before the OS can freeze a
half-dead session.

Latency: one alarm period (60 s with `repeat_period: 1`). Acceptable for medication.
Constraint to respect: single-execution invocations are budgeted (~600 ms of
foreground, a few seconds of wall clock measured at 16:04). Poll + render must fit; the
relay queue keeps items until acked, so a missed cycle costs a cycle, not a reminder.

---

## 21:35, 2026-11-04 — MEASURED: sleep mode freezes the alarm chain; DND does not

Watch (Amazfit Active 2 Square), 0.5.2, chain armed silently at 60 s.

    wake gaps while running          60.6  59.8  60.6      s
    sleep mode switched ON   ->     301.5s hole, no wakes at all
    sleep mode switched OFF  ->     61.3s, chain resumes by itself, no re-arm needed

DND was on for the whole window and did not affect delivery.

Consequences:

1. **DND is the way to run night tests silently.** `notify({vibrate: 0})` still
   vibrates on this firmware, so there is no app-level mute; system DND is the only
   quiet path, and it leaves the tick chain running.
2. **Sleep mode is a hard stop for reminders.** While the watch is in sleep mode,
   alarm-woken service invocations do not happen. The chain is not destroyed - it
   resumes on the first wake after sleep mode ends - but nothing is delivered during
   that window. A dose reminder scheduled inside it arrives when sleep mode ends,
   i.e. late, which for medication needs to be handled as a missed dose rather than
   a delivered one (see expiry, still unimplemented).
3. Test protocol implication: any overnight run must have **sleep mode OFF and DND
   ON**, otherwise it measures a frozen chain rather than the transport.
4. Unknown: whether the alarm fires and the *service* is blocked, or the alarm is
   never delivered. Distinguishable from the on-device file log after a sleep window
   (screen-off is exactly when @zos/fs accepts writes), if it ever matters.
5. Product question worth checking on the watch: whether the OS exposes an "alarms
   may interrupt sleep mode / DND" exception. Our wakes are app alarms, not system
   alarms, so they are probably not covered - but if such a toggle exists it may be
   the difference between "no night reminders ever" and "night reminders work".

### Severity, per the user (2026-11-04)

Not a blocker for the intended use: medication reminders are only scheduled during
waking hours, so the sleep-mode freeze is a documented behaviour rather than a
defect. Two things still follow from it:

- **Boundary cases.** A reminder due just before sleep mode ends (e.g. 07:00) can
  slip to the first wake after it. Expiry is the right answer: deliver late only
  while the dose is still actionable, otherwise drop it and say so.
- **Don't design around it silently.** If a reminder is ever scheduled inside a
  sleep-mode window, the product must predict the lateness rather than appear to
  have delivered on time.

### Two follow-ups from "general notifier, meds as the first use case"

1. **Expiry should be per notification, not global.** Late delivery at sleep-mode
   exit is acceptable for a 07:00 dose, so a blanket TTL would be wrong. An optional
   `expires_in` on `/v1/notify` (drop at poll time, report `notify.expired`) lets a
   sender choose: high-frequency/urgent items expire, "take your meds" does not.
2. **Cadence should be a setting, not a constant.** The 60 s floor is our chain's
   choice, not the platform's: oneshot alarms accept a smaller `delay` (the code
   clamps at `MIN_DELAY_SEC = 20`). 60 s is right for battery; 20-30 s is available
   for "the kettle boiled" style use at the cost of 2-3x the wakes. Make it a
   setting with the battery trade stated, and keep the chain's own re-arm in sync.
3. Practical limit worth stating up front: delivery is wake-quantised, so bursts
   arrive together and nothing is faster than the cadence. Anything needing seconds
   is not this transport.

## Contract decisions agreed in conversation (2026-11-04, to implement tomorrow)

Principle: **the relay owns facts and queue mechanics; senders own policy.** The
relay refuses to decide which answer is authoritative, when to re-ask, or what is
"too late".

Senders: `/v1/notify` (queue) and `/v1/events?since=&kind=` (observe). Nothing else.
Watch/side: `/v1/inbox`, `/v1/ack`, unchanged.

- **Answers are append-only facts**, `[{action, at, seq}]`; the relay does not pick a
  winner. Identical retries (same id+action, e.g. outbox replay) collapse; distinct
  answers are separate facts. The *only* mechanical rule: the first answer stops the
  item being served again (queue management, not interpretation).
- **No `no_answer_after` field.** The relay exposes `rendered_at` (stitched from the
  new `rendered` event) and `answered_at`; the sender computes lateness/escalation.
- **No webhooks.** `GET /v1/answers?since=&wait=` long-poll (ThreadingHTTPServer, so
  a blocking wait does not stall the watch's requests); `wait=0` is plain polling, so
  one mechanism covers both. Resumable by cursor; nothing new to secure.
- **One fact log, filtered views**: `kind=rendered,answered,expired,unanswered`.
- **`key`** on notify: same key replaces an already-queued item instead of stacking,
  and doubles as the retry idempotency key.
- **`tag`**: sender-set routing label, carried into facts, so each homelab app filters
  its own traffic.
- **`expires_at`**: sender-set; relay drops at serve time and records `notify.expired`.
- **No-action notifications** (`actions: []`) are already proven on hardware (every
  `Tick` notification). Use `expires_at` aggressively for them.
- **Receipt pattern**: a notification with one action (`{id:'ack', label:'Got it'}`) is
  still an answer, so it proves attention without offering a choice; a missing receipt
  is an `unanswered` fact the sender can escalate on. Reserved action id: `ack`. No
  protocol change needed - it is just a one-action notification.
- Delivery guarantee: **currently at-most-once with a one-poll grace period** (see the
  correction below) - NOT at-least-once, despite what this file said earlier.
- Non-guarantees to document: wake-quantised (nothing faster than the cadence), no
  ordering guarantees, sleep mode freezes the chain, **rendered != seen**.

---

## 22:20, 2026-11-04 - two corrections and one measurement

### MEASURED: emoji render fully
`notify()` has no icon or emoji field, and the design guidance only names Noto Sans /
Zepp OS Number, so this was untested. A notification with
`title "Emoji A\u2705B"`, body `\u2705 \u26a0\ufe0f \U0001f6b0 \u2764\ufe0f \u23f0 \u2192 \u2460`
rendered **every glyph correctly** on the Active 2 Square (0.5.2, `rendered shown=1`).

Use: emoji are a usable source/severity marker inside the title, because the OS gives
us no colour, icon or badge. Recommended split, consistent with "senders own policy":
**the sender writes its own marker** (`\U0001f48a Evening dose`, `\u26a0\ufe0f Disk 98%`) and `tag`
stays a machine-readable field for filtering. The relay should not decorate titles by
default; if it ever does, it must be opt-in per notification.

### CORRECTION: delivery is at-most-once, not at-least-once
`inbox()` in app-side commits `since` at the START of the next poll, independent of
whether the watch rendered the batch:

    if (cfg.pending) { commit(cfg.pending); cfg.pending = 0 }   // next poll, unconditionally
    ...
    if (items.length) cfg.pending = cursor                      // deferred by exactly one poll

That is a one-poll grace period. If a wake dies between the response and the render,
the item is gone, and an earlier claim of at-least-once in this file was wrong.

**Fix (tomorrow, side-only - no watch install):** commit the cursor on *receipt*
instead of on time. The side holds the last served batch and only advances when the
`rendered` event (added in 0.5.2) arrives covering those ids, or when an ack for one of
them arrives; otherwise it re-serves. The `rendered` event stops being pure telemetry
and becomes the commit signal, which also makes "delivered" mean "was on the wrist"
rather than "was handed over".

---

## 09:30, 2026-11-05 — root cause narrowed: the phone-side instance, and a 5-minute reproduction

### Confirmed
The 09:05 failure and the 09:20 success differ in exactly one thing: **a fresh Side
Service instance** (the 0.5.3 install restarted it). The old instance had 680 polls and
11.5 hours behind it; every item-bearing response failed on it, and the first attempt
on a new instance delivered in 31 s. So the fault is in the long-lived phone-side
service, not the watch, the transport or the relay.

### Not fixable by rebinding the socket
`mb.listen()` calls `messaging.peerSocket.addListener` and the Messaging API documents
no `removeListener`, so re-listening after `stop()` **stacks handlers** and every
message would be handled twice. An automatic rebind is therefore not safe; 0.5.4
detects and surfaces the condition instead and tells the user the one action that
works: open the app.

### What 0.5.4 adds
- relay: an item served `STUCK_SERVES = 3` times without a render report sets
  `stuck: true` (and `stuck_ids`) in the inbox response, and records `notify.stuck`
  (throttled to once a minute). Verified by serving one item three times by hand.
- side: `side.stuck` event, `stuck` in `poll.served`/`side.alive`/probe payloads.
- page: the probe result now prints `delivery stuck (…) - reopen this app` instead of
  a cheerful "link ok".
- With ack-driven delivery, the consequence of a stuck side is **lateness, not loss**:
  items re-serve until a render report arrives.

### Hypothesis to test next (cheap: ~5 minutes, no waiting for 3 hours)
Degradation was first seen at 00:35 — the same night the user **disabled
wrist-to-wake** and the screen stayed off for hours. It did not recover that morning
with the screen on, which fits "the socket state breaks during screen-off and stays
broken for that instance". Test: with a fresh instance, turn wrist-to-wake off, leave
the watch untouched 5 minutes, queue one notification.
- fails -> screen-off is the trigger, reproducible in minutes rather than hours, and
  the product needs a mitigation (e.g. keep responses tiny, or expect a daily app open).
- succeeds -> not screen-off; the trigger is instance lifetime, and we measure it by
  leaving a build armed for 3 hours unattended.

---

## 2026-11-05, mid-morning — the wake budget contains a network call

Two consecutive serves of `46-747e10` produced no render report and the third
succeeded, on a **fresh** Side Service instance with the screen off. So the failure
is intermittent and is not instance age alone. The distinguishing feature of a
failing serve was that the Side Service performs `GET /v1/inbox` **inside the
watch's freshly-woken execution budget**; when the phone or watch is idle that fetch
plus the response exceeds the time the context is alive, and the response is
delivered to a service that has already been reaped. A minute later the relay
re-serves the item under the ack-driven contract, which is why the notification
arrives late rather than never.

Fix in 0.5.6: the side keeps a 12 s cache refreshed by its own timer and answers the
watch from memory, so the round trip contains no network call. `poll.served` reports
`mode=cache` and `age_ms`.

### Two instrument faults found and fixed in the same hour

* **`served_count` counted cache refreshes.** The side's `peek` refresh hit
  `/v1/inbox`, which the relay counted as a handover, so any item older than ~30 s
  would have tripped `stuck` and sent us chasing a phantom. `peek=1` now leaves
  `served_count` untouched; verified both directions (3 peeks → unset, 1 real poll
  → 1).
* **The watch lights its own screen.** An activity reminder ("Take a walk") turned
  the screen on at 09:49, inside a window that was supposed to be screen-off. Any
  future screen-off experiment must confirm the screen state independently, because
  the watch does not leave it off for the whole observation period.

### Reading the trace

Relay-generated events (`notify.rendered`, `notify.stuck`, `notify.abandoned`,
`probe.answered`) store their fields at the **top level** of the JSON line; only
watch-sent beacons nest under `.data`. Queries that read `.data.ids` on a
`notify.rendered` event silently print empty and look exactly like a bug — this cost
time twice today.

`server/watch_run.py [--from-end]` exits 2 on the first anomaly (no wake for >150 s,
`notify.stuck`, `notify.abandoned`, `poll.nores`) and otherwise prints a summary after
`WATCH_DURATION` seconds. It exists so an unattended run reports its own verdict
instead of requiring a human to poll.

### `served_count` is unusable under cache serving — `stuck` must be age-based

In cache mode the watch is served from the side's memory, so the relay never sees an
`/v1/inbox` fetch that returns the item (the side's refreshes pass `peek=1` by
design). `served_count` therefore stays unset for every delivered item, and the
original rule — `stuck` when `served_count >= 3` — could never fire. It was replaced
with a time rule: an item queued and unrendered for `STUCK_AGE_MS` (5 min) is stuck.
Both thresholds are env-overridable (`STUCK_SERVES`, `STUCK_AGE_MS`) so this can be
verified on a throwaway instance instead of by waiting five minutes.

Verified on a scratch relay: `stuck` false at t+0, true at t+1.6 s with
`STUCK_AGE_MS=1200` and `served_count` unset, `notify.stuck` logged once, `peek`
never reporting stuck, and the flag clearing once the item was reported rendered.

Two traps worth remembering: the field is `created_at`, **not** `queued_at` (a wrong
key silently disables the rule, because `n.get(...) or now` yields zero age), and
never `pkill -f spike_server.py 8098` — the pattern matches the calling shell's own
command line, which `server/relay.sh` exists to avoid.

### Delivery closed for waking hours (2026-11-05)

16/16 cycles delivered, 0 stuck, 0 abandoned, 0 poll.nores, **0 duplicates** by the
operator's count, across four hours in which the phone went untouched for two-hour
stretches and the watch was never touched. The side instance passed the 3 h 08 m age at
which yesterday's run began losing every item.

Conclusion: the loss was the network call inside the freshly-woken service's execution
budget, and serving the watch from the side's cache removes it. What remains is
receipt loss producing occasional duplicates rather than losses — the acceptable side
of the at-least-once trade.

Doze was considered and ruled out for this setup: the phone charges overnight, so it
never enters doze (which requires unplugged and stationary), and the Zepp app is
excluded from battery optimisation, so the side's timers are not throttled either. That
removes the remaining phone-side explanation for the 2026-11-05 overnight loss.

## 2026-11-05 — the v1 sender API is implemented, and two things it taught us

The sender contract (key/tag/expires_at/not_before/extras, `/v1/events`,
`/v1/notification/<id>`, append-only answers, chain health) is implemented in
`server/spike_server.py` with no watch build, because the device-facing shapes did not
change.

**Chain liveness had to be re-derived.** It was inferred from a non-peek `/v1/inbox`,
but that call no longer happens: the side answers the watch from its 12 s cache and only
ever peeks the relay. So `LAST_POLL_MS` never advanced and `/health` reported `silent`
on a chain that was polling every 60 s. Liveness now follows the side's `poll.served`
report, which is emitted when the watch actually asks. General lesson: any health signal
the relay derives from traffic must be derived from traffic that still exists after a
cache/rearchitecture, and the cache removed the relay's view of the device poll entirely.

**Facts and the poll clock are part of durable state.** `key` idempotency lives in the
item fingerprints, so a relay that restarts with an empty state file turns a sender's
retry into a duplicate reminder. `FACTS`, `FACT_SEQ` and `LAST_POLL_MS` are persisted
with the queue, and pre-v1 state is migrated on load: the legacy single `answer` string
is seeded into `answers[]` so "append-only" stays true across the upgrade.

**Serve-time gates are cheap and belong together.** `expires_at` and `not_before` are
both one comparison inside the single `deliverable()` predicate, which is why adopting
ntfy's `X-At` cost almost nothing. One predicate also means "ready to serve" cannot
drift between the inbox, the queue-depth count and the health endpoint.

## 2026-11-05 — what the centre-id map buys, and the two ways it can lie

`notify()` returns `0` on failure and the notification-centre id on success, and
`cancel(id | id[])` deletes an entry from the centre. Reporting those ids back in
`/v1/seen` puts the relay_id -> centre_id map on the relay, which is the only place it
can live: every alarm wake is a fresh JS context, so a device-side map would need
persistence that this platform does not give us reliably.

That single map unlocks three behaviours that were previously out of reach:

* **Clear on answer** (ntfy's `clear`): an answered reminder is deleted instead of
  sitting there asking for attention it has had.
* **Replace a rendered notification** (ntfy's sequence-ID semantics): the owner can
  `cancel(oldCentreId)` and `notify(new)`, which is what `supersedes` was reaching for.
* **Retraction** for expired items the sender marked `retract`.

Two honesty notes. Cancellation happens on the **next wake**, so up to ~60 s after the
answer — the tap path itself cannot do it, because the tap's action param is built before
`notify()` returns the centre id. And the cancel list is repeated every wake until the
device confirms, because the device->phone direction can also drop frames; assuming the
first delivery worked would strand exactly the clutter this was meant to remove.

Checking `notify()`'s return value closes a quieter bug: a `0` return used to be counted
as a render, so an OS-level drop told the relay "delivered, stop serving" while the wrist
stayed empty. `rendered` now means "the centre accepted it", which is still not "seen" —
only an answer is that.

## 2026-11-05 — replace-on-render verified on hardware (0.6.0)

Two items with the same `key`, posted minutes apart: A rendered with
`centre_id=4294963205`, the correction queued as B with `supersedes=A`, and on the
next wake the device reported `mapped=1 cancelled=1`. A carries
`cancelled_at=16:02:19`, B carries its own centre id, the cancel list is empty and the
fact trail reads `queued A -> rendered A -> queued B -> rendered B`. No tap was needed
because supersede uses the same cancel path as clear-on-answer, which is covered by
contract tests but still unexercised by a real tap.

## 2026-11-05 — dismissed is derived, not reported

The device never decides dismissal itself: it reports the live centre set and the relay
infers. That placement matters because only the relay knows whether a vanished id was
supposed to vanish (answered, superseded, expired-with-retract → `cancelled_at`) or was
simply swiped away unanswered (→ `dismissed_at` + fact). An absent `live` field means
"old build, infer nothing", which is what makes the upgrade safe: 0.6.0 watches cannot
produce false dismissals, they just never produce the fact.

## 2026-11-05 — getAllNotifications() does not work in the App Service

0.7.2 beaconed the raw outcome every wake: `live=null` with an empty error string, on
render wakes and idle wakes alike. `notify()` and `cancel()` work fine in the same
context, so this is a query-API restriction, not a permission problem. Per-wake
dismissal detection is therefore impossible; presence reporting moved to the page,
which is the context the API was designed for. The cost is delay (dismissal lands on
the next app open, not the next wake) and the benefit is no false facts. The `live_seen`
gate stays regardless: it is what kept the always-empty service reports from
fabricating dismissals.

## 2026-11-05 — dismissed removed, and why that is the right call

`getAllNotifications()` throws in the App Service on every wake (0.7.2 beacons:
`live=null`, empty error, render and idle alike), so per-wake presence is impossible.
Page-reported presence would only arrive when the app is opened, and the app is only
opened to arm — so the fact would exist in the contract and almost never in the log.
Removed entirely rather than left dormant: relay inference, page reporter, side
forwarding, tests, schema fields. The failure mode it leaves behind is honest rather
than wrong: a cleared-but-unanswered reminder stays `rendered`, and no fact claims
otherwise.

## 2026-11-05 — reboot survival proven (oneshot + store:true)

Watch rebooted ~17:21 with the app closed. The persistent oneshot alarm fired at
17:22:09, 60 s after the previous wake, with no app open and no missed wake beyond the
normal 61 s cadence, then held 1 poll/minute with no storm. `store:true` survives a
restart and the oneshot chain (cancel-stored then set one delay-60) re-arms across it.

Two things stay open: a persistent REPEAT alarm re-armed every wake is still untested
and must not be armed (the 0.4.23 storm shape), and the phone side restarted in the
same minute (requests reset 10 → 0 at 17:22:09), which a watch reboot should not cause.

## 2026-11-05 — repeat fenced off, oneshot+store is the default

Decision, not a measurement: the repeat+store:true test is not worth its risk (a
persistent REPEAT alarm re-armed every wake is the 0.4.23 storm shape, and with
STORE=true a reboot would not clear it). The oneshot chain already holds 60 s with
reboot survival proven, so repeat buys nothing. Enforcement is in code, not docs:
arming repeat fails loudly, the page button is gone, and the safe default is oneshot
everywhere a caller can omit the mode.

## 2026-11-05 — cadence is a stored setting, not a build

The interval was hardcoded in three places that drifted independently: the page's arm
delay (30 s first wake), the tick's re-arm (60 s), and the side's cache (12 s). Now the
steady cadence lives in `relay_cadence` and only the tick reads it; the first wake
stays 30 s so Arm still proves quickly. The side cache dropped to a fixed 8 s rather
than tracking cadence per-poll — one less wire field, and the cost is a few extra
LAN-side `/v1/inbox?peek=1` calls that change nothing observable. Floor stays 20 s
(`MIN_DELAY_SEC`), because anything faster is a storm with better manners.

## 2026-11-05 — cadence verified: 20 s holds, 13 s queue-to-render

The stored-cadence design works as intended: first wake 30 s (quick proof), every
wake after at the setting, side cache fixed at 8 s so it stays fresher than the
shortest interval. Measured steady-state at 20 s: polls every ~20 s, one item queued
18:16:04 rendered 18:16:17. An item queued mid-rearm took 216 s, which is transition
noise (old alarm replaced mid-flight), not cadence behaviour — always measure on the
settled chain.

## 2026-11-05 — app keys, and the off-by-one that gated them

Gotify-shaped: the operator token administers, each app token owns one tag prefix,
created and revoked from the dashboard with no relay touch. Only subtle bug in the
slice was `"Bearer "` sliced at `[8:]` instead of `[7:]`, which chopped the token's
first character and 401'd every app token while the operator path (exact string
compare) stayed green — the test matrix caught it because it exercises the app path,
not just the operator one.

## 2026-11-05 — container gotchas, both environmental

The `zepp-notify-relay:1.0` image (176 MB, 43 MB content — the slim base, not us) passed
the full matrix first try once past two host issues, both worth writing down because
neither looks like what it is: a `Permission denied` on the token file is SELinux
denying the bind-mount, not a bad path (fix: `:ro,z`), and a secrets file that works
for you at `600` is unreadable to the container's `nobody` user without the relabel.
Real Docker secrets mount `0444` and sidestep both.
