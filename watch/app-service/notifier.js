// Tick service (0.4.0): ONE unit of work per wake, then exit.
//
// This file replaces the continuous App Service of 0.2.x-0.3.x. The continuous
// design was measured to be unsalvageable on this hardware: after the mini app
// leaves the foreground the device<->side BLE session is suspended in BOTH
// directions, silently, with `ble.send` still returning success and no error on
// either side (docs/findings.md). A fresh JS context works; a long-lived one
// goes deaf. So the transport is used the way a fresh context uses it:
//
//   alarm (store:true, every minute) -> onInit/onEvent -> connect -> ONE
//   device-initiated Request -> render / ack -> exit()
//
// Why a Request and not the old fire-and-forget push: the side cannot reach the
// device unless the device opened the exchange (zml#3, and every measurement in
// findings.md). A Request is answered by the side's `onRequest`, so one wake =
// one round trip, and the response is the natural point to exit: it proves the
// side received us.
//
// No timers exist in an App Service, so nothing here schedules anything, and
// `MessageBuilder.request()` is NOT used - it wraps the call in a setTimeout
// race, which throws in this runtime. `requestOnce()` below does the same job
// with no timer: send, resolve on the matching response, otherwise let the OS
// reap the tick.
//
// E1 proved the transport (alarm -> one wake -> one Request -> one answer, 8
// consecutive 60 s cycles). This build is E2: the answer carries notifications,
// which are rendered here, and a button tap acks on its own wake. A press is durable
// because the next attempt is carried in an alarm set before the link is touched (see
// the durability section and tap()).

import {
  MessageBuilder,
  MessagePayloadType,
  MessagePayloadDataTypeOp,
  genTraceId,
} from '../shared/message'
import * as ble from '@zos/ble'
// T4ASICK / zepp-health#393: a service that sends while Bluetooth is down goes
// dark until the Zepp app is restarted, so check before doing any BLE work.
// Namespace-free named import: `connectStatus` is a documented @zos/ble export.
import { connectStatus } from '@zos/ble'
import { getPackageInfo } from '@zos/app'
import { cancel, notify } from '@zos/notification'
import { localStorage } from '@zos/storage'
import { log } from '@zos/utils'
import { MSG, decodeActionParam, encodeActionParam, normalizeNotification } from '../shared/protocol'
import {
  pendingIds,
  cancelAllTickAlarms,
  setHeartbeatAlarm,
  setCarryAlarm,
  cancelAlarm,
} from '../shared/alarm'
// `@zos/app-service` IS available inside an App Service (documented: the module is
// supported, only UI/timers/high-power sensors are not), and `exit()` is how a
// single-execution service releases its slot. 0.4.5-0.4.11 concluded the import was a
// load-time failure; the likelier reading is that the *named* `{ exit }` binding was not a
// valid export and took the bundle down. A namespace import plus a typeof guard cannot fail
// that way, which is the form the maintainer of a 24/7 app uses.
import * as appService from '@zos/app-service'
import { append as devLog } from '../shared/devlog'

const logger = log.getLogger('relay.tick')

const SERVICE_FILE = 'app-service/notifier'
const ARMED_KEY = 'relay_armed'
const BUZZ = 5

// --- durability -------------------------------------------------------------
//
// A wake is a fresh JS context, and on this device storage does NOT cross contexts
// (docs/findings.md: "localStorage caches per JS context (service lines lost on service
// death)", "page and service localStorage are separate stores"). A 0.9.3 attempt to keep
// a queued ack in localStorage therefore looked correct and did nothing: measured, a tap
// that died before the handshake wrote its ack and no later wake ever saw it.
//
// The only durable store is an ALARM: OS state, delivered as a param to the wake it
// produces, and reboot-proof with store:true. So a press that has not been answered is
// carried by one, see tap(). Telemetry is not persisted at all - a line queued by a wake
// that dies is gone, which is why every failure path also has a devLog line on the
// watch. The in-memory buffer below only makes one wake's facts travel in order.
const logs = []
const MAX_LOGS = 24

