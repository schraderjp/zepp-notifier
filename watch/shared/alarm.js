// Alarm scheduling, shared by the page and the tick service.
//
// No `queryPermission`/`requestPermission` here: those are page-facing APIs and
// do not belong in a background context. Everything is `@zos/alarm` +
// `@zos/storage` + `getPackageInfo`, which both runtimes can use.
//
// MEASURED (0.4.10 device log):
//
//   alarms count=3
//   [38,39,40]
//
// `getAllAlarms()` returns **bare ids**, not records. Every "the alarm does not
// exist" conclusion before 0.4.11 was my filter looking for `entry.file` on a
// number. Two consequences:
//
//   * there is no way to ask the OS which alarms belong to this app, so we keep
//     our own registry of the ids we created and treat that as the truth
//   * dedupe/cancel must go through that registry; matching by file never worked
//
// Also measured: `alarmMgr.get(id)` throws a TypeError for both `get(id)` and
// `get()`, so it is not used anywhere.

import { getPackageInfo } from '@zos/app'
import { localStorage } from '@zos/storage'
import * as alarmMgr from '@zos/alarm'

export const NOTIFIER_SERVICE = 'app-service/notifier'
export const MODE_REPEAT = 'repeat'
export const MODE_ONESHOT = 'oneshot'

const IDS_KEY = 'relay_alarm_ids'
const MAX_IDS = 10

// Steady-state cadence in seconds: how far out each oneshot wake schedules the
// next. 60 s is the battery default; 20-30 s buys latency at 2-3x the wakes.
// Delivery stays wake-quantised either way: nothing arrives faster than this.
const CADENCE_KEY = 'relay_cadence'
const DEFAULT_CADENCE = 60
const MIN_CADENCE = 20
const MAX_CADENCE = 120
export const CADENCE_STEPS = [20, 30, 60]

export function readCadence() {
  try {
    const n = Number(localStorage.getItem(CADENCE_KEY))
    if (!isFinite(n)) return DEFAULT_CADENCE
    return Math.min(MAX_CADENCE, Math.max(MIN_CADENCE, Math.floor(n)))
  } catch (e) {
    return DEFAULT_CADENCE
  }
}

export function writeCadence(sec) {
  try {
    const n = Math.min(MAX_CADENCE, Math.max(MIN_CADENCE, Math.floor(Number(sec))))
    if (!isFinite(n)) return readCadence()
    localStorage.setItem(CADENCE_KEY, String(n))
    return n
  } catch (e) {
    return readCadence()
  }
}

export function cycleCadence() {
  const cur = readCadence()
  const i = CADENCE_STEPS.indexOf(cur)
  const next = CADENCE_STEPS[(i + 1) % CADENCE_STEPS.length] || DEFAULT_CADENCE
  writeCadence(next)
  return next
}

// "repeat_duration" is reminders PER PERIOD (docs, default 1), not a count of
// repeats: 1 = one reminder per one-minute period = every minute.
const REPEAT_DURATION = 1

// REBOOT TEST (0.8.0): STORE=true so alarms survive a restart. The storm that
// forced this to false in 0.4.23 came from arming a persistent REPEAT alarm on every
// wake without consuming the old one. The test runs a ONESHOT chain only (each wake
// cancels the stored id, then sets one delay-60 alarm), so at most one alarm exists
// and a reboot can at most produce one extra wake. Do NOT arm repeat mode on this
// build. The >=3 refusal and the service storm guard (>3 -> cancel all + disarm)
// stay on regardless.
const STORE = true

// A wake may never be scheduled closer than this. `delay: 0` would make a chain
// of immediate re-wakes, which is the same storm by another route.
const MIN_DELAY_SEC = 20

function clampDelay(value) {
  const n = Number(value)
  if (!isFinite(n) || n <= 0) return 30
  return Math.max(MIN_DELAY_SEC, Math.floor(n))
}

