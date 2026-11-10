// Harness test for the tap path in app-service/notifier.js.
//
// Runs the REAL notifier against the REAL vendored wire library (shared/message.js)
// with every @zos/* module stubbed, one module instance per simulated wake. That is
// the only property of the runtime that matters here: a wake is a fresh JS context,
// and only localStorage survives it.
//
// What it pins down, because each one shipped as a bug found only on a wrist:
//
//   * a tap is recorded in storage BEFORE any BLE work, so a wake that never gets a
//     handshake loses nothing
//   * a tap is handled even when the tick is disarmed
//   * a queued tap is retried on a later alarm wake and dropped only once the phone
//     answers
//   * telemetry (tick.wake, tap.received, tap-no-id) is queued and only flushed once a
//     link exists, and is not lost when a wake cannot reach the phone
//
//     node tools/test-tap.mjs          # exit 0 = all pass
//     node tools/test-tap.mjs -v       # show every assertion
//
// No dependencies beyond acorn-free plain node: the module transform below is a
// two-regex ESM flattening, not a bundler.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'

// The pure shared modules load normally: only @zos/* needs stubbing.
const deferModule = await import('../shared/defer.js')
const dataModule = await import('../shared/data.js')
const eventModule = await import('../shared/event.js')
const protocolModule = await import('../shared/protocol.js')
const { json2buf } = dataModule

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VERBOSE = process.argv.includes('-v')

const APP_ID = 10262217
const SIDE_PORT = 1018

const MessageType = { Shake: 0x1, Data: 0x4 }
const MessagePayloadType = { Request: 0x1, Response: 0x2, Notify: 0x3 }
const PayloadType = { EMPTY: 0x0, TEXT: 0x1, JSON: 0x2, BIN: 0x3 }
const OP_FINISHED = 0x1

let passed = 0
const failed = []

function check(name, condition, detail) {
  if (condition) {
    passed++
    if (VERBOSE) console.log('  ok   ' + name)
  } else {
    failed.push(name + (detail ? ' :: ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
  }
}

// --- module loading ---------------------------------------------------------

// Flatten ESM into a Function body: `import` -> destructuring from __stubs, `export`
// stripped. Only the two files below need it; everything else is imported normally.
function flatten(file) {
  return readFileSync(file, 'utf8')
    .replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)'$/gm, (m, name, spec) => {
      return 'const ' + name + ' = __stubs[' + JSON.stringify(spec) + ']'
    })
    .replace(/^import\s+\{([^}]+)\}\s+from\s+'([^']+)'$/gm, (m, names, spec) => {
      const bindings = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const parts = s.split(/\s+as\s+/)
          return parts.length > 1 ? parts[0].trim() + ': ' + parts[1].trim() : parts[0].trim()
        })
        .join(', ')
      return 'const { ' + bindings + ' } = __stubs[' + JSON.stringify(spec) + ']'
    })
    .replace(/^export\s+/gm, '')
}

function instantiate(file, stubs, expose) {
  const body = flatten(file) + '\nreturn {' + expose.join(',') + '}'
  // eslint-disable-next-line no-new-func
  return new Function('__stubs', body)(stubs)
}

// --- fakes ------------------------------------------------------------------

function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v))
    },
    removeItem: (k) => {
      map.delete(k)
    },
    dump: () => Object.fromEntries(map),
    raw: map,
  }
}

const utilsStub = (EventBus) => ({
  EventBus,
  log: { getLogger: () => ({ log() {}, warn() {}, error() {}, debug() {} }) },
})

// Telemetry is deliberately not durable, so the sim does not need storage across wakes:
// what must survive is the carry alarm, and that is asserted directly.
function makeWatch(options = {}) {
  const opts = Object.assign({ respondShake: true, respondRequest: true, items: [], cancel: [] }, options)
  const storage = opts.storage || fakeStorage()
  const state = {
    frames: [], // decoded outbound frames
    notifications: [],
    cancelled: [],
    devlog: [],
    inbound: null,
    armedCalls: 0,
    pending: [], // what getAllAlarms() reports: fence + any live chain alarm
    carries: [], // setCarryAlarm() calls
    cancelledAlarms: [], // cancelAlarm() calls
    nextAlarmId: 500,
  }

  // A second builder from the same library is the easiest way to build a
  // protocol-correct reply: it is the code the phone would run.
  const wire = instantiate(
    join(ROOT, 'shared/message.js'),
    {
      '@zos/utils': utilsStub(eventModule.EventBus),
      './defer': deferModule,
      './data': dataModule,
    },
    ['MessageBuilder', 'MessageType', 'MessagePayloadType', 'MessagePayloadDataTypeOp', 'MessageFlag']
  )
  const helper = new wire.MessageBuilder({ appId: APP_ID, ble: { send() { return true }, createConnect() {} } })
  return { opts, storage, state, wire, helper }
}

