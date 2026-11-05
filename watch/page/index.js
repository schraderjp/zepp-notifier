// Control panel.
//
// 0.4.1 is a DIAGNOSTIC build. 0.4.0 armed an alarm and produced no wakes at
// all, and three very different failures look identical from the server trace:
//
//   a) alarmMgr.set() from the page is a no-op -> no alarm ever scheduled
//   b) the alarm exists but never fires -> `date`/`repeat_*` fields wrong
//   c) the alarm fires and the tick runs, but its frame never reaches the phone
//
// So the page now exposes the alarm API itself ("Alarm diag", no BLE involved),
// and can arm in a mode where every wake renders a notification ("Arm +
// notify"), which is proof of firing that needs neither BLE nor storage.
//
// Layout note: the square screen's status bar is hidden and content starts at
// y=40 (drawing at y=16 was clipped by the status bar in the first version).

import * as ui from '@zos/ui'
import { push } from '@zos/router'
import { notify } from '@zos/notification'
import { getPackageInfo } from '@zos/app'
import * as ble from '@zos/ble'
import * as appServiceMgr from '@zos/app-service'
import { log } from '@zos/utils'
import { MessageBuilder } from '../shared/message'
import {
  armNotifier,
  disarmNotifier,
  alarmSummary,
  alarmDiag,
  alarmDump,
  pendingIds,
  isArmed,
  NOTIFIER_SERVICE,
  MODE_ONESHOT,
  readCadence,
  cycleCadence,
  permissionState,
  alarmPermissionState,
  BG_PERMISSION,
  ALARM_PERMISSION,
  ensureBgPermission,
  startTickOnce,
} from '../shared/service'
import { append as appendDevLog, read as readDevLog, sinkState } from '../shared/devlog'

const logger = log.getLogger('relay.page')

const W = 390
const MARGIN = 20
const CONTENT_W = W - 2 * MARGIN

