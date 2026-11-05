# Spike plan: does the transport actually survive?

The goal of this repo state is **not** a notification product. It is one
experiment that answers a question no documentation answers:

> Once the user closes the mini app, how long does the Side Service keep polling,
> and does the continuous App Service keep its BLE link alive?

Everything else (history, snooze, mute, multiple senders) is cheap to add once
this is answered.

## The two candidates

| | A: phone-side poll + BLE push (built here) | B: watch-side alarm poll (fallback) |
|---|---|---|
| Polling loop | Side Service on the phone | `@zos/alarm` + `store:true` waking the watch |
| Battery | phone radio, watch mostly idle | watch radio wakes every N minutes |
| Granularity | ~5-30 s | ~1 min, coarse |
| Depends on | Zepp app staying alive on the phone | OS honoring alarms; 600 ms budget per wake |
| Works if phone app is killed | no | yes-ish |

A is implemented. B only becomes necessary if A fails the acceptance criteria
below.

## Hypotheses to falsify

1. `notify()` with 2-3 custom actions renders and the buttons are tappable.
2. A **continuous** App Service survives the user closing the app, the watch
   screen turning off, and a watch reboot (`reload: true`).
3. The Side Service keeps a poll loop running after the watch app is closed, and
   after the Zepp app is backgrounded / swiped away.
4. A button tap in a **single-execution** service completes BLE handshake + one
   packet within the 600 ms budget.
5. Phone -> watch pushes still arrive while the watch is in DND / screen off.

## Evidence collected

Every hop posts to `POST /v1/log`, so `server/log/events.jsonl` (and the
dashboard at `http://<host>:8099/`) is a timestamped trace:

| event | emitted by | proves |
|---|---|---|
| `side.online` / `side.destroy` | Side Service | its real lifetime |
| `poll.error` | Side Service | network blips / dead loops |
| `poll.unconfigured` | Side Service | it is running without config |
| `pong` | App Service | the watch is still listening (sent per poll) |
| `ping.unanswered` | Side Service | the previous poll's ping got no reply |
| `notify.shown` + `actionCount` | App Service | push delivered, buttons accepted |
| `ack.received` + `transit_ms` | server | tap -> server latency, incl. outbox replays |
| `watch.silent` | Side Service | nothing heard from the watch for 10 minutes |
| `http.bad_json` / `http.empty_body` | server | the sender's request was malformed (shell ate the quotes) |
| `service.online` / `service.offline` | App Service | restarts, reboots, evictions |

`transit_ms` is computed from the watch clock, so it is only meaningful as a
rough delta (watch and phone clocks are not synchronised).

## Findings so far (hardware, Active 2 Square, API 4.2)

1. **Button taps are reliable**: 22/22 taps reached the server through a
   single-execution action service. The 600 ms budget was not the bottleneck.
2. **Only one App Service instance can run.** A tap that starts a *second*
   service evicts the continuous one, and the watch silently stops receiving
   pushes (`push.sent` with no `notify.shown`, no more `pong`). Buttons must
   therefore target the running service itself (`file: "app-service/notifier"`)
   and be handled in `onEvent()`, which is what Zepp's notification sample does.
   Confirmed working: `action.handled` is logged and pongs continue after a tap.
3. `notify()` accepts `actions: []` (a notification with no buttons) and still
   renders; the spike now logs `notify.shown` for those too.
4. **The inbox cursor must be a timestamp, not a sequence number.** With `seq`
   cursors, restarting the relay rewound the server's counter below the value
   the phone had stored, and every new notification silently looked
   "already delivered". Cursors are now opaque `created_at` values, and the queue
   is persisted to `server/log/state.json`, so restarts are non-events.

5. **The Side Service's poll timer drifts badly.** A 15 s interval actually fires
   every **40–52 s** on a dozing phone, so an interval is a floor, not a schedule.
   Consequence: any "no pong for N intervals" heuristic fires every cycle and is
   useless. The watchdog now measures per poll instead (`ping.unanswered` for a
   missed round trip, `watch.silent` only after 10 minutes of complete silence),
   and every event carries `gap_ms` so real cadence can be read off the trace:

   ```sh
   jq -r 'select(.event=="pong") | .gap_ms' server/log/events.jsonl | sort -n | tail -5
   ```

   Practical effect on the design: cadence reaches the configured interval when
   the phone is awake (measured 15.3 s steady for minutes at a time), so this is
   doze throttling, not a fixed penalty. Expect ~15 s awake, 20–60 s idle.

6. **No lifetime limit has been observed yet.** The longest clean run is 43 min
   (10:21–11:04), and it ended because the *host* shut down nine seconds after
   the last pong, not because the phone stopped polling. An earlier note claimed
   the poller died of doze after ~40 min; that was a misread of overlapping boots
   plus a backwards clock jump in `last`. Withdrawn.

7. **`reload: true` does not survive a watch reboot — FIXED and verified.** Measured
   originally: `service.offline` at reboot, then six consecutive `ping.unanswered`
   while the phone kept polling, and the only `service.online` afterwards came from
   a manual Arm press. With the 0.1.4+ watchdog the device log shows repeated
   `alarm.wake onInit` **and** `alarm.wake onEvent` after a reboot, i.e. the
   persistent alarm fires, revives the service when it is gone (`ensureContinuous`)
   and is delivered as an event when it is alive. Both paths work.

9. **The device log is only durable within one screen-on session.** `localStorage`
   caches per JS context, so App Service lines are lost when the OS kills the
   service on sleep, and `@zos/fs` writes are only permitted while the screen is
   off / AOD. Read it in the same session, or not at all.