// A press is retried until the phone answers it. 90 s for the first attempts (a
// handshake that fails once usually works on the next wake), then 5 min: the case that
// matters is "Bluetooth is off for a while", where 40 attempts still cover ~3 h without
// spending a wake a minute.
const RETRY_MARK = 'retry=1'
// 40 was chosen when a missed tap cost the answer itself. Since the ack is recorded by the
// relay on the first frame (measured: `ack.received appended: false` on every retry), a long
// ladder buys nothing and costs a carrier alarm plus a wake every 5 min for three hours - and
// when the side's reply is lost those retries all fire for a press that was answered instantly.
// 12 attempts is ~37 min: long enough to outlast a doze or a dropped link, short enough to stop.
const RETRY_MAX = 12
const RETRY_FIRST_SEC = 90
const RETRY_LATER_SEC = 300
// 'probe' = E1, transport only. 'poll' = E2, fetch + render.
const TICK_KIND = 'poll'

let mb = null
let finished = false
// True when this context was started by a NOTIFICATION ACTION (onEvent) rather than an alarm
// (onInit). The distinction turned out to matter: see quit().
let fromAction = false

// --- lifecycle helpers ------------------------------------------------------

function isArmed() {
  try {
    return localStorage.getItem(ARMED_KEY) !== '0'
  } catch (e) {
    return true
  }
}

// These three were deleted by accident in 0.4.12: a `find`/slice between two
// section markers took the marker-delimited alarm block AND everything sitting
// between it and the next marker. Rollup does not fail on undefined identifiers,
// so 0.4.12-0.4.22 shipped with them missing and every wake died on a
// ReferenceError *after* the chain had already been armed - which is why alarms
// kept firing, the watch stayed silent and the server saw nothing at all.
function bleStatus() {
  try {
    return typeof ble.getStatus === 'function' ? String(ble.getStatus()) : 'noapi'
  } catch (e) {
    return 'err'
  }
}

function apiLevel() {
  try {
    return typeof __API_LEVEL__ !== 'undefined' ? String(__API_LEVEL__) : '?'
  } catch (e) {
    return '?'
  }
}

// Writes the disarmed flag into THIS context's storage. Combined with the storm
// guard below, a misbehaving build switches itself off instead of thrashing.
function selfDisarm() {
  try {
    localStorage.setItem(ARMED_KEY, '0')
  } catch (e) {}
}

function quit(reason) {
  if (finished) return
  finished = true
  try {
    devLog('tick exit: ' + reason)
  } catch (e) {}
  mb = null
  // EVERY exit point goes through here, and a single-execution service must release its slot
  // explicitly - docs: "single execution means exiting the App Service as soon as the
  // execution of the relevant code is completed"; field advice from the maintainer of a 24/7
  // alarm app: call exit() at every exit point, including inside catch.
  //
  // Why this is the leading explanation for the hours-long silences: this file is the one
  // background service slot the platform allows. A wake that returns without exiting can
  // leave the slot held with work still pending (a shake promise that never settles, a
  // listener still registered), and then alarms keep firing into a service that cannot be
  // started - which matches exactly what the relay measured: no tick.wake for 5.2 h, chainId
  // barely advancing (the alarms fired, the code never ran), and an app open clearing it.
  //
  // Guarded and namespace-imported on purpose: an absent member must not take the file down.
  //
  // NOT from a notification action, though. MEASURED 2026-11-10 three times, and pinned down by
  // `tap.table`: the tap wake reported the alarm table BEFORE and AFTER its cancel as
  // `{carry: 4641, before: [4640, 4641], after: [4640]}` - the heartbeat survived the cancel and
  // was still in the table when the wake ended, and it never fired again. The only code left in
  // that path is this call. So exit() from an onEvent (action) context takes the repeating alarm
  // with it, while onInit (alarm) contexts call it every minute without harm. An action wake
  // therefore ends the way every build before 0.9.10 did: by returning.
  if (fromAction) return
  try {
    if (appService && typeof appService.exit === 'function') appService.exit()
  } catch (e) {}
}

// --- transport --------------------------------------------------------------