// start_time/end_time bound when a repeat alarm is allowed to fire at all
// ("only takes effect during the repeat time period"). A day at a time; the tick
// re-arms on every wake anyway, which extends the window as it goes.
const REPEAT_WINDOW_SEC = 24 * 60 * 60

function appId() {
  try {
    return getPackageInfo().appId
  } catch (e) {
    return 0
  }
}

function idOf(entry) {
  if (typeof entry === 'number') return entry
  if (typeof entry === 'string' && entry && !isNaN(Number(entry))) return Number(entry)
  if (entry && typeof entry === 'object') return entry.id !== undefined ? entry.id : null
  return null
}

// Ids currently pending in the OS. Empty array on any failure: a runtime without
// getAllAlarms() is handled by the registry alone.
export function pendingIds() {
  let list = []
  try {
    list = alarmMgr.getAllAlarms() || []
  } catch (e) {
    return []
  }
  if (!Array.isArray(list)) return []
  const out = []
  for (const entry of list) {
    const id = idOf(entry)
    if (id !== null && id !== undefined) out.push(id)
  }
  return out
}

// --- our own registry -------------------------------------------------------

function readIds() {
  try {
    const raw = localStorage.getItem(IDS_KEY) || '[]'
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list.map(Number).filter((n) => !isNaN(n)) : []
  } catch (e) {
    return []
  }
}

function writeIds(list) {
  try {
    localStorage.setItem(IDS_KEY, JSON.stringify(list.slice(-MAX_IDS)))
  } catch (e) {}
}

export function ourIds() {
  return readIds()
}

export function rememberId(id) {
  if (id === undefined || id === null) return
  const list = readIds()
  const n = Number(id)
  if (isNaN(n)) return
  if (list.indexOf(n) < 0) list.push(n)
  writeIds(list)
}

// Our ids that are still pending - the only "is it armed?" answer available.
export function armedIds() {
  const pending = pendingIds()
  if (!pending.length) return []
  return readIds().filter((id) => pending.indexOf(id) >= 0)
}

function forgetId(id) {
  writeIds(readIds().filter((n) => n !== Number(id)))
}

// Cancel EVERY alarm we created, not just the last one: stale ids from earlier
// JS contexts are invisible to us but still pending in the OS, and they were
// accumulating one per press before this existed.
export function cancelAllTickAlarms() {
  const ids = readIds()
  let cancelled = 0
  for (const id of ids) {
    try {
      alarmMgr.cancel(id)
      cancelled += 1
    } catch (e) {}
  }
  // Sweep: alarms created before the registry existed (0.4.0-0.4.10) are still
  // pending in the OS and invisible to us, and a stuck past-dated alarm is a
  // plausible reason nothing fires. In this spike every pending alarm belongs to
  // this app (measured: the table held exactly the ids we created), and this is
  // user-initiated via Disarm, so sweep them and report how many.
  let swept = 0
  if (!ids.length) {
    for (const id of pendingIds()) {
      try {
        alarmMgr.cancel(id)
        swept += 1
      } catch (e) {}
    }
  }
  writeIds([])
  return { cancelled, swept, found: ids.length, pending: pendingIds() }
}

export function cancelStored() {
  const ids = readIds()
  if (!ids.length) return false
  const last = ids[ids.length - 1]
  try {
    alarmMgr.cancel(last)
  } catch (e) {}
  forgetId(last)
  return true
}

// --- scheduling -------------------------------------------------------------

function onceValue() {
  try {
    return typeof alarmMgr.ONCE === 'number' ? alarmMgr.ONCE : 0
  } catch (e) {
    return 0
  }
}

export function repeatMinuteValue() {
  return repeatTypeInfo().rm
}

