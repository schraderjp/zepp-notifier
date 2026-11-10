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
  armNext,
  armNextOneshot,
  pendingIds,
  cancelAllTickAlarms,
  setCarryAlarm,
  cancelAlarm,
  setFenceAlarm,
  setSweepEnd,
  repeatTypeInfo,
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
const RETRY_MAX = 40
const RETRY_FIRST_SEC = 90
const RETRY_LATER_SEC = 300
// Pending-alarm limit before the storm guard disarms. 3 was too tight once a tap waiting to
// be answered keeps an alarm of its own, and 8 is too tight for the 0.9.10 repeat_type sweep,
// which arms one record per numeric value beside the chain, the oneshot fence and the repeat
// fence (about 11 in total). The sweep is time-boxed: its sweeper wake cancels everything and
// restores chain + fence, so this ceiling is temporary and deliberately loose. A real runaway
// (an alarm per wake) still trips it within minutes.
const STORM_LIMIT = 20

// 'probe' = E1, transport only. 'poll' = E2, fetch + render.
const TICK_KIND = 'poll'

let mb = null
let finished = false

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
// "failed" are very different: skipped means armNext() refused on purpose because
// the table already had >= 3 entries, failed means set() was rejected.
function chainVerdict(chain) {
  if (!chain) return 'off'
  if (chain.ok) return 'ok:' + (chain.shape || '?')
  if (chain.skipped) return 'skip:' + String(chain.skipped).slice(0, 24)
  return 'FAIL:' + String(chain.reason || '?').slice(0, 40)
}

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

  // Re-arm FIRST: synchronous, no BLE, and it must happen before anything that
  // can hang. Cancels every alarm we own and arms exactly one 60 s out, so the
  // cadence never depends on repeat_period/repeat_duration being honoured.
  // Storm guard, before anything else: if the table has piled up, this build is
  // misbehaving. Cancel everything and switch the app off rather than arm more.
  const pendingNow = pendingIds()
  if (pendingNow.length > STORM_LIMIT) {
    devLog('tick STORM GUARD pending=' + JSON.stringify(pendingNow))
    try {
      cancelAllTickAlarms()
    } catch (e) {}
    selfDisarm()
    try {
      notify({ title: 'Tick disabled', content: 'too many alarms: ' + pendingNow.length + ', cleared', actions: [] })
    } catch (e) {}
    return quit('storm')
  }

  // Only an ALARM wake re-arms. A tap cold-starts this file too, and re-arming
  // there added an alarm per tap.
  const viaAlarm = raw.indexOf('via=alarm') >= 0
  // The chain continues in the mode it was started in. A oneshot chain is the
  // safe one: `delay` only, no repeat_* fields, so it cannot express a storm.
  const oneshot = raw.indexOf('mode=oneshot') >= 0
  // The fence is the second, independent oneshot chain (alarm.js setFenceAlarm): it exists
  // so that a missed delivery of the MAIN chain's next alarm slows delivery to five minutes
  // instead of stopping it. It re-arms only itself - never the main chain - because pending
  // alarms come back as bare ids, so "is the main chain alive" is not answerable from here,
  // and a wrong guess adds an alarm permanently (N pending -> N wakes a minute).
  // `rfence=1` is the REPEAT fence (alarm.js setRepeatFence): the OS repeats it, so this
  // wake must never re-arm it and never touch the chain. Checked before `fence=1` because
  // 'rfence=1' contains 'fence=1'.
  const repeatFence = raw.indexOf('rfence=1') >= 0
  const sweepAt = raw.indexOf('rt=') >= 0
  const sweepEnd = raw.indexOf('sweepend=1') >= 0
  const fence = !repeatFence && !sweepAt && raw.indexOf('fence=1') >= 0
  const rtInfo = repeatTypeInfo()
  let chain = null
  let armF = null
  if (sweepEnd) {
    // End of the repeat_type sweep: cancel every alarm we own and restore the working pair,
    // so a failed experiment leaves nothing armed. This wake is the only one allowed to tear
    // the table down.
    cancelAllTickAlarms()
    if (armed) {
      chain = armNextOneshot(false)
      armF = setFenceAlarm()
    }
    queueLog({ t: MSG.LOG, e: 'tick.sweepend', chain: chainVerdict(chain), fenceOk: armF && armF.ok ? 1 : 0 })
  } else if (sweepAt) {
    // One `repeat_type` variant fired. Name it, do not re-arm it, do not touch the chain.
    queueLog({
      t: MSG.LOG,
      e: 'tick.fence',
      kind: 'sweep',
      rt: paramValue(raw, 'rt'),
      rm: rtInfo.rm,
      rmSrc: rtInfo.src,
      pending: pendingNow.length,
    })
  } else if (repeatFence) {
    // The measurement: no re-arm, one poll, and `rm` reports the repeat_type value we sent.
    queueLog({
      t: MSG.LOG,
      e: 'tick.fence',
      kind: 'repeat',
      rm: rtInfo.rm,
      rmSrc: rtInfo.src,
      pending: pendingNow.length,
    })
  } else if (fence) {
    if (armed) armF = setFenceAlarm()
    // `pending` is the diagnostic: 2 means the main chain's next alarm is still in the
    // table beside this fence, 1 means this wake is alone - the main chain died and the
    // fence is now carrying the whole cadence.
    queueLog({
      t: MSG.LOG,
      e: 'tick.fence',
      kind: 'oneshot',
      pending: pendingNow.length,
      fenceOk: armF && armF.ok ? 1 : 0,
      // The instrument that does not depend on the mechanism under test: this fence fires
      // every five minutes, so the constant's real value and provenance are observable
      // within minutes even when every repeat record stays silent.
      rm: rtInfo.rm,
      rmSrc: rtInfo.src,
      api: apiLevel(),
      exit: typeof appService.exit === 'function' ? 'fn' : 'no',
    })
  } else if (armed && viaAlarm) {
    // No prune here. Cancelling "extra" alarms cancels the one whose wake is in
    // progress (the alarm being fired is still listed as pending during its own
    // wake), which is the documented way to wedge the scheduler. Growth is
    // bounded by armNext()'s >= 3 refusal and the storm guard above it.
    chain = oneshot ? armNextOneshot(show) : armNext(show, 60)
  }

  // Then the proof-of-execution notification, carrying the chain result: one
  // glance tells us whether this wake scheduled the next one.
  if (show) {
    try {
      // The chain verdict goes in the TITLE: it is the one thing we need to read
      // off the watch, and notification titles are rendered large.
      notify({
        title: 'Tick ' + chainVerdict(chain),
        content:
          'id=' + (chain && chain.id !== undefined ? chain.id : '-') +
          ' ble=' + bleStatus() +
          ' api=' + apiLevel() +
          ' armed=' + (armed ? 1 : 0) +
          (chain && !chain.ok && chain.reason ? ' ' + String(chain.reason).slice(0, 60) : ''),
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
    // Readable in the server trace, which beats squinting at the watch.
    fence: fence || repeatFence ? 1 : 0,
    pending: pendingNow.length,
    chain: chainVerdict(chain),
    chainId: chain && chain.id !== undefined ? chain.id : -1,
    chainErr: chain && !chain.ok ? String(chain.reason || chain.skipped || '').slice(0, 80) : '',
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
    flushLogs()
    sendAck(i, a, ts, (sent) => {
      if (sent) {
        // Answered: stop the retry chain. If the cancel itself fails the alarm fires once
        // more and re-sends an answer both ends collapse.
        if (carry && carry.ok) cancelAlarm(carry.id)
        queueLog({ t: MSG.LOG, e: 'tap.sent', i, a, try: attempt, lag: Date.now() - ts })
        devLog('tap sent ' + i + '/' + a + ' try=' + attempt + ' lag=' + (Date.now() - ts))
      }
      flushLogs()
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