function connect(done) {
  let appId = 0
  try {
    appId = getPackageInfo().appId
  } catch (e) {}
  try {
    mb = new MessageBuilder({ appId, appDevicePort: 20, appSidePort: 0, ble })
    mb.connect() // sends the shake; the reply fills in appSidePort
  } catch (e) {
    devLog('connect.fail ' + e)
    return done(false)
  }
  // A brand-new builder's shake promise resolves when the side answers the
  // shake. If the side is not running it never resolves and the OS kills this
  // tick. Nothing is lost by that: what must survive was armed before this call (a
  // carried press, the next alarm), so a dead link costs latency, not an answer.
  const p = mb.waitingShakePromise
  if (!p || typeof p.then !== 'function') return done(true)
  p.then(() => done(true)).catch(() => done(false))
}

// One request/response, no timer. Resolves exactly once: on the response whose
// traceId matches, or with null if the frame cannot be sent at all.
function requestOnce(payload, done) {
  const requestId = genTraceId()
  let settled = false
  const finish = (value) => {
    if (settled) return
    settled = true
    try {
      mb && mb.off('response', onResponse)
    } catch (e) {}
    done(value)
  }
  const onResponse = (full) => {
    if (!full) return
    if (full.traceId && requestId && full.traceId !== requestId) return
    let msg = null
    try {
      msg = mb.buf2Json(full.payload)
    } catch (e) {}
    finish(msg || null)
  }
  try {
    mb.on('response', onResponse)
  } catch (e) {
    return finish(null)
  }
  try {
    mb.sendJson({
      requestId,
      json: payload,
      type: MessagePayloadType.Request,
      // Both are written into the packet header with writeUInt8(); leaving them
      // undefined throws instead of defaulting.
      contentType: MessagePayloadDataTypeOp.JSON,
      dataType: MessagePayloadDataTypeOp.JSON,
    })
  } catch (e) {
    devLog('request.send.fail ' + payload.t + ' ' + e)
    finish(null)
  }
}

// Fire-and-forget Notify frame, used ONLY once the shake has completed.
//
// A frame's header carries port2 = mb.appSidePort, which is 0 until the shake reply
// fills it in, and the phone's inbound path drops a Data frame whose port2 is not its
// own port (watch/shared/VENDORED.md). So a pre-shake beacon is not "sent early", it
// is sent nowhere - that was the whole reason every devLog written during a tap was
// invisible remotely. Everything that must be observable now goes through queueLog()
// and flushLogs().
//
// Returns false when nothing could be sent, so the caller can keep the payload queued
// rather than lose it.
function beacon(payload) {
  if (!mb || !mb.appSidePort) {
    devLog('beacon.no-link ' + ((payload && payload.e) || '?'))
    return false
  }
  try {
    // Deliberately not mb.call(): call() runs fork(), which arms a setTimeout and
    // therefore waits for a handshake that is already done.
    mb.sendJson({
      json: payload,
      type: MessagePayloadType.Notify,
      contentType: MessagePayloadDataTypeOp.JSON,
      dataType: MessagePayloadDataTypeOp.EMPTY,
    })
    return true
  } catch (e) {
    devLog('beacon.fail ' + e)
    return false
  }
}

// Telemetry for THIS wake, in send order. Not persisted: see the durability note above.
function queueLog(payload) {
  if (logs.length >= MAX_LOGS) logs.shift()
  logs.push(payload)
  return logs.length
}

// Send the buffered telemetry, oldest first, stopping at the first refusal (no link), in
// which case what is left dies with the context. Returns how many left.
function flushLogs() {
  let sent = 0
  while (logs.length) {
    if (!beacon(logs[0])) break
    logs.shift()
    sent++
  }
  return sent
}

// --- carrying a press across wakes ------------------------------------------

function paramValue(raw, key) {
  for (const pair of String(raw || '').split('&')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    if (pair.slice(0, idx) === key) return pair.slice(idx + 1)
  }
  return ''
}

function retryDelay(n) {
  return Number(n) <= 5 ? RETRY_FIRST_SEC : RETRY_LATER_SEC
}

