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
    exits: 0, // app-service exit() calls
    pending: [], // what getAllAlarms() reports: fence + any live chain alarm
    fences: [], // setFenceAlarm() calls
    repeatFences: [], // setRepeatFence() calls
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
      // `respondAck: false` models the measured failure: the side receives the ack, records it
      // at the relay, and the reply never reaches the watch.
      if (json && json.t === protocol.MSG.ACK && opts.respondAck === false) return true
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
    '@zos/app-service': {
      exit: () => {
        state.exits++
      },
    },
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
      repeatMinuteValue: () => 1,
      repeatTypeInfo: () => ({ rm: 1, src: 'const' }),
      setHeartbeatAlarm: () => ({ ok: true, id: 777 }),
      pendingIds: () => state.pending.slice(),
      setHeartbeat: (v) => ({ ok: true, id: 900 + (v && v.tag ? 1 : 0), tag: v && v.tag }),
      setHeartbeatEnd: () => ({ ok: true, id: 999 }),
      setRepeatFence: (periodMin) => {
        const entry = { periodMin: periodMin === undefined ? 10 : periodMin, id: state.nextAlarmId++ }
        state.repeatFences.push(entry)
        return { ok: true, id: entry.id, rm: 1, period: entry.periodMin, pendingNow: true }
      },
      setFenceAlarm: (delaySec) => {
        const entry = { delaySec: delaySec === undefined ? 300 : delaySec, id: state.nextAlarmId++ }
        state.fences.push(entry)
        state.pending.push(entry.id)
        return { ok: true, id: entry.id, delaySec: entry.delaySec }
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

  if (opts.viaEvent) captured.onEvent(param)
  else captured.onInit(param)
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

console.log('\ntap: a dispatch is reported even when the reply never comes back')
{
  // Measured 2026-11-10: from 0.9.5 the watch never received the side's ack reply, so every
  // press retried its whole ladder for an answer the relay had recorded on the first frame,
  // and the log showed neither tap.sent nor a failure - silence that read like "never sent".
  // The dispatch is now its own fire-and-forget fact, immune to that.
  const w = makeWatch()
  const st = await runWake(w, TAP)
  const sent = logs(st, 'tap.ack-sent')
  check('the dispatch of an ack is logged', sent.length === 1, String(sent.length))
  check('it names the press and the attempt', sent[0] && sent[0].json.i === '18-93cebd' && sent[0].json.try === 0, JSON.stringify(sent[0] && sent[0].json))

  // Unanswered: the dispatch is still reported, and there is no tap.sent.
  const dead = await runWake(makeWatch({ respondAck: false }), TAP)
  check('an unanswered ack still reports the dispatch', logs(dead, 'tap.ack-sent').length === 1, '')
  check('an unanswered ack shows no tap.sent', logs(dead, 'tap.sent').length === 0, '')
  check('an unanswered ack keeps the carrier armed', dead.carries.length === 1 && dead.cancelledAlarms.length === 0, '')

  // The ladder is bounded: a retry past the bound arms nothing, which is what stops a lost
  // reply from costing three hours of wakes for a press that was answered instantly.
  const capped = await runWake(makeWatch(), 'retry=1&i=18-93cebd&a=taken&ts=1&n=12')
  check('the ladder stops at 12 attempts', capped.carries.length === 0, String(capped.carries.length))
}

console.log('\nexit: only alarm wakes release the slot, never action wakes')
{
  // Measured 2026-11-10: the wake that answered a press reported the heartbeat still in the
  // table and then the record never fired again; exit() is the only code left in that path.
  // Alarm wakes (onInit) call exit() every minute harmlessly; action wakes (onEvent) must not.
  const alarmWake = await runWake(makeWatch(), 'via=alarm&mode=oneshot&hb=1')
  check('an alarm wake still exits', alarmWake.exits === 1, String(alarmWake.exits))

  const actionWake = await runWake(makeWatch({ viaEvent: true }), TAP)
  check('an action wake does not exit', actionWake.exits === 0, String(actionWake.exits))
  check('an action wake still answers the press', logs(actionWake, 'tap.sent').length === 1, '')
  check('an action wake leaves a fresh heartbeat', logs(actionWake, 'tap.hb').length === 1 && logs(actionWake, 'tap.hb')[0].json.ok === 1, JSON.stringify(logs(actionWake, 'tap.hb')[0] && logs(actionWake, 'tap.hb')[0].json))
}

console.log('\na tap cannot end the schedule')
{
  // Measured 2026-11-10: the first tap that reached the success branch was followed by the
  // heartbeat record vanishing, leaving the app armed and silent until the page was opened.
  // Whatever removed it, a tap must restore it and must say what it saw.
  const w = makeWatch()
  const st = await runWake(w, TAP)
  const table = logs(st, 'tap.table')
  check('the tap reports the alarm table it left behind', table.length === 1, String(table.length))
  const t = table[0] && table[0].json
  check('it reports the table before and after the cancel', t && Array.isArray(t.before) && Array.isArray(t.after), JSON.stringify(t))
  check('it names the carrier id it cancelled', t && t.carry === 500, JSON.stringify(t && t.carry))

  // The table empty at that moment: put the heartbeat back before the context dies.
  const empty = makeWatch()
  empty.state.pending = []
  const lost = await runWake(empty, TAP)
  const rearm = logs(lost, 'tap.rearm')
  check('a tap restores a heartbeat that is gone', rearm.length === 1 && rearm[0].json.ok === 1, JSON.stringify(rearm[0] && rearm[0].json))
}

console.log('\nbuttons: an action targets the page, not the app-service')
{
  // The reference app's recipe, and the docs allow that an action aimed at an app-service does
  // nothing at all with no error - which is what the wrist showed on 0.9.18 while the page's own
  // BLE probe kept working. Assert the file the watch puts in the notification centre.
  const w = makeWatch()
  w.opts.items = [{
    id: '40-abcdef',
    title: 'Medication',
    body: 'take it',
    vibrate: 2,
    actions: [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }],
  }]
  const st = await runWake(w, 'via=alarm&mode=oneshot&hb=1')
  const made = st.notifications[0]
  check('the notification carries the item actions', !!made && made.actions.length === 2, JSON.stringify(made && made.actions && made.actions.length))
  const files = made && made.actions ? made.actions.map((a) => a.file) : []
  check('every action targets a page', files.length > 0 && files.every((f) => f === 'page/index'), JSON.stringify(files))
  check('the param still names the press', made && /i=40-abcdef/.test(made.actions[0].param), made && made.actions[0].param)
}