10. **The BLE channel dies while both sides stay alive.** Reproduced after every
    side-service relaunch: pongs flow for polls 1-4 (~2 min), then nothing, while
    the phone keeps polling and the watch service keeps waking on alarms and
    handling `onEvent`. So this is a channel failure, not a service death. The
    next experiment splits one-way vs two-way breakage (tap a local test
    notification while the link looks dead) and tests whether phone screen-off /
    backgrounding is the trigger.
8. **A second Side Service instance can start on top of the first.** Launching
   the mini app spawned a new poller while the old one kept running and polling;
   the stale one is deaf to device messages, so it logged `ping.unanswered` every
   cycle and doubled BLE chatter. Fixed with a leader lock in settings storage
   (newest instance claims it, older ones step down on their next poll).

## Self-healing after reboot (0.1.4)

Only the watch can wake itself, so recovery depends on `@zos/alarm` with
`store: true`. Design:

- the alarm targets **this same file** (`app-service/notifier`) with `param:
  via=alarm`; a second service file would evict the running one (finding 2)
- the next alarm is armed **before** anything else in `onInit`, so a 600 ms
  single-execution wake can be killed at any point without breaking the chain
- arming cancels the previous alarm id (kept in device `localStorage`), so only
  one is ever pending; `delay` is in **seconds**, default 900 (15 min)
- if woken by the alarm, `ensureContinuous()` calls `start()` on itself: a no-op
  if a continuous instance already exists, the actual recovery if it does not
- the page's **Stop** disarms (`relay_armed=0` in localStorage) *and* cancels the
  alarm, so the watchdog cannot resurrect a service the user turned off
- `onDestroy` deliberately does **not** cancel the alarm

What the trace must show after a watch reboot with the app closed:

| event | meaning |
|---|---|
| `service.online  via:"alarm"` | the alarm brought the listener back |
| `watchdog.awake  path:"event"` | alarm delivered to a live instance (cheap path) |
| `watchdog.restart {ok:true}` | a continuous instance had to be started |
| `watchdog.restart {ok:false}` | one was already running (expected on the cheap path) |
| `watchdog.arm_failed` / `storage` errors | alarm or localStorage unavailable in this runtime |

Churn to watch for: `service.offline`/`online` pairs at exactly the watchdog
interval would mean every alarm tick restarts the service instead of being
handled as an event.

11. **SUSPECT: an alarm targeting the running service destroys it.** Measured with
    no user interaction and the phone awake/foregrounded: `watchdog.awake` at
    15:52:17 (out of schedule, from a leftover alarm), then `service.offline` at
    15:52:47 - a graceful stop 30 s later, with no `service.online` afterwards for
    hours. Hypothesis: the OS treats an alarm-fired invocation as single-execution
    and tears down the continuous instance after delivering `onEvent`, and
    `ensureContinuous()` cannot revive it from inside a 600 ms context.

    If confirmed this inverts finding 7: the watchdog that was added for reboot
    recovery *causes* the deaths we attributed to the BLE channel. Confirmation
    test: uninstall (clears the alarm pile), reinstall, arm exactly once, hands
    off, and check whether the single 15-min wake is followed by
    `service.offline`.

    Consequence if confirmed: drop the watchdog, keep the continuous service, and
    document "open the app once after a watch reboot" as a known limitation. The
    alarm stays useful only as a *scheduler* that does not target the live
    service.

## Reading a run

```sh
python3 server/summarize.py             # sessions, gap percentiles, delivery latency
python3 server/summarize.py --since 12:00
```

Gaps longer than 5 minutes split the trace into sessions, so a suspended phone, a
killed poller and a relay restart each show up as their own block.

## Test matrix

Run each row for at least 30 minutes with a poll interval of 30 s, sending one
notification every ~10 minutes.

| # | State | What to check |
|---|---|---|
| 1 | Watch app open, screen on | baseline: `notify.shown`, tap -> `ack.received` |
| 2 | Watch app closed, screen off | `pong` keeps arriving; pushes still render |
| 3 | Zepp app backgrounded on the phone | `side.destroy`? `poll.error`? |
| 4 | Zepp app swiped away from recents | does it come back on its own? |
| 5 | Watch rebooted | `service.online` without opening the app |
| 6 | Phone rebooted | same, plus cursor preserved |
| 7 | Bluetooth off for 5 min, then on | outbox replay (`ack.replayed`) |
| 8 | Watch in DND / bedtime mode | notification visible or silently swallowed? |
| 9 | Tap a button 20x with the phone in another room | how many `ack.received` of 20 |
| 10 | 48 h unattended | first gap in `pong`, first unexplained `side.destroy` |

## Pass criteria for A

- `pong` gaps never exceed 2x the poll interval during waking hours for 24 h.
- >= 19 of 20 button taps arrive (one loss is tolerable if the outbox recovers it).
- No unexplained `side.destroy` while the Zepp app is alive in recents.
- After a watch reboot, `service.online` appears without opening the app.

If A fails on lifetime but the tap path works, build B and keep A's renderer.
If taps themselves are lossy, the fallback is to have the action service write to
`@zos/fs` first (only allowed while the screen is off, so verify) and let the
next poll drain it.

## Deliberately not implemented (yet)

- at-least-once push: the phone advances its cursor when the server hands over
  items, so a dropped push is *not* re-delivered. Acks are the reliable direction.
- snooze (needs a server-side re-delivery queue)
- dedupe / collapse_key
- cancelling the notification-center entry on ack (needs the id `notify()`
  returns, which the notifier keeps only in memory)
- config validation, TLS pinning, per-sender scoping
