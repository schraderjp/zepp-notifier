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
    // `0` IS A FAILURE. The API documents "returns 0 on failure", and the old test
    // (`id !== undefined && id !== null && id !== false`) accepted 0 because 0 is none of those.
    // A caller then holds `{ok: true, id: 0}` and, on the tap success path, hands 0 to
    // cancelAlarm - measured 2026-11-10: every tap that reached that path took the heartbeat
    // record with it. A failed arm must be visible as a failure, never as id 0.
    const n = Number(id)
    const ok = !isNaN(n) && n > 0
    return ok ? { ok: true, id: n } : { ok: false, err: 'set() returned ' + String(id) }
  } catch (e) {
    return { ok: false, err: String((e && (e.message || e.reason)) || e) }
  }
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
  // Never cancel on a value that is not a real alarm id. 0 is set()'s documented failure code,
  // and cancel(0) on this platform reaches past the record the caller meant to cancel.
  if (isNaN(n) || n <= 0) return false
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
// --- the heartbeat -------------------------------------------------------------
//
// MEASURED on this watch, 2026-11-10 (0.9.12): `repeat_period: 1` fires every 60 s, twelve
// times in a row with no misses; `repeat_period: 2` every 120 s; `repeat_period: 10` with
// `delay: 600` fired with its first hop at exactly 600 s; and `alarmMgr.REPEAT_MINUTE` reads
// **1** (reported as `rm: 1, rmSrc: "const"`). Every earlier "repeat alarms never fire here"
// conclusion was an artifact of arming order and of judging inside one period.
//
// So the schedule is ONE of these, armed once by the page and never re-set. It replaces the
// oneshot chain, whose fatal property is that the next wake exists only if this wake re-armed
// it - the failure that cost 5.2 h of silence, and the reason a 24/7 reference app rejects
// chained scheduling in writing.
export function setHeartbeatAlarm(delaySec, show) {
  const period = 1
  const result = trySet({
    url: NOTIFIER_SERVICE,
    // `show=1` makes every wake raise a proof-of-execution notification; it rides in the
    // param because a repeating record cannot be re-armoured per wake.
    param: 'via=alarm&mode=oneshot&hb=1' + (show ? '&show=1' : ''),
    delay: clampDelay(Number(delaySec) || period * 60),
    repeat_type: repeatMinuteValue(),
    repeat_period: period,
    store: STORE,
  })
  if (result.ok) rememberId(result.id)
  result.period = period
  return result
}

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
