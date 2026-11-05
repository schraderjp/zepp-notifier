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
// which are rendered here, and a button tap acks on its own wake.

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
import { armNext, armNextOneshot, pendingIds, cancelAllTickAlarms } from '../shared/alarm'
// NO `@zos/app-service` IMPORT. Measured: 0.4.3 (no such import) executed and
// rendered; 0.4.5-0.4.11 (with it) never executed once. Importing the module that
// manages app services into an app service is a load-time failure here, which
// means AppService() is never registered, start() still returns 0, and nothing
// runs. That import was an attempt to call exit(); see quit() below for how this
// file avoids needing it.
import { append as devLog } from '../shared/devlog'

const logger = log.getLogger('relay.tick')

const SERVICE_FILE = 'app-service/notifier'
const ARMED_KEY = 'relay_armed'
const BUZZ = 5

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
  // No exit() call: `exit` is neither a global nor safely importable from
  // @zos/app-service in this runtime (importing it stopped the service loading).
  // This file is woken only by alarms, which the OS runs as single-execution and
  // reaps on return. It must never be appServiceMgr.start()ed.
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
  // tick - which is the correct, silent outcome, not a hang to work around.
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

// Fire-and-forget beacon, sent BEFORE the shake completes. Its only purpose is
// to make "the alarm fired but the link is dead" distinguishable from "the
// alarm never fired": the frame is small and the side's inbound path does not
// filter ports, so it can arrive even when the handshake will not.
function beacon(payload) {
  try {
    // Deliberately not mb.call(): call() runs fork(), which arms a setTimeout and
    // therefore waits for a handshake that may never come. This frame is meant to
    // go out immediately, even with appSidePort still 0.
    mb &&
      mb.sendJson({
        json: payload,
        type: MessagePayloadType.Notify,
        contentType: MessagePayloadDataTypeOp.JSON,
        dataType: MessagePayloadDataTypeOp.EMPTY,
      })
  } catch (e) {
    devLog('beacon.fail ' + e)
  }
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

  const show = raw.indexOf('show=1') >= 0
  const armed = isArmed()

  // Re-arm FIRST: synchronous, no BLE, and it must happen before anything that
  // can hang. Cancels every alarm we own and arms exactly one 60 s out, so the
  // cadence never depends on repeat_period/repeat_duration being honoured.
  // Storm guard, before anything else: if the table has piled up, this build is
  // misbehaving. Cancel everything and switch the app off rather than arm more.
  const pendingNow = pendingIds()
  if (pendingNow.length > 3) {
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
  let chain = null
  if (armed && viaAlarm) {
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

  // A button tap: the notification's action param carries the id + action.
  if (raw.indexOf('i=') >= 0) return tap(raw)

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
  // forever. The beacon below carries the same facts to the server, so the
  // on-watch copy is reserved for failures and for the exit reason.
  if (connected === false) {
    // Nothing to pull and every send would be swallowed; the next alarm retries.
    devLog('tick skip: bluetooth disconnected')
    return quit('no-ble')
  }
  beacon({
    t: MSG.LOG,
    e: 'tick.wake',
    wake: raw,
    ble: st,
    conn: connected,
    // Readable in the server trace, which beats squinting at the watch.
    chain: chainVerdict(chain),
    chainId: chain && chain.id !== undefined ? chain.id : -1,
    chainErr: chain && !chain.ok ? String(chain.reason || chain.skipped || '').slice(0, 80) : '',
  })

  connect((ok) => {
    if (!ok) return quit('no-shake')
    if (TICK_KIND === 'poll') {
      // Ack-driven since 0.5.3: the relay serves everything not yet reported as
      // rendered, so no cursor crosses the wire and a lost response costs one
      // interval instead of deleting the notification.
      requestOnce({ t: MSG.POLL }, (res) => {
        // A poll with no parseable response is the failure that lost ten
        // notifications overnight. Name it in the trace instead of vanishing.
        if (!res) {
          devLog('poll.nores')
          beacon({ t: MSG.LOG, e: 'poll.nores' })
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

// Tap path: one request, exit on the answer. The side replies before it does
// HTTP, so the budget is one BLE round trip, not one round trip plus a POST.
function tap(raw) {
  const { i, a } = decodeActionParam(raw)
  if (!i) return quit('tap-no-id')
  devLog('tap ' + i + '/' + a)
  connect((ok) => {
    if (!ok) return quit('tap-no-shake')
    // Fire-and-forget first: a small Notify frame goes out even before the shake
    // resolves, so the ack is not lost if the handshake never completes. The
    // probe afterwards is only a flush barrier - it proves the link carried a
    // frame, without sending the ack twice.
    beacon({ t: MSG.ACK, i, a, ts: Date.now() })
    requestOnce({ t: MSG.PROBE, from: 'tap' }, (res) => {
      devLog('tap flushed=' + (res ? 1 : 0))
      quit('tap')
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