// Which numeric value we actually send for `repeat_type`, and whether it came from the
// module constant or from our fallback. This has been the standing suspect since 0.4.5
// ("if that constant is not 1 on this API level, the alarm may be scheduled hourly or
// daily - indistinguishable from never fires inside a two-hour window") and it was never
// observable, because it was only ever logged on the repeat path - the one that fails.
// `src: 'fallback'` means @zos/alarm does not export REPEAT_MINUTE here and every repeat
// alarm we have armed carried a guess.
export function repeatTypeInfo() {
  try {
    const v = alarmMgr.REPEAT_MINUTE
    if (typeof v === 'number') return { rm: v, src: 'const' }
    return { rm: 1, src: 'fallback' }
  } catch (e) {
    return { rm: 1, src: 'error' }
  }
}

function trySet(alarm) {
  try {
    const id = alarmMgr.set(alarm)
    const ok = id !== undefined && id !== null && id !== false
    return ok ? { ok: true, id } : { ok: false, err: 'set() returned ' + String(id) }
  } catch (e) {
    return { ok: false, err: String((e && (e.message || e.reason)) || e) }
  }
}

// `shape` reports which argument form the OS accepted.
//
// MEASURED / FIELD-VERIFIED: the alarm option that actually fires on real
// hardware is the one from SashaCX75's Weather-service, reproduced in
// zepp-health/discussions/393:
//
//   { url: 'app-service/background_service',
//     repeat_type: alarmMgr.REPEAT_MINUTE, repeat_period: 5, repeat_duration: 2,
//     store: STORE, delay: 30 }
//
// No `appid`, no `file`, no `date`. We had been sending `appid` + `file` + `date`
// (the shape from the *notification* sample, which is a different feature): the OS
// accepts that record and returns an id, then never schedules it. That is exactly
// the "id, stored, never fires" state we kept measuring.
export function setTickAlarm(options) {
  const show = !!(options && options.show)
  // REPEAT is fenced off (decision 2026-11-05): a persistent REPEAT alarm re-armed
  // every wake is the 0.4.23 storm shape, and with STORE=true a reboot would not
  // clear it. The oneshot chain gives the same 60 s cadence with at most one alarm
  // in existence. Refuse loudly rather than silently downgrading, so a caller that
  // asks for repeat learns it did not get it.
  if (options && options.mode === MODE_REPEAT) {
    return {
      ok: false,
      reason: 'repeat fenced off: use oneshot (see docs/status.md 0.8.x)',
      mode: MODE_REPEAT,
      show,
      fenced: true,
    }
  }
  const mode = MODE_ONESHOT
  const delaySec = clampDelay(options && options.delaySec)
  const param = 'via=alarm' + (mode === MODE_ONESHOT ? '&mode=oneshot' : '') + (show ? '&show=1' : '')
  const url = NOTIFIER_SERVICE
  const nowSec = Math.floor(Date.now() / 1000)
  const windowEnd = nowSec + REPEAT_WINDOW_SEC

  // The docs (device-app-api/newAPI/alarm/set) settle the field names:
  //   url        required, "file path to wake up Mini Program, supporting App Service"
  //   time       UTC seconds, higher priority than delay; one of time/delay required
  //   delay      seconds from now; one of time/delay required
  //   repeat_period / repeat_duration
  //              "a period of the current repeat_type, containing repeat_period
  //              times, repeat_duration times before the reminder" - i.e.
  //              repeat_duration is reminders PER PERIOD (default 1), so 1440
  //              asks for 1440 reminders inside a one-minute period, which the OS
  //              drops silently. That is the 1440 measurement explained.
  //   start_time / end_time
  //              "the repeat reminder only takes effect during the repeat time
  //              period" - never set by us, which is why a repeat alarm fired
  //              once from `delay` and then never again.
  // HARD LIMIT: one reminder per period, always.
  //
  // `repeat_duration` means "reminders inside one period", and with
  // REPEAT_MINUTE that makes 1440 a *legal* request for 1440 wakes per minute.
  // The OS will not reject it, and it is the shape that wedged a watch badly
  // enough to need a factory reset (each wake writes flash via devlog). Nothing
  // here may express more than one wake per period, so a future edit cannot
  // reintroduce that class of storm by changing a constant.
  const repeat = {
    repeat_type: repeatMinuteValue(),
    repeat_period: 1,
    repeat_duration: 1,
    start_time: nowSec,
    end_time: windowEnd,
  }

  const attempts =
    mode === MODE_REPEAT
      ? [
          // Everything the docs describe, in one option: delay for the first
          // fire, one reminder per one-minute period, explicit repeat window.
          ['url+window', Object.assign({ url, param, store: STORE, delay: delaySec }, repeat)],
          // `time` instead of `delay`, since time has priority and some builds
          // only honour it.
          ['url+time+window', Object.assign({ url, param, store: STORE, time: nowSec + delaySec }, repeat)],
          // Window but no store, in case persistence is what is rejected.
          ['url+window-nostore', Object.assign({ url, param, delay: delaySec }, repeat)],
          // The shape that reliably fired once: no window.
          ['url', { url, param, repeat_type: repeatMinuteValue(), repeat_period: 1, repeat_duration: 1, store: STORE, delay: delaySec }],
          // Bare minimum, no param: fires but the tick cannot tell it was woken.
          ['url-noparam', { url, store: STORE, delay: delaySec }],
        ]
      : [
          ['url-delay', { url, param, store: STORE, delay: delaySec }],
          ['url-time', { url, param, store: STORE, time: nowSec + delaySec }],
          ['url-delay-noparam', { url, store: STORE, delay: delaySec }],
        ]

  const errs = []
  for (const [shape, alarm] of attempts) {
    const result = trySet(alarm)
    if (result.ok) {
      rememberId(result.id)
      const pending = pendingIds()
      return {
        ok: true,
        id: result.id,
        shape,
        mode,
        show,
        date: nowSec + delaySec,
        pending: pending.indexOf(Number(result.id)) >= 0,
        total: pending.length,
        errs,
      }
    }
    errs.push(shape + ':' + result.err)
  }
  return { ok: false, reason: errs.join(' | ').slice(0, 120), errs, mode, show, date: nowSec + delaySec }
}