// The param of a carried press: the same i/a encoding a notification button uses (so
// decodeActionParam() works unchanged) plus the original timestamp and the attempt
// number. Kept well under the 120-char param budget encodeActionParam() respects.
function carriedParam(i, a, ts, n) {
  return RETRY_MARK + '&' + encodeActionParam({ i, a }) + '&ts=' + Number(ts) + '&n=' + Number(n)
}

// Send one ack and report whether the phone answered it. The answer is the receipt: the
// side responds BEFORE its HTTP call and queues to its own durable outbox on failure, so
// once it has answered, the press is out of the watch's hands.
function sendAck(i, a, ts, done) {
  requestOnce({ t: MSG.ACK, i, a, ts }, (res) => {
    if (!res) {
      devLog('ack.nores ' + i)
      queueLog({ t: MSG.LOG, e: 'tap-send-failed', i, a })
      return done(false)
    }
    done(true)
  })
}

// --- work -------------------------------------------------------------------

function render(items) {
  const list = Array.isArray(items) ? items : []
  const rendered = []
  // relay id -> notification-centre id, reported back so the relay can ask for a
  // notification to be cancelled on a later wake without the watch persisting a map
  // across contexts.
  const centre = {}
  let shown = 0
  for (const raw of list) {
    const n = normalizeNotification(raw)
    if (!n) continue
    const actions = n.actions.map((a) => ({
      text: a.label.slice(0, 18),
      file: SERVICE_FILE, // buttons must target THIS service (single slot rule)
      param: encodeActionParam({ i: n.id, a: a.id }),
    }))
    try {
      // notify() returns 0 on failure and the centre id otherwise. Ignoring that made
      // an OS-level drop indistinguishable from a render: it was reported as `rendered`
      // and the relay stopped serving it.
      const centreId = notify({
        title: n.title.slice(0, 40),
        content: n.body.slice(0, 160),
        actions,
        vibrate: typeof n.vibrate === 'number' ? n.vibrate : BUZZ,
      })
      if (!centreId) {
        devLog('notify.failed ' + n.id + ' return 0')
        continue
      }
      shown++
      rendered.push(n.id)
      centre[n.id] = centreId
    } catch (e) {
      devLog('notify.failed ' + n.id + ' ' + e)
    }
  }
  render.last = rendered
  render.centre = centre
  return shown
}

// One verdict string shared by the notification and the beacon. "skipped" and

