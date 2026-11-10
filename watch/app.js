import { log } from '@zos/utils'
import { isArmed, setHeartbeatAlarm, pendingIds } from './shared/service'

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
    if (!isArmed()) {
      logger.log('auto-arm skipped: disarmed by user')
      return
    }
    // Do NOT re-arm when an alarm is already pending. The heartbeat repeats forever, so a
    // pending record IS a healthy one; re-arming on every launch would be a second writer
    // racing the OS and would mint duplicate heartbeats.
    const pending = pendingIds()
    if (pending.length) {
      logger.log('auto-arm skipped: already pending ' + JSON.stringify(pending))
      return
    }
    logger.log('auto-arm', JSON.stringify(setHeartbeatAlarm()))
  },

  onDestroy() {
    logger.log('onDestroy')
  },
})
