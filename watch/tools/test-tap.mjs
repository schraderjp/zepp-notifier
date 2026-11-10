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
const outboxModule = await import('../shared/outbox.js')
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

// One simulated watch: a fresh notifier module per wake, one storage across wakes,
// and a BLE link whose behaviour each test controls.
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
  const outbox = outboxModule
  const alarm = await import('../shared/alarm.js').catch(() => null)

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
        return { ok: true, id: 1, shape: 'oneshot' }
      },
      pendingIds: () => [],
      cancelAllTickAlarms: () => {},
    },
    '../shared/devlog': {
      append: (m) => {
        state.devlog.push(m)
        return true
      },
    },
    '../shared/outbox': outbox,
  }
  if (alarm) stubs['../shared/alarm'] = alarm

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

function queue(storage, key) {
  try {
    const list = JSON.parse(storage.getItem(key) || '[]')
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

const logs = (state, name) => state.frames.filter((f) => f.type === 'data' && f.json && f.json.e === name)
const reqs = (state, t) => state.frames.filter((f) => f.type === 'data' && f.json && f.json.t === t)

// --- tests ------------------------------------------------------------------

const TAP = 'i=18-93cebd&a=taken&via=tap'

console.log('tap: a press is durable before any BLE work, and never gated on arming')
{
  // Defect 2: the tick is disarmed, the user presses a button anyway.
  const storage = fakeStorage({ relay_armed: '0' })
  const w = makeWatch({ storage })
  const st = await runWake(w, TAP)
  check('disarmed app still sends the ack', reqs(st, 'a').length === 1, JSON.stringify(st.frames))
  check('ack carries id and action', (reqs(st, 'a')[0] || {}).json.i === '18-93cebd' && reqs(st, 'a')[0].json.a === 'taken')
  check('disarmed app does not re-arm the chain', st.armedCalls === 0, String(st.armedCalls))
  check('answered ack leaves the queue empty', queue(storage, 'relay_ackq').length === 0, storage.getItem('relay_ackq'))
  check('tap.sent is reported to the relay', logs(st, 'tap.sent').length === 1, JSON.stringify(st.frames))
  check('tap.received is reported before it', logs(st, 'tap.received').length === 1)
}

console.log('\ntap: a wake that never shakes loses nothing')
{
  // Defect 1/3: Bluetooth is there but the handshake never completes. The old code
  // dropped the tap here with a local devLog nobody could read.
  const storage = fakeStorage()
  const w = makeWatch({ storage, respondShake: false })
  const st = await runWake(w, TAP)
  const q = queue(storage, 'relay_ackq')
  check('tap is queued in storage', q.length === 1 && q[0].i === '18-93cebd', JSON.stringify(q))
  check('no ack frame was sent', reqs(st, 'a').length === 0, JSON.stringify(st.frames))
  // The handshake promise never settles when the phone is silent, so the callback never
  // runs and no failure log is written either - the OS reaps the wake. What names the
  // gap is a queued tap.received with no tap.sent beside it.
  check(
    'the press is still recorded as received',
    queue(storage, 'relay_logq').some((e) => e.e === 'tap.received'),
    storage.getItem('relay_logq')
  )
  check('no telemetry was sent into a dead link', st.frames.filter((f) => f.type === 'data').length === 0, JSON.stringify(st.frames))
}

console.log('\ntap: the same press twice is one queued answer')
{
  const storage = fakeStorage()
  const dead = makeWatch({ storage, respondShake: false })
  await runWake(dead, TAP)
  await runWake(dead, TAP)
  check('duplicate taps collapse', queue(storage, 'relay_ackq').length === 1, storage.getItem('relay_ackq'))
}

console.log('\ntap: the next alarm wake retries it and stops only on a receipt')
{
  // The queued tap from the previous scenario, drained by a later poll wake.
  const storage = fakeStorage()
  const dead = makeWatch({ storage, respondShake: false })
  await runWake(dead, TAP)

  const live = makeWatch({ storage })
  const st = await runWake(live, 'via=alarm&mode=oneshot&show=0')
  check('retried ack is sent on the next wake', reqs(st, 'a').length === 1, JSON.stringify(st.frames))
  check('retried ack keeps its original id/action', (reqs(st, 'a')[0] || {}).json.i === '18-93cebd')
  check('queue is empty once the phone answered', queue(storage, 'relay_ackq').length === 0, storage.getItem('relay_ackq'))
  check('tap.sent follows the retry', logs(st, 'tap.sent').length === 1, JSON.stringify(st.frames))
  check('the wake still polled', reqs(st, 'poll').length === 1)
}

console.log('\ntap: an unreachable ack stays queued (at-least-once, not at-most-once)')
{
  const storage = fakeStorage()
  // Handshake works, but the phone never answers the ack request.
  const mute = makeWatch({ storage, respondRequest: false })
  const st = await runWake(mute, TAP)
  check('ack survives a missing answer', queue(storage, 'relay_ackq').length === 1, storage.getItem('relay_ackq'))
  check('the relay saw tap.received', logs(st, 'tap.received').length === 1, JSON.stringify(st.frames))
  check('...and no tap.sent, which is what names the gap', logs(st, 'tap.sent').length === 0, JSON.stringify(st.frames))
}

console.log('\ntap: an unparseable press is still visible')
{
  const storage = fakeStorage()
  const w = makeWatch({ storage })
  const st = await runWake(w, 'i=&a=taken')
  check('tap-no-id is queued', queue(storage, 'relay_logq').some((e) => e.e === 'tap-no-id'), storage.getItem('relay_logq'))
  check('tap-no-id sends no ack', reqs(st, 'a').length === 0, JSON.stringify(st.frames))

  const live = makeWatch({ storage })
  const st2 = await runWake(live, 'via=alarm&mode=oneshot&show=0')
  check('tap-no-id reaches the relay on the next wake', logs(st2, 'tap-no-id').length === 1, JSON.stringify(st2.frames))
}

console.log('\ntelemetry: tick.wake is observable (defect 4)')
{
  const storage = fakeStorage()
  const w = makeWatch({ storage })
  const st = await runWake(w, 'via=alarm&mode=oneshot&show=0')
  const wakes = logs(st, 'tick.wake')
  check('tick.wake is sent after the handshake', wakes.length === 1, JSON.stringify(st.frames))
  check('tick.wake carries the chain verdict', wakes.length === 1 && typeof wakes[0].json.chain === 'string', JSON.stringify(wakes))
  check('tick.wake is sent with the learned side port', wakes.length === 1 && wakes[0].port2 === SIDE_PORT, wakes.length ? String(wakes[0].port2) : '-')
  check('log queue is empty afterwards', queue(storage, 'relay_logq').length === 0, storage.getItem('relay_logq'))
  check('dispatch is one poll', reqs(st, 'poll').length === 1)
}

console.log('\ntelemetry: a wake with no link reports on the next one instead of vanishing')
{
  const storage = fakeStorage()
  const dead = makeWatch({ storage, respondShake: false })
  const st0 = await runWake(dead, 'via=alarm&mode=oneshot&show=0')
  check('tick.wake is kept for later', queue(storage, 'relay_logq').some((e) => e.e === 'tick.wake'), storage.getItem('relay_logq'))
  check('nothing left the watch', st0.frames.filter((f) => f.type === 'data').length === 0, JSON.stringify(st0.frames))

  const live = makeWatch({ storage })
  const st = await runWake(live, 'via=alarm&mode=oneshot&show=0')
  check('the backlog is flushed once a link exists', logs(st, 'tick.wake').length >= 1, JSON.stringify(st.frames.map((f) => f.json && f.json.e)))
  check('the backlog does not survive the flush', queue(storage, 'relay_logq').length === 0, storage.getItem('relay_logq'))
}

console.log('\nboot: a disarmed tick still exits without BLE work')
{
  const storage = fakeStorage({ relay_armed: '0' })
  const w = makeWatch({ storage })
  const st = await runWake(w, 'via=alarm&mode=oneshot&show=0')
  check('disarmed tick sends no frames', st.frames.length === 0, JSON.stringify(st.frames))
  check('disarmed tick does not re-arm', st.armedCalls === 0, String(st.armedCalls))
}

console.log('\nqueue mechanics (shared/outbox.js)')
{
  const { createOutbox } = outboxModule
  const storage = fakeStorage()
  const acks = createOutbox(storage, 'q', 3, (e) => e.i + '|' + e.a)
  acks.push({ i: '1', a: 'yes', ts: 1 })
  acks.push({ i: '1', a: 'yes', ts: 2 })
  check('same (id, action) replaces, not duplicates', acks.size() === 1, storage.getItem('q'))
  check('the newer press wins', acks.list()[0].ts === 2, storage.getItem('q'))
  acks.push({ i: '2', a: 'no', ts: 3 })
  acks.push({ i: '3', a: 'no', ts: 4 })
  acks.push({ i: '4', a: 'no', ts: 5 })
  check('cap keeps the newest entries', acks.size() === 3 && acks.list()[2].i === '4', storage.getItem('q'))
  check('take(n) drops exactly what was handed over', acks.take(2) === 1 && acks.list()[0].i === '4', storage.getItem('q'))
  storage.setItem('q', '{not json')
  check('corrupt storage is read as empty, not fatal', acks.size() === 0, storage.getItem('q'))

  const logsQ = createOutbox(storage, 'l', 2, null)
  logsQ.push({ e: 'a' })
  logsQ.push({ e: 'b' })
  logsQ.push({ e: 'c' })
  check('append-only queue drops the oldest', logsQ.list().map((x) => x.e).join('') === 'bc', storage.getItem('l'))
}

console.log('\n%d passed, %d failed', passed, failed.length)
for (const f of failed) console.log('  - ' + f)
process.exit(failed.length ? 1 : 0)