function tick(param) {
  const raw = String(param || '')

  // A TAP IS A USER ACTION, NOT A TICK. It is handled before the storm guard, before
  // re-arming and before the armed gate, because none of those have anything to say
  // about a button the user has already pressed. Ordering this after `isArmed()` is
  // how an answer used to evaporate: no alarm, no notification, no devLog the operator
  // could ever read.
  if (raw.indexOf('i=') >= 0) return tap(raw)

  const show = raw.indexOf('show=1') >= 0
  const armed = isArmed()

  // THE HEARTBEAT IS THE WHOLE SCHEDULE. Measured on this watch 2026-11-10: a repeat alarm
  // with `repeat_period: 1` fires every 60 s indefinitely, so the OS carries the cadence and
  // this file must never touch the alarm table. That retires the oneshot chain (where one
  // missed wake ended everything, which is what happened for 5.2 h), the fence, the sweeper
  // and the storm guard.
  //
  // The contract this file keeps, copied from a 24/7 alarm app that has run for months: the
  // page is the only alarm writer, and a wake is READ-ONLY with respect to alarms. Do not
  // add a set()/cancel() here. The one exception is the tap path above, which arms a carrier
  // alarm so an unanswered press survives this context - that alarm is transient by design.
  const pendingNow = pendingIds()
  const viaAlarm = raw.indexOf('via=alarm') >= 0
  const heartbeat = raw.indexOf('hb=') >= 0

  // Proof of execution, in the notification the `show` flag asks for: one glance shows the
  // heartbeat's own state without reading anything off the watch.
  if (show) {
    try {
      notify({
        title: 'Tick hb=' + (heartbeat ? paramValue(raw, 'hb') : '-'),
        content:
          'pending=' + pendingNow.length +
          ' ble=' + bleStatus() +
          ' api=' + apiLevel() +
          ' armed=' + (armed ? 1 : 0),
        actions: [],
        vibrate: 2,
      })
    } catch (e) {}
  }

  if (!armed) {
    devLog('tick skipped: disarmed')
    return quit('disarmed')
  }

  const st = bleStatus()
  // Strict false: an undefined/unknown answer must not silently disable the tick.
  let connected = null
  try {
    connected = typeof connectStatus === 'function' ? connectStatus() : null
  } catch (e) {
    connected = 'err'
  }
  // Local logging is deliberately sparse in here: every devLog() rewrites the whole
  // ring buffer to localStorage AND to @zos/fs, and this file runs once a minute
  // forever. The queued telemetry below carries the same facts to the server, so the
  // on-watch copy is reserved for failures and for the exit reason.
  if (connected === false) {
    // Nothing to pull and every send would be swallowed; the next alarm retries.
    devLog('tick skip: bluetooth disconnected')
    queueLog({ t: MSG.LOG, e: 'tick.no-ble', wake: raw.slice(0, 60), ble: st, conn: connected })
    return quit('no-ble')
  }
  // Queued, not sent: before the handshake `appSidePort` is 0 and the phone drops the
  // frame. flushLogs() runs inside the connect callback, which is also why a wake that
  // never gets a link still has its `tick.wake` reported on the next one - delayed, but
  // never silent.
  queueLog({
    t: MSG.LOG,
    e: 'tick.wake',
    wake: raw,
    ble: st,
    conn: connected,
    // Readable in the server trace, which beats squinting at the watch. `ids` is the whole
    // alarm table: with one heartbeat expected, anything else in it is a leak we can see.
    hb: heartbeat ? 1 : 0,
    pending: pendingNow.length,
    ids: pendingNow,
  })

  connect((ok) => {
    if (!ok) {
      devLog('tick-no-shake')
      queueLog({ t: MSG.LOG, e: 'tick.no-shake', wake: raw.slice(0, 60), ble: st, conn: connected })
      return quit('no-shake')
    }
    flushLogs()
    if (TICK_KIND === 'poll') {
      // Ack-driven since 0.5.3: the relay serves everything not yet reported as
      // rendered, so no cursor crosses the wire and a lost response costs one
      // interval instead of deleting the notification.
      requestOnce({ t: MSG.POLL }, (res) => {
        // A poll with no parseable response is the failure that lost ten
        // notifications overnight. Name it in the trace instead of vanishing.
        if (!res) {
          devLog('poll.nores')
          queueLog({ t: MSG.LOG, e: 'poll.nores' })
          flushLogs()
          quit('poll-nores')
          return
        }
        const shown = res.items ? render(res.items) : 0
        const ids = render.last || []
        const centre = render.centre || {}

        // Delete notifications the relay has finished with: answered, replaced by a
        // newer item, or expired with retract set. cancel() on an id the user already
        // deleted is a no-op, so repeating this until the relay stops asking is safe.
        const cancelList = Array.isArray(res.cancel) ? res.cancel : []
        let cancelled = []
        if (cancelList.length) {
          try {
            cancel(cancelList)
            cancelled = cancelList
          } catch (e) {
            devLog('cancel.failed ' + e)
          }
        }

        devLog(
          'poll items=' + (res.items ? res.items.length : 0) +
            ' shown=' + shown + ' centre=' + Object.keys(centre).length +
            ' cancel=' + cancelList.length
        )

        // Report what actually reached the notification centre, plus the id map and any
        // cancellations. This travels in the device->phone direction, which works even
        // when responses do not arrive, and it is what stops the relay serving the item
        // again. Fire-and-forget: no need to wait, so it costs no budget.
        if (ids.length || cancelList.length || Object.keys(centre).length) {
          try {
            mb.sendJson({
              requestId: genTraceId(),
              json: {
                t: MSG.SEEN,
                ids,
                centre,
                cancelled,
                got: res.items ? res.items.length : 0,
                shown,
              },
              type: MessagePayloadType.Request,
              contentType: MessagePayloadDataTypeOp.JSON,
              dataType: MessagePayloadDataTypeOp.JSON,
            })
          } catch (e) {
            devLog('seen.send.fail ' + e)
          }
        }
        // Nothing to drain here any more: an unanswered press carries itself in an
        // alarm (see tap()), so a poll wake has no backlog to retry.
        quit('poll')
      })
      return
    }
    requestOnce({ t: MSG.PROBE, from: 'alarm', wake: raw }, (res) => {
      devLog('probe ' + (res ? 'ok' : 'none'))
      quit(res ? 'probe-ok' : 'probe-none')
    })
  })
}