console.log('\nheartbeat: the schedule is one repeating record the OS owns')
{
  // Arming is the page's job, and it must produce exactly one record: cancel everything,
  // then set the heartbeat. Anything else in the table is a leak that shows up as extra
  // wakes for the life of the install.
  // shared/alarm.js is the only thing that shapes the record, so test that module directly
  // against a stub alarm API: no BLE, no page, just what we would hand the OS.
  const calls = []
  const armed = instantiate(join(ROOT, 'shared/alarm.js'), {
    '@zos/alarm': {
      set: (o) => {
        calls.push(o)
        return 700 + calls.length
      },
      cancel: () => 0,
      getAllAlarms: () => [],
      REPEAT_MINUTE: 1,
    },
    '@zos/app': { getPackageInfo: () => ({ appId: 10262217, packageName: 'Notify Relay' }) },
    '@zos/storage': { localStorage: fakeStorage() },
    '@zos/utils': utilsStub(eventModule.EventBus),
    '@zos/fs': { openSync: () => 0, writeSync: () => 0, closeSync: () => 0, readSync: () => 0, statSync: () => null, O_CREAT: 0, O_TRUNC: 0 },
  }, ['setHeartbeatAlarm', 'cancelAllTickAlarms']).setHeartbeatAlarm()
  check('arming sets exactly one record', calls.length === 1, String(calls.length))
  const rec = calls[0]
  check('it is a repeat record', rec.repeat_type === 1, String(rec.repeat_type))
  check('on a one-minute period', rec.repeat_period === 1, String(rec.repeat_period))
  check('it survives reboot', rec.store === true, String(rec.store))
  check('it is a oneshot service url wake', rec.url === 'app-service/notifier', rec.url)
  check('the parameter names the heartbeat', /hb=1/.test(rec.param), rec.param)
  check('no repeat_duration is sent (the field we wrongly blamed)', rec.repeat_duration === undefined, String(rec.repeat_duration))

  // The service must never touch the alarm table. This is the whole point of the change:
  // a chain that re-arms itself can lose the night with one missed delivery, and a
  // service that writes alarms is a second writer racing the OS.
  const runx = await runWake(makeWatch(), 'via=alarm&mode=oneshot&hb=1')
  check('a heartbeat wake arms nothing', runx.armedCalls === 0 && runx.fences.length === 0, String(runx.armedCalls))
  check('a heartbeat wake cancels nothing', (runx.cancelledAlarms || []).length === 0, String((runx.cancelledAlarms || []).length))
  const w = logs(runx, 'tick.wake')[0].json
  check('tick.wake reports hb', w.hb === 1, JSON.stringify(w.hb))
  check('tick.wake reports the table', Array.isArray(w.ids), String(w.ids))
  check('tick.wake no longer carries chain fields', w.chain === undefined && w.chainId === undefined, '')
  check('a heartbeat wake delivers', reqs(runx, 'poll').length === 1, String(reqs(runx, 'poll').length))
  check('a heartbeat wake exits', runx.exits === 1, String(runx.exits))

  // A disarmed heartbeat wake must not poll, and must not touch alarms either.
  const off = await runWake(makeWatch({ storage: fakeStorage({ relay_armed: '0' }) }), 'via=alarm&mode=oneshot&hb=1')
  check('a disarmed heartbeat wakes without BLE work', reqs(off, 'poll').length === 0, '')
  check('a disarmed heartbeat still exits', off.exits === 1, String(off.exits))
}