// FORCE a fresh alarm: cancel everything we own, then set exactly one.
//
// 0.4.17 deduped here and that was a trap: a *pending but spent* alarm (fired
// once with repeat_duration 1) still counts as "already armed", so pressing Arm
// again armed nothing and the watch stayed silent. Dedupe is only correct for
// the automatic path (app launch); a user pressing Arm means "make it work now".
export function forceTickAlarm(options) {
  cancelAllTickAlarms()
  const result = setTickAlarm(options)
  result.count = result.ok ? 1 : 0
  result.forced = true
  return result
}

// Repeat mode: idempotent, based on our registry intersected with what the OS
// still lists. Oneshot: nothing to dedupe against - a fired ONCE alarm is
// consumed - so the chain cancels its own previous id.
export function ensureTickAlarm(options) {
  if ((options && options.mode) !== MODE_ONESHOT) {
    return {
      ok: false,
      reason: 'repeat fenced off: use oneshot (see docs/status.md 0.8.x)',
      mode: MODE_REPEAT,
      fenced: true,
    }
  }
  const mode = MODE_ONESHOT
  if (false) {
    const live = armedIds()
    if (live.length) {
      return { ok: true, already: true, count: live.length, id: live[0], mode, dedupe: 'registry' }
    }
    // The registry is per-context storage, so the PAGE always sees it empty even
    // when the service has armed alarms. Treat the OS list as truth: sweep and
    // set one, instead of adding another on every app launch.
    if (pendingIds().length) cancelAllTickAlarms()
  } else {
    cancelStored()
  }
  const result = setTickAlarm(options)
  result.count = result.ok ? 1 : 0
  result.dedupe = 'registry'
  return result
}

