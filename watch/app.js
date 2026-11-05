import { log } from '@zos/utils'
import { isArmed, ensureTickAlarm, pendingIds, MODE_ONESHOT } from './shared/service'

const logger = log.getLogger('relay.app')

App({
  globalData: {},

  onCreate() {
    logger.log('onCreate')
    // No BLE here, and no service start: the tick service wakes itself from an
    // alarm. Launching the app therefore only has to guarantee that the alarm
    // exists, which is what makes a lost alarm (uninstall, cleared alarms,
    // reboot with store:true failing) self-healing on the next app open.
    //
    // ensureTickAlarm() dedupes through getAllAlarms(), so repeated launches do
    // not stack alarms.
    if (!isArmed()) {
      logger.log('auto-arm skipped: disarmed by user')
      return
    }
    // Do NOT re-arm when an alarm is already pending: launching the app used to
    // sweep and re-arm in MODE_REPEAT, which silently replaced a running oneshot
    // chain with repeat semantics. Opening the app must not change what is armed.
    const pending = pendingIds()
    if (pending.length) {
      logger.log('auto-arm skipped: already pending ' + JSON.stringify(pending))
      return
    }
    const result = ensureTickAlarm({ mode: MODE_ONESHOT, delaySec: 60 })
    logger.log('auto-arm', JSON.stringify(result))
  },

  onDestroy() {
    logger.log('onDestroy')
  },
})