async function runWake(watch, param) {
  const { storage, state, opts, helper } = watch
  const EventBus = eventModule.EventBus
  const protocol = protocolModule

  let captured = null

  const ble = {
    getStatus: () => 1,
    createConnect: (cb) => {
      state.inbound = cb
    },
    send: (buf, len) => {
      const frame = Buffer.from(buf, 0, len)
      const type = frame.readUInt16LE(2)
      const port2 = frame.readUInt16LE(6)
      if (type === MessageType.Shake) {
        state.frames.push({ type: 'shake', port2 })
        if (opts.respondShake) {
          const reply = Buffer.alloc(17)
          reply.writeUInt8(0x1, 0)
          reply.writeUInt8(0x1, 1)
          reply.writeUInt16LE(MessageType.Shake, 2)
          reply.writeUInt16LE(20, 4)
          reply.writeUInt16LE(SIDE_PORT, 6)
          reply.writeUInt32LE(APP_ID, 8)
          reply.writeUInt32LE(0, 12)
          reply.writeUInt8(APP_ID & 0xff, 16)
          state.inbound(0, reply, reply.byteLength)
        }
        return true
      }

      if (type !== MessageType.Data) return true

      // HM protocol payload: 66-byte header, then the JSON body.
      const traceId = frame.readUInt32LE(16)
      const payloadLength = frame.readUInt32LE(36)
      const payloadType = frame.readUInt8(40)
      const body = frame.subarray(82, 82 + payloadLength)
      let json = null
      try {
        json = JSON.parse(body.toString('utf8'))
      } catch (e) {}
      state.frames.push({ type: 'data', port2, payloadType, traceId, json })

      if (!opts.respondRequest) return true
      const answer =
        json && json.t === protocol.MSG.POLL ? { items: opts.items || [], cancel: opts.cancel || [] } : { ok: true }
      const data = json2buf(answer)
      const payload = helper.buildPayload({
        traceId,
        spanId: 1,
        seqId: 1,
        totalLength: data.byteLength,
        payload: data,
        type: MessagePayloadType.Response,
        opCode: OP_FINISHED,
        contentType: PayloadType.JSON,
        dataType: PayloadType.JSON,
      })
      const reply = helper.buildData(payload, { type: MessageType.Data })
      state.inbound(0, reply, reply.byteLength)
      return true
    },
  }

  const stubs = {
    '@zos/utils': utilsStub(EventBus),
    '@zos/ble': Object.assign(ble, { connectStatus: () => true }),
    '@zos/app': { getPackageInfo: () => ({ appId: APP_ID }) },
    '@zos/notification': {
      notify: (o) => {
        state.notifications.push(o)
        return state.notifications.length + 100
      },
      cancel: (ids) => {
        state.cancelled.push(ids)
        return true
      },
    },
    '@zos/storage': { localStorage: storage },
    '@zos/fs': { readFileSync: () => '', writeFileSync: () => true },
    '../shared/message': instantiate(
      join(ROOT, 'shared/message.js'),
      {
        '@zos/utils': utilsStub(EventBus),
        './defer': deferModule,
        './data': dataModule,
      },
      ['MessageBuilder', 'MessagePayloadType', 'MessagePayloadDataTypeOp', 'genTraceId']
    ),
    '../shared/protocol': protocol,
    '../shared/alarm': {
      armNext: () => {
        state.armedCalls++
        return { ok: true, id: 1, shape: 'repeat' }
      },
      armNextOneshot: () => {
        state.armedCalls++
        state.pending.push(1000 + state.armedCalls) // one chain alarm, consumed when it fires
        return { ok: true, id: 1000 + state.armedCalls, shape: 'url-delay' }
      },
      pendingIds: () => state.pending.slice(),
      cancelAllTickAlarms: () => {
        state.pending = []
      },
      setCarryAlarm: (p, delay) => {
        const entry = { param: p, delaySec: delay, id: state.nextAlarmId++ }
        state.carries.push(entry)
        return { ok: true, id: entry.id }
      },
      cancelAlarm: (id) => {
        state.cancelledAlarms.push(id)
        return true
      },
    },
    '../shared/devlog': {
      append: (m) => {
        state.devlog.push(m)
        return true
      },
    },
  }

  globalThis.__ZEPPOS__ = 1
  globalThis.AppService = (def) => {
    captured = def
  }
  instantiate(join(ROOT, 'app-service/notifier.js'), stubs, [])
  if (!captured) throw new Error('notifier did not register an AppService')

  captured.onInit(param)
  // One macrotask: every await/then in this runtime settles well within it because the
  // fakes answer synchronously.
  await new Promise((resolve) => setImmediate(resolve))
  return state
}


const logs = (state, name) => state.frames.filter((f) => f.type === 'data' && f.json && f.json.e === name)
const reqs = (state, t) => state.frames.filter((f) => f.type === 'data' && f.json && f.json.t === t)

