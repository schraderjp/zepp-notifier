// Page-side arming: permission + start + alarm, in that order.
//
// The alarm scheduling itself lives in shared/alarm.js, because the tick service
// needs the same code and must not import this module (this one pulls in the
// page-facing permission APIs).

import { queryPermission, requestPermission } from '@zos/app'
import { localStorage } from '@zos/storage'
import * as appServiceMgr from '@zos/app-service'

import {
  NOTIFIER_SERVICE,
  MODE_REPEAT,
  MODE_ONESHOT,
  readCadence,
  writeCadence,
  cycleCadence,
  CADENCE_STEPS,
  ensureTickAlarm,
  forceTickAlarm,
  setFenceAlarm,
  FENCE_PERIOD_SEC,
  cancelAllTickAlarms,
  pendingIds,
  armedIds,
  ourIds,
  alarmSummary,
  alarmDiag,
  alarmDump,
} from './alarm'

export {
  NOTIFIER_SERVICE,
  MODE_REPEAT,
  MODE_ONESHOT,
  readCadence,
  writeCadence,
  cycleCadence,
  CADENCE_STEPS,
  alarmSummary,
  alarmDiag,
  alarmDump,
  pendingIds,
  armedIds,
  ourIds,
  ensureTickAlarm,
  forceTickAlarm,
  setFenceAlarm,
  FENCE_PERIOD_SEC,
}

export const ARMED_KEY = 'relay_armed'
export const BG_PERMISSION = 'device:os.bg_service'
// 0.4.8: `alarmMgr.set()` refuses with `PERMISSION DENIED device:os.alarm` when
// this is not declared in app.json. It is not a scheduling error at all - the
// call never reached the validator, which is why every argument shape "failed"
// identically and why no alarm was ever created.
export const ALARM_PERMISSION = 'device:os.alarm'
const REQUIRED = [BG_PERMISSION, ALARM_PERMISSION]

const AUTHORIZED = 2

export function isArmed() {
  try {
    return localStorage.getItem(ARMED_KEY) !== '0'
  } catch (e) {
    return true // unreadable storage: assume armed rather than silently promising nothing
  }
}

export function setArmed(value) {
  try {
    localStorage.setItem(ARMED_KEY, value ? '1' : '0')
  } catch (e) {}
}

// --- permission -------------------------------------------------------------

// 0.2.x requested `device:os.bg_service` every time the user pressed Arm. When
// 0.4.0 replaced Arm with "set an alarm", the request went away with it - and an
// App Service that was never granted the permission is neither startable nor
// launchable by an alarm, both silently. Measured: `bg=0` on 0.4.1, `bg=2` after
// this request was restored.
export function permissionState(name) {
  try {
    const result = queryPermission({ permissions: [name || BG_PERMISSION] }) || []
    return typeof result[0] === 'number' ? result[0] : -1
  } catch (e) {
    return -1
  }
}

export function alarmPermissionState() {
  return permissionState(ALARM_PERMISSION)
}

export function ensureBgPermission(cb) {
  const done = cb || function () {}
  const missing = REQUIRED.filter((perm) => permissionState(perm) !== AUTHORIZED)
  if (!missing.length) {
    return done({ ok: true, state: AUTHORIZED, missing: [], bg: AUTHORIZED, alarm: AUTHORIZED })
  }
  let settled = false
  const finish = (value) => {
    if (settled) return
    settled = true
    done(value)
  }
  try {
    requestPermission({
      permissions: missing,
      callback: (result) => {
        const denied = missing.filter((_, index) => (result || [])[index] !== AUTHORIZED)
        finish({
          ok: denied.length === 0,
          missing: denied,
          bg: permissionState(BG_PERMISSION),
          alarm: permissionState(ALARM_PERMISSION),
          asked: true,
        })
      },
    })
  } catch (e) {
    return finish({ ok: false, missing, reason: 'requestPermission threw: ' + e })
  }
  // If the OS shows no dialog the callback may never arrive. Do not hang the
  // button: report "asked, no answer" and let the caller continue.
  setTimeout(
    () =>
      finish({
        ok: false,
        missing,
        bg: permissionState(BG_PERMISSION),
        alarm: permissionState(ALARM_PERMISSION),
        asked: true,
        noAnswer: true,
      }),
    5000,
  )
}

// --- arming -----------------------------------------------------------------

export function armNotifier(cb, options) {
  setArmed(true)
  ensureBgPermission((perm) => {
    // Force, never dedupe: see forceTickAlarm(). A spent-but-pending alarm must
    // not make this a no-op.
    const result = forceTickAlarm(options)
    result.perm = perm
    // The fence is re-armed with every Arm press because forceTickAlarm() swept every
    // alarm we own (including the previous fence). One repeating alarm, never re-armed by
    // the tick: see setFenceAlarm().
    result.fence = setFenceAlarm()
    if (cb) cb(result)
  })
}

export function disarmNotifier(cb) {
  setArmed(false)
  const result = cancelAllTickAlarms()
  if (cb) cb(result)
  return result
}

// --- starting the tick by hand ----------------------------------------------

// 0.1.4 - the only build whose alarms are known to have fired - armed its first
// alarm from INSIDE the service (onInit), with the page only calling start().
// 0.4.6 still offers that path, but it is no longer the recommended test: a
// start()-ed service is a CONTINUOUS instance, and one that fails to exit wedges
// the single App Service slot (see the `exit` bug in docs/status.md).
export function startTickOnce(param, cb) {
  const done = cb || function () {}
  setArmed(true)
  ensureBgPermission((perm) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      done(value)
    }
    let code = -1
    try {
      code = appServiceMgr.start({
        file: NOTIFIER_SERVICE,
        param: param || 'via=manual&mode=oneshot&show=1',
        complete_func: (res) => finish({ code, perm, result: !!(res && res.result) }),
      })
      if (code !== 0) finish({ code, perm })
    } catch (e) {
      return finish({ code: -1, perm, reason: 'start threw: ' + e })
    }
    setTimeout(() => finish({ code, perm, noCallback: code === 0 }), 4000)
  })
}