// The tick's own re-arm, called at the top of every wake.
//
// It cancels every alarm we created and then arms exactly one, so the cadence
// does not depend on repeat semantics at all: whether the OS honours
// repeat_period or treats the alarm as one-shot, the next wake is always
// scheduled 60 s out and there is never more than one alarm registered. That
// also makes the chain self-healing after a reboot, a missed wake or a reinstall.
export function armNext(show, delaySec) {
  // Fenced off with repeat mode (decision 2026-11-05). The oneshot chain uses
  // armNextOneshot; this is kept so a stale caller fails loudly, not silently.
  return {
    ok: false,
    skipped: 'repeat fenced off',
    id: -1,
    shape: 'fenced',
    pending: pendingIds(),
  };
  // Refuse to stack beyond 3. Refusing at >0 would break the chain: the alarm
  // being fired is often still listed as pending during its own wake, so "one is
  // pending" is the normal, healthy state. Growth is bounded instead by the
  // storm guard in the service (>3 -> cancel all + disarm), which also fires if
  // the OS stops consuming alarms.
  const pending = pendingIds()
  if (pending.length >= 3) {
    return { ok: false, skipped: 'too many pending', id: -1, shape: 'skipped', pending }
  }
  // Deliberately does NOT cancel anything first.
  //
  // 0.4.18/0.4.19 cancelled every alarm we owned at the top of a wake - which
  // includes the alarm that is *currently firing*. A cancelled alarm mid-fire is a
  // good way to wedge the scheduler, and it is the one difference between this
  // chain and 0.1.4's (which only ever cancelled the previous id, from inside a
  // service, and fired repeatedly for hours).
  //
  // Each wake arms exactly one new alarm; the one it woke from is consumed by the
  // OS (repeat_duration 1), so the table does not grow in normal operation.
  return setTickAlarm({ mode: MODE_REPEAT, show, delaySec: delaySec || 60 })
}

// Kept for callers that want a single explicit wake.
export function armNextOneshot(show, delaySec) {
  cancelStored()
  // Steady-state cadence, not the 30 s first-wake proof delay: the tick re-arms
  // itself this far out on every wake.
  return setTickAlarm({ mode: MODE_ONESHOT, show, delaySec: delaySec || readCadence() })
}

// --- carrying data across wakes ---------------------------------------------
//
// An alarm is the ONLY durable store on this device. Storage is per-context (measured:
// "localStorage caches per JS context (service lines lost on service death)", and
// "page and service localStorage are separate stores" - docs/findings.md), and a
// single-execution wake is capped at 600 ms, so a write made by a wake that then dies is
// not visible to the next one. Alarm records are OS state: they survive the context, and
// with store:true a reboot, and their `param` is delivered to the wake they produce.
//
// So anything that must be *carried* - today a button press whose ack could not be
// delivered - travels as an alarm param and is re-armed by the wake that receives it.
// Shape is the measured one (`url` + `delay`, the shape the OS actually honours).
export function setCarryAlarm(param, delaySec) {
  const result = trySet({
    url: NOTIFIER_SERVICE,
    param: String(param || '').slice(0, 160),
    store: STORE,
    delay: clampDelay(delaySec),
  })
  if (result.ok) rememberId(result.id)
  return result
}

// Cancel one alarm we set, by the id setCarryAlarm() returned. Used to stop a retry
// chain the moment its work is confirmed; failure is harmless (a duplicate wake re-sends
// an ack the relay and the phone both collapse).
export function cancelAlarm(id) {
  const n = Number(id)
  if (isNaN(n)) return false
  try {
    alarmMgr.cancel(n)
  } catch (e) {
    return false
  }
  forgetId(n)
  return true
}