console.log('\nexit: every terminal path releases the service slot')
{
  // The platform gives one background service slot, and a single-execution service that
  // never exits can hold it with work still pending - the shape of the 5.2 h silences.
  const tapRun = await runWake(makeWatch(), TAP)
  check('an acked tap exits exactly once', tapRun.exits === 1, String(tapRun.exits))

  const pollRun = await runWake(makeWatch(), 'via=alarm&mode=oneshot&show=0')
  check('a poll wake exits exactly once', pollRun.exits === 1, String(pollRun.exits))

  const fenceRun = await runWake(makeWatch(), 'via=alarm&mode=oneshot&fence=1')
  check('a fence wake exits exactly once', fenceRun.exits === 1, String(fenceRun.exits))

  const offRun = await runWake(makeWatch({ storage: fakeStorage({ relay_armed: '0' }) }), 'via=alarm&mode=oneshot&show=0')
  check('a disarmed wake exits too', offRun.exits === 1, String(offRun.exits))

  const badRun = await runWake(makeWatch(), 'i=&a=x')
  check('an unparseable press still exits', badRun.exits === 1, String(badRun.exits))

  // A dead link never reaches the exit path (the handshake promise never settles), which is
  // precisely why the OS must reap that case - and why nothing may be left pending after it.
  const deadRun = await runWake(makeWatch({ respondShake: false }), TAP)
  check('a wake that cannot shake has not exited (OS reaps it)', deadRun.exits === 0, String(deadRun.exits))
}

console.log('\ntelemetry: tick.wake is observable (defect 4)')
{
  const w = makeWatch()
  const st = await runWake(w, 'via=alarm&mode=oneshot&show=0')
  const wakes = logs(st, 'tick.wake')
  check('tick.wake is sent after the handshake', wakes.length === 1, JSON.stringify(st.frames))
  check('tick.wake carries the heartbeat flag', wakes.length === 1 && wakes[0].json.hb !== undefined, JSON.stringify(wakes))
  check('tick.wake is sent with the learned side port', wakes.length === 1 && wakes[0].port2 === SIDE_PORT, wakes.length ? String(wakes[0].port2) : '-')
  check('dispatch is one poll', reqs(st, 'poll').length === 1)
}

console.log('\ntelemetry: a wake with no link cannot report, and does not pretend to')
{
  const w = makeWatch({ respondShake: false })
  const st = await runWake(w, 'via=alarm&mode=oneshot&show=0')
  check('nothing left the watch', st.frames.filter((f) => f.type === 'data').length === 0, JSON.stringify(st.frames))
  // The handshake never settles, so the callback never runs and the wake is reaped with its
  // buffered telemetry. That is harmless only because nothing needed arming: the OS repeats
  // the heartbeat itself, so a dead link cannot end the schedule (the reason the chain is
  // gone). Assert the service left the alarm table completely alone.
  check('a dead link leaves the alarm table untouched', st.armedCalls === 0 && st.fences.length === 0, String(st.armedCalls))
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
