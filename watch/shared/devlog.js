// On-device log ring buffer.
//
// Everything the phone-side observer knows arrives over the very BLE channel that
// keeps dying, so device-side failures were invisible: a failed `ble.send()`
// threw, we logged it to the watch console, and nobody could ever read it.
//
// Two sinks, because neither is reliable on its own:
//   * localStorage - works with the screen on (it is what the page already uses
//     for the armed flag), so interactive debugging is possible
//   * a file       - survives longer, but @zos/fs writes are only permitted while
//     the screen is off / AOD, which is exactly when alarms wake the service
//
// Whichever sink has more lines wins on read, and the page shows which sinks
// accepted a write so a silent failure is visible instead of looking like "no
// events happened".

import { localStorage } from '@zos/storage'
import { readFileSync, writeFileSync } from '@zos/fs'

const KEY = 'relay_devlog'
const SINK_KEY = 'relay_devlog_sink'
const PATH = 'relay-dev.log'
const MAX_LINES = 40

function stamp() {
  try {
    const d = new Date()
    const pad = (n) => (n < 10 ? '0' + n : '' + n)
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  } catch (e) {
    return '--:--:--'
  }
}

function trim(lines) {
  while (lines.length > MAX_LINES) lines.shift()
  return lines
}

function readStorage() {
  try {
    const raw = localStorage.getItem(KEY)
    if (typeof raw === 'string' && raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.filter((line) => typeof line === 'string')
    }
  } catch (e) {}
  return []
}

function writeStorage(lines) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines))
    return true
  } catch (e) {
    return false
  }
}

function readFile() {
  try {
    const raw = readFileSync({ path: PATH, options: { encoding: 'utf8' } })
    if (typeof raw === 'string' && raw) return raw.split('\n').filter((line) => line)
  } catch (e) {}
  return []
}

function writeFile(lines) {
  try {
    writeFileSync({ path: PATH, data: lines.join('\n'), options: { encoding: 'utf8' } })
    return true
  } catch (e) {
    return false
  }
}

export function append(message) {
  const line = stamp() + ' ' + String(message).slice(0, 120)

  // Build on the longest existing history so a working sink is never truncated
  // by a later read of a shorter one.
  const fromStorage = readStorage()
  const fromFile = readFile()
  const base = fromStorage.length >= fromFile.length ? fromStorage.slice() : fromFile.slice()
  base.push(line)
  trim(base)

  const okStorage = writeStorage(base)
  const okFile = writeFile(base)

  try {
    localStorage.setItem(SINK_KEY, (okStorage ? 'localStorage' : '-') + '/' + (okFile ? 'file' : '-'))
  } catch (e) {}
  return okStorage || okFile
}

export function read() {
  const fromStorage = readStorage()
  const fromFile = readFile()
  return fromStorage.length >= fromFile.length ? fromStorage : fromFile
}

export function sinkState() {
  try {
    return String(localStorage.getItem(SINK_KEY) || 'unknown')
  } catch (e) {
    return 'unknown'
  }
}

export function clear() {
  writeStorage([])
  writeFile([])
}