// --- the fence ---------------------------------------------------------------
//
// A SECOND, independent oneshot chain, five minutes out, whose only job is to keep waking
// the service when the main chain's next alarm was never delivered.
//
// It is deliberately NOT a repeating alarm. 0.9.7 shipped one (`repeat_period: 10`,
// `store: true`) and measured it on 2026-11-10: the record was accepted, `getAllAlarms()`
// listed it as pending for 32 minutes, and it never fired once - `tick.fence` stayed at
// zero while the main chain woke every 60 s. That matches what this file already knew about
// repeat shapes ("the shape that reliably fired once: no window", "a repeat alarm fired once
// from delay and then never again"): on this firmware a repeat record is a pending entry
// that is never delivered. So the fence uses the shape with 1440 deliveries a day behind it:
// a plain oneshot, equipped with its own self-re-arming chain.
//
// It does not try to revive the main chain. That would need to know whether a chain alarm is
// still pending, and `getAllAlarms()` returns bare ids: with the fence itself always present
// the count cannot distinguish "main chain alive" from "this is my own record", and guessing
// wrong ADDS a permanent alarm every fence period (N pending alarms produce N wakes a minute,
// each arming one more). So the fence only ever re-arms itself: it degrades delivery to a
// 5-minute cadence instead of stopping it, and a `tick.fence` with no `tick.wake` beside it
// is the measurement that says the main chain died while delivery still works.
export const FENCE_PERIOD_SEC = 300

export function setFenceAlarm(delaySec) {
  const delay = clampDelay(Number(delaySec) || FENCE_PERIOD_SEC)
  const result = trySet({
    url: NOTIFIER_SERVICE,
    param: 'via=alarm&mode=oneshot&fence=1',
    store: STORE,
    delay: delay,
  })
  if (result.ok) rememberId(result.id)
  result.delaySec = delay
  return result
}

// --- the REPEAT fence (measured against a working reference) -------------------
//
// SashaCX75/Weather-service is the only repeat-alarm example known to work, and it does
// three things our 0.9.7 attempt did not:
//
//   1. its first fire is anchored to a period boundary - `delay = 15 + secsToNextMinute +
//      minutesToNext10 * 60`, i.e. it lands on xx:x0:15. Ours was a flat `delay: 600` from
//      whenever the user pressed Arm, so it landed at an arbitrary offset. The docs' own
//      repeat examples pass `time` (absolute UTC seconds) and never a bare arbitrary delay.
//   2. it passes the module constant straight through (`alarmMgr.REPEAT_MINUTE`). We route it
//      through `repeatMinuteValue()`, whose fallback of 1 is only correct if that constant
//      really is 1 on this firmware - which is why `rm` is now in the telemetry.
//   3. the docs' repeat semantics are offset by one: "one repeat period ... containing
//      repeat_period times", and their example "reminder every 21 days" uses
//      repeat_period: 20. So `repeat_period: 10` means an 11-minute interval, not 10.
//
// 0.9.9 arms this ALONGSIDE the oneshot fence rather than replacing it. If the repeat record
// fires, `tick.fence{kind:"repeat"}` says so and the oneshot fence can be retired; if it
// stays silent like last time, nothing regresses.
export const REPEAT_FENCE_PERIOD_MIN = 10

export function setRepeatFence(periodMin) {
  const period = Math.max(2, Math.min(30, Math.floor(Number(periodMin) || REPEAT_FENCE_PERIOD_MIN)))
  // Boundary anchor, the Weather-service formula: next whole minute, then the next
  // `period`-minute boundary, plus 15 s so the fire is never scheduled in the past.
  const nowSec = Math.floor(Date.now() / 1000)
  const secToMinute = 60 - (nowSec % 60)
  const minuteOfHour = Math.floor((nowSec % 3600) / 60)
  let minutesToBoundary = period - (minuteOfHour % period) - 1
  if (minutesToBoundary < 0) minutesToBoundary += period
  const fireAt = nowSec + 15 + secToMinute + minutesToBoundary * 60
  const rm = repeatMinuteValue()
  const result = trySet({
    url: NOTIFIER_SERVICE,
    param: 'via=alarm&mode=oneshot&rfence=1',
    store: STORE,
    time: fireAt,
    repeat_type: rm,
    repeat_period: period,
    repeat_duration: 1,
  })
  if (result.ok) rememberId(result.id)
  result.fireAt = fireAt
  result.rm = rm
  result.period = period
  result.pendingNow = result.ok ? pendingIds().indexOf(Number(result.id)) >= 0 : false
  return result
}