Page({
  build() {
    try {
      if (typeof ui.setStatusBarVisible === 'function') ui.setStatusBarVisible(false)
    } catch (e) {}

    this.link = ui.createWidget(ui.widget.TEXT, {
      x: MARGIN,
      y: 40,
      w: CONTENT_W,
      h: 24,
      text: 'watch->phone: checking...',
      text_size: 19,
      color: 0x9aa4ad,
      align_h: ui.align.LEFT,
    })

    this.status = ui.createWidget(ui.widget.TEXT, {
      x: MARGIN,
      y: 68,
      w: CONTENT_W,
      h: 56,
      text: '',
      text_size: 15,
      color: 0xffffff,
      text_style: ui.text_style.WRAP,
      align_h: ui.align.LEFT,
    })

    this.hint = ui.createWidget(ui.widget.TEXT, {
      x: MARGIN,
      y: 122,
      w: CONTENT_W,
      h: 22,
      text: '',
      text_size: 14,
      color: 0xffcc66,
      text_style: ui.text_style.WRAP,
    })

    const button = (y, text, onClick, color) =>
      ui.createWidget(ui.widget.BUTTON, {
        x: MARGIN,
        y,
        w: CONTENT_W,
        h: 28,
        radius: 8,
        text,
        text_size: 15,
        normal_color: color || 0x245884,
        press_color: 0x387eac,
        color: 0xffffff,
        click_func: onClick,
      })

    // Alarm-only from here on: the service must never be start()ed (it cannot
    // exit), so every test wakes it the way the product will.
    // Primary: the field-verified shape (url + repeat_type/period + delay).
    // Every arm is SILENT by default: a wake only renders what the relay queued.
    // `show=1` (the per-minute "Tick ..." proof notification) is a diagnostic and
    // gets exactly one button, because the chain inherits whatever the first wake
    // carried - arming loudly makes every subsequent wake loud too.
    button(140, 'Arm 30s  (silent)', () => this.arm(MODE_ONESHOT, 30), 0x1c5c34)
    button(172, 'Arm 30s  + tick proof', () => this.arm(MODE_ONESHOT, 30, true))
    this.cadenceBtn = button(204, 'Cadence: ...', () => this.cycleCadence(), 0x3d3d3d)
    button(236, 'Diag > notify+log', () => this.diag(), 0x3d3d3d)
    button(268, 'Disarm (sweep)', () => this.disarm())
    button(300, 'Load test (wedges)', () => this.startTick(), 0x6b4a12)
    button(332, 'Device log  >', () => push({ url: 'page/log' }))

    this.summary = ui.createWidget(ui.widget.TEXT, {
      x: MARGIN,
      y: 366,
      w: CONTENT_W,
      h: 80,
      text: '',
      text_size: 12,
      color: 0x8fd6a0,
      text_style: ui.text_style.WRAP,
      align_h: ui.align.LEFT,
    })

    this.refresh()
    this.probe(true)

    // Ask once, on open. This is the only moment a system permission prompt can
    // appear, and everything downstream (arming, alarm delivery, start()) is
    // silently blocked without it. It is idempotent: if the permission is
    // already granted nothing is shown and the callback returns immediately.
    ensureBgPermission((p) => {
      appendDevLog('perm ' + JSON.stringify(p))
      this.refresh()
    })
  },

  refresh() {
    const alarm = alarmSummary()
    const bg = permissionState(BG_PERMISSION)
    const al = alarmPermissionState()
    const permText = bg === 2 && al === 2 ? 'perm ok' : 'perm bg' + bg + ' al' + al + ' (!)'
    let cadence = 60
    try {
      cadence = readCadence()
    } catch (e) {}
    try {
      if (this.cadenceBtn) this.cadenceBtn.setProperty(ui.prop.TEXT, 'Cadence: ' + cadence + 's (tap: change)')
    } catch (e) {}
    const lines = [
      (isArmed() ? 'Armed' : 'Disarmed') + '   ours: ' + alarm.count + '   ' + permText,
      'pending: ' + JSON.stringify(alarm.pending || []) + '  every ' + cadence + 's',
    ]
    this.status.setProperty(ui.prop.TEXT, lines.join('\n'))

    let count = 0
    try {
      count = readDevLog().length
    } catch (e) {}
    let version = '?'
    try {
      const info = getPackageInfo() || {}
      version = info.appVersion || info.version || '?'
    } catch (e) {}
    this.summary.setProperty(
      ui.prop.TEXT,
      'v' + version + '  log ' + count + ' lines (' + sinkState() + ')',
    )
  },

  // One request/response to the Side Service. `quiet` keeps it off the hint line.
  probe(quiet) {
    if (!quiet) this.hint.setProperty(ui.prop.TEXT, 'asking the phone when it last heard from us...')
    let appId = 0
    try {
      appId = getPackageInfo().appId
    } catch (e) {}

    let mb = null
    const started = Date.now()
    try {
      mb = new MessageBuilder({ appId, appDevicePort: 20, appSidePort: 0, ble })
      mb.connect()
    } catch (e) {
      appendDevLog('probe construct fail ' + e)
      this.link.setProperty(ui.prop.TEXT, 'watch->phone: cannot start')
      return
    }

    mb.request({ t: 'probe', from: 'page' }, { timeout: 6000 })
      .then((res) => {
        const ms = Date.now() - started
        const since = res && typeof res.sinceDeviceMs === 'number' ? res.sinceDeviceMs : -1
        let text
        if (since < 0) {
          text = 'last tick: NONE this session'
          this.link.setProperty(ui.prop.COLOR, 0xff6b6b)
          appendDevLog('probe: link ok ' + ms + 'ms, no tick ever')
        } else {
          const seconds = Math.round(since / 1000)
          text = 'last tick: ' + seconds + 's ago'
          this.link.setProperty(ui.prop.COLOR, since < 150000 ? 0x8fd6a0 : 0xffcc66)
          appendDevLog('probe: ok ' + ms + 'ms, last tick ' + seconds + 's')
        }
        this.link.setProperty(ui.prop.TEXT, text)
        if (!quiet) this.hint.setProperty(ui.prop.TEXT, 'link ok ' + ms + 'ms')
      })
      .catch((err) => {
        const reason = (err && (err.reason || err.message)) || String(err)
        this.link.setProperty(ui.prop.TEXT, 'watch->phone: LINK FAIL')
        this.link.setProperty(ui.prop.COLOR, 0xff6b6b)
        appendDevLog('probe FAIL ' + String(reason).slice(0, 60))
        if (!quiet) this.hint.setProperty(ui.prop.TEXT, 'link failed: ' + String(reason).slice(0, 40))
      })
      .finally(() => {
        try {
          mb.disConnect()
        } catch (e) {}
      })
  },



  // Any failure is ALSO rendered as a notification: the hint line is 390 px wide
  // and the error strings are long, so a notification is the only place they can
  // actually be read on the watch.
  arm(mode, delaySec, show) {
    armNotifier((result) => {
      logger.log('arm', JSON.stringify(result))
      appendDevLog('arm ' + JSON.stringify(result))
      const verdict = result.ok ? 'ok ' + (result.shape || '') : 'FAIL'
      const detail =
        'id=' + (result.id !== undefined ? result.id : '-') +
        ' pend=' + (result.pending ? 'yes' : 'no') + '/' + (result.total || 0) +
        ' ' + mode + '/' + delaySec + 's' +
        (result.ok ? '' : ' ' + String(result.reason || '').slice(0, 70))
      this.hint.setProperty(ui.prop.TEXT, 'arm: ' + verdict + ' ' + detail.slice(0, 44))
      // Notifications, not the hint: this is the only stage that has been
      // invisible for a dozen builds, and it has to be readable on the watch.
      try {
        notify({
          title: 'Arm ' + verdict,
          content: detail.slice(0, 160),
          actions: [],
          vibrate: 3,
        })
      } catch (e) {}
      // Does the record survive the next couple of seconds? A set() that is
      // accepted and then dropped looks identical to one that never fired.
      const armedId = result.id
      setTimeout(() => {
        const still = pendingIds().indexOf(Number(armedId)) >= 0
        appendDevLog('armcheck id=' + armedId + ' pending=' + still)
        try {
          notify({
            title: 'Arm check ' + (still ? 'pending' : 'GONE'),
            content: 'id=' + armedId + ' pending=' + JSON.stringify(pendingIds()).slice(0, 100),
            actions: [],
            vibrate: 1,
          })
        } catch (e) {}
        this.refresh()
      }, 3000)
    }, { show: !!show, mode, delaySec })
  },

  cycleCadence() {
    let next = 60
    try {
      next = cycleCadence()
    } catch (e) {}
    try {
      appendDevLog('cadence ' + next + 's')
    } catch (e) {}
    this.refresh()
  },

  // Writes the UNFILTERED alarm table into the device log, 60 chars per line so
  // it can be paged on the watch. This is how we learn the real field names
  // instead of guessing at file/url/path.
  dumpAlarms(quiet) {
    const d = alarmDump()
    appendDevLog('alarms count=' + d.count)
    const json = d.json || ''
    for (let i = 0; i < json.length && i < 600; i += 60) {
      appendDevLog(json.slice(i, i + 60))
    }
    if (!quiet) {
      this.hint.setProperty(ui.prop.TEXT, 'dumped ' + d.count + ' pending (' + json.length + ' chars) -> log')
    }
  },

  // Renders the alarm API surface as a notification: no BLE, no service, no
  // alarm needed. Requests the permission first if it was never granted, so
  // `bg=` is always meaningful here rather than reflecting "never asked".
  diag() {
    const show = () => {
      const d = alarmDiag()
      const body =
        'set=' + d.set + ' list=' + d.list + ' get=' + d.get +
        ' rm=' + d.rm + ' once=' + d.once +
        ' bg=' + permissionState(BG_PERMISSION) + ' al=' + alarmPermissionState() +
        ' pend=' + JSON.stringify(d.pending) + ' ours=' + JSON.stringify(d.ours)
      try {
        notify({ title: 'Alarm diag', content: body.slice(0, 160), actions: [], vibrate: 2 })
      } catch (e) {}
      appendDevLog('diag ' + body)
      this.dumpAlarms(true)
      this.hint.setProperty(ui.prop.TEXT, 'diag: ' + body.slice(0, 60))
      this.refresh()
    }
    if (permissionState(BG_PERMISSION) === 2 && alarmPermissionState() === 2) return show()
    ensureBgPermission(show)
  },

  // Stop everything. This method was MISSING: the button called this.disarm(),
  // which threw, so the alarm table could not be cleared from the UI and the
  // status header never changed. (undef-check validates identifiers, not
  // this.method() calls - that is why it passed.)
  disarm() {
    const result = disarmNotifier() || {}
    appendDevLog('disarm ' + JSON.stringify(result).slice(0, 100))
    const pending = JSON.stringify(result.pending || []).slice(0, 26)
    this.hint.setProperty(
      ui.prop.TEXT,
      'disarm: cancelled=' + (result.cancelled || 0) + ' swept=' + (result.swept || 0) + ' pending=' + pending,
    )
    this.refresh()
  },

  // Start the service by hand once. Diagnostics only: a start()-ed instance is
  // CONTINUOUS, and one that never exits occupies the single App Service slot -
  // hence the "wedges" label on the button.
  startTick() {
    startTickOnce('via=manual&mode=oneshot', (result) => {
      appendDevLog('startTick ' + JSON.stringify(result))
      this.hint.setProperty(ui.prop.TEXT, 'start: ' + JSON.stringify(result).slice(0, 46))
      this.refresh()
    })
  },
})