// --- tests ------------------------------------------------------------------

const TAP = 'i=18-93cebd&a=taken&via=tap'
const tsOf = (param) => Number((String(param).match(/(?:^|&)ts=(\d+)/) || [])[1])

console.log('tap: a press acks even when the tick is disarmed')
{
  const w = makeWatch({ storage: fakeStorage({ relay_armed: '0' }) })
  const st = await runWake(w, TAP)
  check('disarmed app still sends the ack', reqs(st, 'a').length === 1, JSON.stringify(st.frames))
  check(
    'ack carries id and action',
    (reqs(st, 'a')[0] || {}).json.i === '18-93cebd' && reqs(st, 'a')[0].json.a === 'taken',
    JSON.stringify(reqs(st, 'a'))
  )
  check('disarmed app does not re-arm the tick chain', st.armedCalls === 0, String(st.armedCalls))
  check('tap.received is reported', logs(st, 'tap.received').length === 1, JSON.stringify(st.frames))
  check('tap.sent is reported with a lag', logs(st, 'tap.sent').length === 1 && logs(st, 'tap.sent')[0].json.lag >= 0)
  check('a retry was armed first, then cancelled on the receipt',
    st.carries.length === 1 && st.cancelledAlarms.length === 1 && st.cancelledAlarms[0] === st.carries[0].id,
    JSON.stringify({ carries: st.carries, cancelled: st.cancelledAlarms }))
}

console.log('\ntap: the next attempt is armed BEFORE the link is touched')
{
  // The measured failure: the side never answers the shake, the wake is reaped, and no
  // storage it wrote survives the context. The alarm is the only thing that carries.
  const w = makeWatch({ respondShake: false })
  const st = await runWake(w, TAP)
  check('a carry alarm is armed', st.carries.length === 1, JSON.stringify(st.carries))
  check(
    'it carries id, action, press time and attempt',
    /^retry=1&i=18-93cebd&a=taken&ts=\d+&n=1$/.test((st.carries[0] || {}).param || ''),
    (st.carries[0] || {}).param
  )
  check('the first retry is 90 s out', (st.carries[0] || {}).delaySec === 90, String((st.carries[0] || {}).delaySec))
  check('nothing was sent into the dead link', st.frames.filter((f) => f.type === 'data').length === 0, JSON.stringify(st.frames))
  check('the alarm it just armed was not cancelled', st.cancelledAlarms.length === 0, JSON.stringify(st.cancelledAlarms))
}

console.log('\ntap: the retry wake answers the press and stops the chain')
{
  const dead = makeWatch({ respondShake: false })
  const first = await runWake(dead, TAP)
  const param = first.carries[0].param

  const live = makeWatch()
  const st = await runWake(live, param)
  check('the carried param is dispatched as a tap', reqs(st, 'a').length === 1, JSON.stringify(st.frames))
  const ack = reqs(st, 'a')[0].json
  check('it keeps the original id and action', ack.i === '18-93cebd' && ack.a === 'taken', JSON.stringify(ack))
  check('it keeps the ORIGINAL press time', ack.ts === tsOf(param), `${ack.ts} vs ${tsOf(param)}`)
  check('it reports tap.received with the attempt', logs(st, 'tap.received').length === 1 && logs(st, 'tap.received')[0].json.try === 1, JSON.stringify(st.frames.map((f) => f.json && f.json.e)))
  check('it reports tap.retry', logs(st, 'tap.retry').length === 1, JSON.stringify(st.frames.map((f) => f.json && f.json.e)))
  check('the lag measures from the original press', logs(st, 'tap.sent').length === 1 && logs(st, 'tap.sent')[0].json.lag >= 0)
  check('the next attempt is armed then cancelled',
    st.carries.length === 1 && st.cancelledAlarms[0] === st.carries[0].id,
    JSON.stringify({ carries: st.carries, cancelled: st.cancelledAlarms }))
  check('a retry wake does not poll', reqs(st, 'poll').length === 0, JSON.stringify(reqs(st, 'poll')))
  check('the attempt number advances', /n=2$/.test(st.carries[0].param), st.carries[0].param)
}

console.log('\ntap: an unanswered ack keeps the chain armed')
{
  // Handshake fine, the phone never answers the ack request. The next attempt must stay
  // in the OS, or this is the loss the whole change exists to prevent.
  const mute = makeWatch({ respondRequest: false })
  const st = await runWake(mute, TAP)
  check('the ack was sent', reqs(st, 'a').length === 1, JSON.stringify(st.frames))
  check('the armed attempt is NOT cancelled', st.cancelledAlarms.length === 0, JSON.stringify(st.cancelledAlarms))
  check('the relay saw tap.received', logs(st, 'tap.received').length === 1)
  check('...and no tap.sent, which is what names the gap', logs(st, 'tap.sent').length === 0)
}