// Tap path. A press is a user action that has already happened, so the next attempt is
// armed BEFORE the link is touched: a one-shot alarm whose param carries the press. If
// this wake completes, that alarm is cancelled; if the wake dies - the measured failure,
// the side never answering the shake - the alarm fires and the press is retried, and with
// store:true it even survives a reboot.
//
// Idempotent end to end: the side answers before its POST and queues to its own outbox,
// the relay collapses identical (id, action) answers, and cancelling an alarm that
// already fired only costs one duplicate frame.
function tap(raw) {
  const { i, a } = decodeActionParam(raw)
  const retry = raw.indexOf(RETRY_MARK) >= 0
  const attempt = Number(paramValue(raw, 'n')) || 0
  // The original press time, so `lag` and the relay's transit_ms measure the user's
  // patience rather than the last retry.
  const ts = Number(paramValue(raw, 'ts')) || Date.now()

  // No id in the param: unanswerable. There is no ack to carry, so the trace is the only
  // evidence the press happened - make one attempt to report it instead of dying quietly.
  if (!i) {
    devLog('tap-no-id ' + raw.slice(0, 40))
    queueLog({ t: MSG.LOG, e: 'tap-no-id', wake: raw.slice(0, 60) })
    connect((ok) => {
      if (ok) flushLogs()
      quit('tap-no-id')
    })
    return
  }

  // THE DURABILITY POINT. Everything below can fail, including the OS reaping this
  // 600 ms context mid-shake.
  let carry = null
  if (attempt < RETRY_MAX) {
    carry = setCarryAlarm(carriedParam(i, a, ts, attempt + 1), retryDelay(attempt + 1))
    devLog('tap carry=' + (carry && carry.ok ? carry.id : 'FAIL ' + ((carry && carry.err) || '?')))
  } else {
    devLog('tap retries exhausted ' + attempt)
  }

  devLog('tap ' + i + '/' + a + ' try=' + attempt)
  // Named `tap.received` even on a retry: what it means is "the service was woken by a
  // press and is answering it", which is true either way. `try` says which attempt.
  queueLog({ t: MSG.LOG, e: 'tap.received', i, a, try: attempt, ts })
  if (retry) queueLog({ t: MSG.LOG, e: 'tap.retry', i, a, try: attempt })

  connect((ok) => {
    if (!ok) {
      // Nothing can leave this context, but the next attempt is already in the OS.
      devLog('tap-no-shake ' + i)
      queueLog({ t: MSG.LOG, e: 'tap-no-shake', i, a, try: attempt })
      return quit('tap-no-shake')
    }
    // Queue the dispatch BEFORE the request so the same flush that carries tap.received also
    // carries the fact that this attempt went out. Fire-and-forget frames always arrive (that
    // is how tap.received itself gets here); the reply to the request does not, and its
    // absence used to look identical to "the press was never answered".
    queueLog({ t: MSG.LOG, e: 'tap.ack-sent', i, a, try: attempt, ts })
    // FLUSH BEFORE THE REQUEST. 0.9.14 moved this after sendAck so the entry would describe a
    // completed dispatch, and 0.9.15 then produced no tap telemetry at all - the one thing this
    // path had always done reliably was get its Notify frames out before the ack Request. If
    // the request throws, requestOnce calls back synchronously, which reaches quit() and exits
    // the context before any flush could run. Order it the way that is known to work: log
    // frames first, request second.
    flushLogs()
    sendAck(i, a, ts, (sent) => {
      if (sent) {
        // Everything that must be known is captured as telemetry and flushed ONCE at the end:
        // 0.9.16 queued the table but only flushed it on one branch, so the diagnostic never
        // arrived and the disappearance stayed unexplained for another flash.
        const carryId = carry && carry.ok ? Number(carry.id) : 0
        let before = null
        let after = null
        try {
          before = pendingIds()
        } catch (e) {}
        // Answered: stop the retry chain. Only on a real id: cancel(0) is what took the
        // heartbeat with it (see trySet in shared/alarm.js).
        if (carryId > 0) cancelAlarm(carryId)
        try {
          after = pendingIds()
        } catch (e) {}
        queueLog({
          t: MSG.LOG,
          e: 'tap.table',
          i,
          a,
          carry: carryId,
          before: before,
          after: after,
        })
        // The schedule must survive a press whatever removed it: if nothing but the carrier we
        // just cancelled is left, put the heartbeat back before this context dies.
        try {
          const others = (after || []).filter((id) => Number(id) !== carryId)
          if ((after || []).length >= 0 && others.length === 0) {
            const hb = setHeartbeatAlarm()
            queueLog({ t: MSG.LOG, e: 'tap.rearm', ok: hb && hb.ok ? 1 : 0, id: hb && hb.ok ? hb.id : 0 })
          }
        } catch (e) {}
        queueLog({ t: MSG.LOG, e: 'tap.sent', i, a, try: attempt, lag: Date.now() - ts })
        devLog('tap sent ' + i + '/' + a + ' try=' + attempt + ' lag=' + (Date.now() - ts))
        // Leave the schedule in a known state: exactly one heartbeat, freshly armed. The table
        // above proves the record was alive during this wake, so whatever removed it did so
        // afterwards; a fresh record cannot be the one that was removed.
        try {
          cancelAllTickAlarms()
          const hb = setHeartbeatAlarm()
          queueLog({ t: MSG.LOG, e: 'tap.hb', ok: hb && hb.ok ? 1 : 0, id: hb && hb.ok ? hb.id : 0 })
        } catch (e) {}
        // One flush, always, on both branches. Twice now a diagnostic was queued on a branch
        // that never flushed, and a wake with no frames is indistinguishable from one that
        // never ran.
        flushLogs()
      } else {
        flushLogs()
      }
      quit(sent ? 'tap' : 'tap-unacked')
    })
  })
}