// --- the heartbeat experiment --------------------------------------------------
//
// Nieole/water-reminders is a maintained app (Zepp OS 6, min API level 4.0, same as us) whose
// entire architecture is a single repeating "heartbeat" alarm, and its docs record a real-device
// measurement (T-Rex 3, 2026-08-07) of the exact shape we concluded was impossible:
//
//   set({ url: 'app-service/tick', delay: 600, repeat_type: REPEAT_MINUTE,
//         repeat_period: 10, store: true })          // registered once, never re-set
//
//   * first hop after registration: exactly 60 s   * repeat_period == minutes per period
//   * survives reboot with store: true             * single execution 46-111 ms of the 600 budget
//   * param arrives in onInit(params)              * getAllAlarms() -> [id]
//
// The decisive detail: their record passes **no `repeat_duration`**, which is the one field our
// silent 0.9.7/0.9.9 records always sent (docs list it as optional, default 1 - "reminders per
// period"). Everything else we tried matches theirs.
//
// So the sweep is three records, isolating exactly that:
//   hb1  their record verbatim:  delay 60,  period 1,  no repeat_duration
//   hb2  same, plus repeat_duration: 1            <- the only difference, the suspect
//   hb3  their production grid: delay 600, period 10, no repeat_duration
export const HEARTBEAT_VARIANTS = [
  { tag: 'hb1', delay: 60, period: 1 },
  { tag: 'hb2', delay: 60, period: 2, duration: 1 },
  { tag: 'hb3', delay: 600, period: 10 },
]

export function setHeartbeat(variant) {
  const v = variant || {}
  const period = Math.max(1, Math.min(30, Math.floor(Number(v.period) || 10)))
  const alarm = {
    url: NOTIFIER_SERVICE,
    param: 'via=alarm&mode=oneshot&hb=' + String(v.tag || '?'),
    delay: clampDelay(Number(v.delay) || period * 60),
    repeat_type: repeatMinuteValue(),
    repeat_period: period,
    store: STORE,
  }
  // hb2 is the control for the one field we have always sent and they never do.
  if (v.duration) alarm.repeat_duration = v.duration
  const result = trySet(alarm)
  if (result.ok) rememberId(result.id)
  result.tag = String(v.tag || '?')
  result.period = period
  result.duration = v.duration || 0
  return result
}

// End of the experiment: cancel everything and let the caller restore the working pair, so a
// silent heartbeat leaves nothing armed.
export function setHeartbeatEnd(delaySec) {
  const result = trySet({
    url: NOTIFIER_SERVICE,
    param: 'via=alarm&mode=oneshot&hbe=1',
    store: STORE,
    delay: clampDelay(Number(delaySec) || 3900),
  })
  if (result.ok) rememberId(result.id)
  return result
}

export function cancelFence() {
  // Ids are opaque, so "cancel the fence" means cancel everything we own - the same sweep
  // Disarm performs. Callers use it only when the whole chain is being torn down.
  return cancelAllTickAlarms()
}

// --- diagnostics ------------------------------------------------------------

export function alarmDump() {
  const pending = pendingIds()
  let json = ''
  try {
    json = JSON.stringify(pending)
  } catch (e) {
    json = 'unstringable'
  }
  return { count: pending.length, json, ours: readIds() }
}

export function alarmSummary() {
  return {
    count: armedIds().length,
    pending: pendingIds(),
    ours: readIds(),
  }
}

export function alarmDiag() {
  const has = (name) => {
    try {
      return typeof alarmMgr[name] === 'function' ? 'fn' : 'no'
    } catch (e) {
      return 'err'
    }
  }
  return {
    set: has('set'),
    list: has('getAllAlarms'),
    cancel: has('cancel'),
    once: onceValue(),
    rm: repeatMinuteValue(),
    pending: pendingIds(),
    ours: readIds(),
  }
}