console.log('\ntap: retries stop at the bound')
{
  const w = makeWatch({ respondShake: false })
  const st = await runWake(w, 'retry=1&i=18-93cebd&a=taken&ts=1794281003964&n=40')
  check('no further alarm is armed at the bound', st.carries.length === 0, JSON.stringify(st.carries))
  check('the exhaustion is logged on the watch', st.devlog.some((l) => l.indexOf('retries exhausted') >= 0), JSON.stringify(st.devlog))
}

console.log('\ntap: an unparseable press is still visible')
{
  const w = makeWatch()
  const st = await runWake(w, 'i=&a=taken')
  check('tap-no-id reaches the relay on the same wake', logs(st, 'tap-no-id').length === 1, JSON.stringify(st.frames.map((f) => f.json && f.json.e)))
  check('tap-no-id sends no ack', reqs(st, 'a').length === 0)
  check('tap-no-id arms no retry', st.carries.length === 0, JSON.stringify(st.carries))
}

console.log('\nfence: a repeating alarm that revives a dead chain and never stacks one')
{
  // Fence wake with only the fence pending: the chain's next alarm is gone -> re-arm it.
  const dead = makeWatch()
  dead.state.pending = [900] // the fence itself
  const st = await runWake(dead, 'via=alarm&mode=oneshot&fence=1')
  check('a dead chain is revived exactly once', st.armedCalls === 1, String(st.armedCalls))
  check('the fence did not re-arm itself (no repeat alarm)', st.frames.every((f) => !(f.json && f.json.e === 'tick.fence' && f.json.repeat)), JSON.stringify(st.frames))
  check('tick.fence is reported', logs(st, 'tick.fence').length === 1, JSON.stringify(st.frames.map((f) => f.json && f.json.e)))
  const tel = (logs(st, 'tick.fence')[0] || {}).json || {}
  check('tick.fence carries the pending count and the verdict', tel.pending === 1 && tel.alive === 0 && tel.revived === 1, JSON.stringify(tel))
  check('a fence wake still polls', reqs(st, 'poll').length === 1, JSON.stringify(reqs(st, 'poll')))

  // Fence wake with fence + chain both pending: nothing to do, and above all no extra
  // chain alarm - that would double the wake rate for the rest of the night.
  const alive = makeWatch()
  alive.state.pending = [900, 1001]
  const st2 = await runWake(alive, 'via=alarm&mode=oneshot&fence=1')
  check('a live chain is left alone', st2.armedCalls === 0, String(st2.armedCalls))
  const tel2 = (logs(st2, 'tick.fence')[0] || {}).json || {}
  check('tick.fence says alive', tel2.alive === 1 && tel2.revived === 0, JSON.stringify(tel2))
  check('the fence wake still delivers', reqs(st2, 'poll').length === 1)
}

console.log('\ntelemetry: tick.wake is observable (defect 4)')
{
  const w = makeWatch()
  const st = await runWake(w, 'via=alarm&mode=oneshot&show=0')
  const wakes = logs(st, 'tick.wake')
  check('tick.wake is sent after the handshake', wakes.length === 1, JSON.stringify(st.frames))
  check('tick.wake carries the chain verdict', wakes.length === 1 && typeof wakes[0].json.chain === 'string', JSON.stringify(wakes))
  check('tick.wake is sent with the learned side port', wakes.length === 1 && wakes[0].port2 === SIDE_PORT, wakes.length ? String(wakes[0].port2) : '-')
  check('dispatch is one poll', reqs(st, 'poll').length === 1)
}

console.log('\ntelemetry: a wake with no link cannot report, and does not pretend to')
{
  const w = makeWatch({ respondShake: false })
  const st = await runWake(w, 'via=alarm&mode=oneshot&show=0')
  check('nothing left the watch', st.frames.filter((f) => f.type === 'data').length === 0, JSON.stringify(st.frames))
  // The handshake never settles, so the callback never runs: the wake is reaped with its
  // buffered telemetry. The chain must still have been re-armed before BLE, or a dead
  // link would end the tick forever.
  check('the chain was re-armed before the link was touched', st.armedCalls === 1, String(st.armedCalls))
}

console.log('\nboot: a disarmed tick still exits without BLE work')
{
  const w = makeWatch({ storage: fakeStorage({ relay_armed: '0' }) })
  const st = await runWake(w, 'via=alarm&mode=oneshot&show=0')
  check('disarmed tick sends no frames', st.frames.length === 0, JSON.stringify(st.frames))
  check('disarmed tick does not re-arm', st.armedCalls === 0, String(st.armedCalls))
}

console.log('\n%d passed, %d failed', passed, failed.length)
for (const f of failed) console.log('  - ' + f)
process.exit(failed.length ? 1 : 0)