// Manual diagnostic from the page: renders a notification with the tick's own
// counters, so "did the service execute at all" is answerable without BLE.
function selftest(raw) {
  let appId = 0
  try {
    appId = getPackageInfo().appId
  } catch (e) {}
  const body =
    'armed=' + (isArmed() ? 1 : 0) + ' ble=' + bleStatus() + ' app=' + appId + ' wake=' + raw
  try {
    notify({ title: 'Tick self-test', content: body, actions: [], vibrate: 3 })
    devLog('selftest ' + body)
  } catch (e) {
    devLog('selftest notify failed ' + e)
  }
}

// --- entry points -----------------------------------------------------------

// The alarm delivers its param to onInit on a cold start and to onEvent when an
// instance already exists. Both do the same thing, and both exit.
AppService({
  onInit(param) {
    const raw = String(param || '')
    logger.log('tick onInit', raw)
    try {
      if (raw.indexOf('selftest') >= 0) {
        selftest(raw)
        return quit('selftest')
      }
      tick(raw)
    } catch (e) {
      devLog('onInit threw ' + e)
      quit('onInit-threw')
    }
  },

  onEvent(param) {
    const raw = String(param || '')
    fromAction = true
    logger.log('tick onEvent', raw)
    try {
      if (raw.indexOf('selftest') >= 0) {
        selftest(raw)
        return quit('selftest')
      }
      tick(raw)
    } catch (e) {
      devLog('onEvent threw ' + e)
      quit('onEvent-threw')
    }
  },

  onDestroy() {
    // Deliberately does NOT cancel the alarm: the alarm is the only thing that
    // can bring the service back, and the page owns disarming.
    devLog('onDestroy')
  },
})
