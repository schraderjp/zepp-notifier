// Device log viewer.
//
// Separate page because the ring buffer holds up to 40 lines and the control
// panel has no room left: 12 lines per page with Older/Newer paging, which is
// more predictable than a scroll list on a 390x450 screen.
//
// This page is the only way to see what the watch did while the BLE channel was
// dead, so it must keep working without the phone.

import * as ui from '@zos/ui'
import { read as readDevLog, sinkState } from '../shared/devlog'

const MARGIN = 12
const CONTENT_W = 390 - 2 * MARGIN
const LINES_PER_PAGE = 12

Page({
  onInit() {
    this.offset = 0
    this.lines = []
  },

  build() {
    try {
      if (typeof ui.setStatusBarVisible === 'function') ui.setStatusBarVisible(false)
    } catch (e) {}

    this.header = ui.createWidget(ui.widget.TEXT, {
      x: MARGIN,
      y: 12,
      w: CONTENT_W,
      h: 22,
      text: '',
      text_size: 15,
      color: 0x9aa4ad,
    })

    this.body = ui.createWidget(ui.widget.TEXT, {
      x: MARGIN,
      y: 38,
      w: CONTENT_W,
      h: 258,
      text: '',
      text_size: 13,
      color: 0x8fd6a0,
      text_style: ui.text_style.WRAP,
      align_h: ui.align.LEFT,
    })

    const button = (y, text, onClick) =>
      ui.createWidget(ui.widget.BUTTON, {
        x: MARGIN,
        y,
        w: CONTENT_W,
        h: 40,
        radius: 10,
        text,
        text_size: 19,
        normal_color: 0x245884,
        press_color: 0x387eac,
        color: 0xffffff,
        click_func: onClick,
      })

    button(304, 'Older  ▲', () => this.page(1))
    button(350, 'Newer  ▼', () => this.page(-1))
    button(396, 'Reload', () => this.reload())

    this.reload()
  },

  page(direction) {
    const maxOffset = Math.max(0, this.lines.length - LINES_PER_PAGE)
    this.offset = Math.min(maxOffset, Math.max(0, this.offset + direction * LINES_PER_PAGE))
    this.render()
  },

  reload() {
    this.lines = readDevLog()
    this.render()
  },

  render() {
    const total = this.lines.length
    // offset 0 shows the newest lines
    const end = total - this.offset
    const start = Math.max(0, end - LINES_PER_PAGE)
    const slice = this.lines.slice(start, end)

    this.header.setProperty(
      ui.prop.TEXT,
      total
        ? total + ' lines · ' + (start + 1) + '-' + end + ' · ' + sinkState()
        : 'log empty · sinks ' + sinkState()
    )
    this.body.setProperty(ui.prop.TEXT, slice.length ? slice.join('\n') : 'nothing logged yet')
  },
})
