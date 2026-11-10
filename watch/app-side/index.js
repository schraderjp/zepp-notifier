// Side Service: runs inside the Zepp app on the phone. It is the only runtime
// in a mini program that can speak HTTP, and it can only *answer*.
//
// 0.4.0 turned this file from a poller into a pure server, matching the only
// exchange direction that was ever measured to work: the watch opens it.
//
//   watch Request {t:'probe'}  -> diagnostics, no side effects
//   watch Request {t:'poll'}   -> GET /v1/inbox, answered with the items
//   watch Request {t:'ack'}    -> answered immediately, then POST /v1/ack
//   watch Notify  {t:'l'}      -> telemetry, forwarded to POST /v1/log
//
// Everything the old version owned because it was the only thing running - the
// setTimeout poll loop, the storage-based leader lock, the "no pong for N
// intervals" watchdog - is gone. It all existed to keep a channel open that the
// OS closes anyway. The outbox survives: acks are the reliable direction.

import { MessageBuilder } from '../shared/message-side'
import { MSG } from '../shared/protocol'
import { DEFAULT_RELAY_URL, DEFAULT_RELAY_TOKEN } from '../shared/config'

const K = {
  url: 'relay_url',
  token: 'relay_token',
  since: 'relay_since',
  pending: 'relay_pending',
  outbox: 'relay_outbox',
}

const OUTBOX_MAX = 20
const DEVICE = 'active-2-square'
// Reported with side.online so the trace names the build that produced it. Keep it
// equal to app.json's version.name: the side ships inside the same package.
const SIDE_VERSION = '0.9.5'

const mb = new MessageBuilder()

let requests = 0
let lastTickAt = 0
let lastError = ''
let startedAt = 0
let flushing = false

const logger = typeof Logger !== 'undefined' ? Logger : null

function log() {
  if (!logger) return
  try {
    logger.getLogger('relay.side').log.apply(null, arguments)
  } catch (e) {}
}

// --- config -----------------------------------------------------------------

function readCfg() {
  let url = ''
  let token = ''
  let since = 0
  let pending = 0
  try {
    // Empty/unset falls back to the build-time default, so a reinstall is usable
    // without opening the phone-side settings at all.
    url = String(settings.settingsStorage.getItem(K.url) || DEFAULT_RELAY_URL)
      .trim()
      .replace(/\/+$/, '')
    token = String(settings.settingsStorage.getItem(K.token) || DEFAULT_RELAY_TOKEN).trim()
    since = Number(settings.settingsStorage.getItem(K.since) || 0) || 0
    pending = Number(settings.settingsStorage.getItem(K.pending) || 0) || 0
  } catch (e) {}
  return { url, token, since, pending }
}

function setItem(key, value) {
  try {
    settings.settingsStorage.setItem(key, String(value))
  } catch (e) {}
}

function headers(cfg) {
  const h = { 'Content-Type': 'application/json' }
  if (cfg.token) h.Authorization = 'Bearer ' + cfg.token
  return h
}

function parseBody(res) {
  if (!res) return null
  const body = res.body
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch (e) {
      return null
    }
  }
  return body
}

async function post(cfg, path, payload) {
  const res = await fetch({
    url: cfg.url + path,
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(payload),
  })
  return parseBody(res)
}

// Fire-and-forget telemetry. Never awaited, never allowed to throw into a
// request handler.
function report(event, extra) {
  const cfg = readCfg()
  if (!cfg.url) return
  const payload = Object.assign({ event, ts: Date.now(), device: DEVICE, requests }, extra || {})
  post(cfg, '/v1/log', payload).catch((e) => {
    lastError = 'log: ' + e
  })
}

// --- outbox -----------------------------------------------------------------

function outboxRead() {
  try {
    const raw = settings.settingsStorage.getItem(K.outbox) || '[]'
    const list = JSON.parse(raw)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function outboxWrite(list) {
  try {
    settings.settingsStorage.setItem(K.outbox, JSON.stringify(list.slice(-OUTBOX_MAX)))
  } catch (e) {}
}

// A tap can arrive more than once for the same (id, action): the watch retries until
// it gets an answer, and the relay collapses duplicates on its side. Collapsing them
// here too keeps the outbox from turning into twenty copies of one press.
function sameAck(a, b) {
  return String(a && a.id) === String(b && b.id) && String(a && a.action) === String(b && b.action)
}

function queueAckForLater(item) {
  const list = outboxRead().filter((e) => !sameAck(e, item))
  list.push(item)
  outboxWrite(list)
}

function forgetQueuedAck(item) {
  const list = outboxRead()
  const kept = list.filter((e) => !sameAck(e, item))
  if (kept.length !== list.length) outboxWrite(kept)
}

async function sendAck(item) {
  // Queue FIRST, unconditionally, then try to send. The watch drops its own copy the
  // moment this side answers it, so this instance dying between the answer and the POST
  // must not be the difference between an answer and silence. A replayed duplicate is
  // free: the relay collapses identical (id, action).
  queueAckForLater(item)
  const cfg = readCfg()
  if (!cfg.url) {
    report('ack.queued', { i: item.id, reason: 'no url' })
    return
  }
  try {
    await post(cfg, '/v1/ack', Object.assign({ device: DEVICE }, item))
    // Sent: drop the durable copy, so the next drain does not replay it.
    forgetQueuedAck(item)
    report('ack.sent', { i: item.id, a: item.action, lag: Date.now() - (item.ts || Date.now()) })
  } catch (e) {
    lastError = 'ack: ' + e
    report('ack.failed', { i: item.id, err: String(e) })
  }
}

// Acks queue here when the relay is unreachable; every later tick drains them,
// which is a 1-minute retry cadence without any timer of our own.
async function flushOutbox() {
  if (flushing) return
  const cfg = readCfg()
  const pending = outboxRead()
  if (!cfg.url || !pending.length) return
  flushing = true
  const delivered = []
  let sent = 0
  try {
    for (const item of pending) {
      try {
        await post(cfg, '/v1/ack', Object.assign({ device: DEVICE, replay: true }, item))
        delivered.push(item)
        sent++
      } catch (e) {}
    }
    if (delivered.length) {
      // Remove the delivered ones from a FRESH read, never by writing back a stale
      // snapshot: sendAck() may have queued a new ack while this loop was awaiting, and
      // that entry is the one the watch has already forgotten about.
      outboxWrite(outboxRead().filter((e) => !delivered.some((d) => sameAck(d, e))))
    }
  } finally {
    flushing = false
  }
  if (sent) report('ack.replayed', { count: sent })
}

// --- inbox ------------------------------------------------------------------

// Cursor rules, unchanged from 0.3.x and still the reason restarts are
// non-events: the cursor is a `created_at` timestamp, never a sequence number.
//
// The phone owns it. The watch cannot: its localStorage is cached per JS context
// and a tick is a new context, so a device-side cursor would silently rewind to
// 0 on every wake. `pending` is the at-least-once part added in 0.4.0 - the
// cursor handed over is not promoted to `since` until the watch comes back for
// more, which is the only proof available that the previous wake actually ran.
// A tick that dies between response and render therefore sees the same item
// again (a duplicate banner) instead of losing it, which is the right trade for
// a reminder.
// ACK-DRIVEN (2026-11-05). No cursor, no pending handover: the relay serves
// everything not yet reported as rendered, so a response the watch never received
// costs one interval instead of deleting the notification. The `since` parameter is
// accepted-and-ignored by the relay, kept here only so old relays still answer.
async function inbox(peek) {
  const cfg = readCfg()
  if (!cfg.url) return { items: [], cursor: 0, error: 'unconfigured' }
  const res = await fetch({
    url: cfg.url + '/v1/inbox?device=' + DEVICE + (peek ? '&peek=1' : ''),
    method: 'GET',
    headers: headers(cfg),
  })
  const data = parseBody(res)
  if (!data || !Array.isArray(data.items)) throw new Error('bad inbox payload')
  return data
}

// Tell the relay what the watch actually rendered, so it stops re-serving it.
async function sendSeen(payload) {
  const cfg = readCfg()
  const body = typeof payload === 'string' || Array.isArray(payload) ? { ids: payload } : payload || {}
  const ids = Array.isArray(body.ids) ? body.ids : []
  const hasExtra =
    Object.keys(body.centre || {}).length > 0 ||
    (body.cancelled || []).length > 0
  if (!cfg.url || (!ids.length && !hasExtra)) return
  try {
    await post(cfg, '/v1/seen', { ...body, ids, device: DEVICE })
    report('seen.sent', { count: ids.length, centre: Object.keys(body.centre || {}).length, cancelled: (body.cancelled || []).length })
  } catch (e) {
    // Do not queue: the item simply re-serves and renders again, which is the
    // direction of failure we want.
    report('seen.failed', { count: ids.length, err: String((e && e.message) || e) })
  }
}

// --- helpers ----------------------------------------------------------------

function heard() {
  lastTickAt = Date.now()
}

function decode(ctx) {
  try {
    return mb.buf2Json(ctx.request.payload) || {}
  } catch (e) {
    return {}
  }
}

// --- lifecycle --------------------------------------------------------------

// ---------------------------------------------------------------------------
// Delivery cache (0.5.5).
//
// The watch's poll used to block on an HTTP fetch to the relay *inside* the
// freshly-woken App Service's execution budget. When the phone or the side was slow
// (idle watch, dozing phone, an aged instance) the response arrived after that
// context had been reaped, so the notification was silently lost - measured as
// intermittent misses that became a five-hour run of them overnight.
//
// Now the side refreshes this cache on its own timer and answers the watch from
// memory, so the round trip no longer contains a network call. The relay's
// ack-driven contract means a stale cache is harmless: unrendered items are simply
// served again.
let cache = []
// The watch is answered from this cache, so a cancel list computed during a refresh has
// to be cached alongside the items or the device would never see it.
let cacheCancel = []
let cacheAt = 0
let cacheBusy = false
// 8 s, not 12: at a 20 s cadence a 12 s refresh leaves the cache staler than the
// poll interval on a throttled phone (measured median 16.6 s on a 12 s timer).
// LAN cost is negligible, so refresh faster than any supported cadence.
const CACHE_TTL_MS = 8000

function refreshCache() {
  if (cacheBusy) return
  cacheBusy = true
  inbox(true /* peek: not a handover */)
    .then((data) => {
      cache = Array.isArray(data.items) ? data.items : []
      cacheCancel = Array.isArray(data.cancel) ? data.cancel : []
      cacheAt = Date.now()
      lastStuck = !!data.stuck
      stuckIds = Array.isArray(data.stuck_ids) ? data.stuck_ids : []
      if (cache.length) report('cache.refresh', { count: cache.length })
    })
    .catch((e) => {
      lastError = 'cache: ' + ((e && e.message) || e)
      report('cache.error', { err: lastError })
    })
    .finally(() => {
      cacheBusy = false
    })
}

function scheduleRefresh() {
  setTimeout(() => {
    refreshCache()
    scheduleRefresh()
  }, CACHE_TTL_MS)
}

// An item is done being served once the watch says it rendered it, or answered it.
function dropFromCache(ids) {
  if (!ids || !ids.length) return
  cache = cache.filter((i) => ids.indexOf(i.id) < 0)
}

AppSideService({
  onInit() {
    startedAt = Date.now()
    // listen() attaches the peerSocket listener and resolves the shake promise.
    // Without it a device-initiated request is never even parsed.
    mb.listen(() => {})
    // Prime the cache, then keep it warm independently of the watch's wakes.
    refreshCache()
    scheduleRefresh()

    mb.on('request', async (ctx) => {
      const req = decode(ctx)
      requests++
      heard()

      if (req.t === MSG.PROBE) {
        ctx.response({
          data: {
            ok: true,
            from: 'side',
            requests,
            lastError,
            device: DEVICE,
            // Age of the last device message, measured on the phone. This is the
            // one liveness number the watch cannot fake by self-reporting.
            sinceDeviceMs: lastTickAt ? Date.now() - lastTickAt : -1,
            stuck: lastStuck,
            stuckIds,
            cache_count: cache.length,
            cache_age_ms: cacheAt ? Date.now() - cacheAt : -1,
            cfg: !!readCfg().url,
            ts: Date.now(),
          },
        })
        report('probe.answered', { from: req.from || '?', wake: req.wake || '' })
        return
      }

      if (req.t === MSG.POLL) {
        // Answer from memory whenever the cache has ever been filled: the device is
        // inside a short execution budget, so a network call here is the thing that
        // used to lose the response.
        if (!cacheAt) {
          try {
            const data = await inbox()
            cache = Array.isArray(data.items) ? data.items : []
            cacheAt = Date.now()
            lastStuck = !!data.stuck
            stuckIds = Array.isArray(data.stuck_ids) ? data.stuck_ids : []
          } catch (e) {
            lastError = String((e && e.message) || e)
            ctx.response({ data: { items: [], error: lastError } })
            report('poll.error', { err: lastError })
            return
          }
        }
        const items = cache.slice()
        const age = cacheAt ? Date.now() - cacheAt : -1
        ctx.response({
          data: {
            items,
            cancel: cacheCancel,
            cursor: 0,
            mode: 'cache',
            cache_age_ms: age,
            stuck: lastStuck,
            stuck_ids: stuckIds,
          },
        })
        report('poll.served', {
          count: items.length,
          mode: 'cache',
          age_ms: age,
          stuck: lastStuck ? 1 : 0,
        })
        // Keep the next poll fast: refill in the background for the next wake.
        refreshCache()
        flushOutbox()
        return
      }

      if (req.t === MSG.SEEN) {
        const ids = Array.isArray(req.ids) ? req.ids : []
        dropFromCache(ids)
        ctx.response({ data: { ok: true, count: ids.length } })
        sendSeen({ ids, centre: req.centre, cancelled: req.cancelled })
        return
      }

      if (req.t === MSG.ACK) {
        dropFromCache([req.i])
        // Answer BEFORE the HTTP: the watch is inside a single-execution budget
        // and exits on this response. That response is also the watch's receipt,
        // which is why the report comes first: a tap that reached us is recorded
        // even if this instance dies before the POST.
        ctx.response({ data: { ok: true } })
        // tap.received is the side's record of "an ack arrived from the watch". Do NOT also
        // report ack.received: the relay records that itself in its POST /v1/ack handler,
        // and emitting it here too made `grep -c ack.received` count every answer twice.
        report('tap.received', { i: req.i, a: req.a, via: 'request', device_ts: req.ts })
        sendAck({ id: req.i, action: req.a, ts: req.ts })
        return
      }

      ctx.response({ data: { ok: false, error: 'unknown request' } })
    })

    // Fire-and-forget from the watch. The tick sends a `tick.wake` beacon before
    // the handshake, so "the alarm fired but the link is dead" is visible in the
    // trace as a beacon with no matching probe/poll answer.
    mb.on('call', (full) => {
      heard()
      let msg = null
      try {
        msg = mb.buf2Json(full.payload)
      } catch (e) {
        return
      }
      if (!msg || !msg.t) return
      if (msg.t === MSG.SEEN) {
        const ids = Array.isArray(msg.ids) ? msg.ids : []
        dropFromCache(ids)
        sendSeen({ ids, centre: msg.centre, cancelled: msg.cancelled })
        return
      } else if (msg.t === MSG.ACK) {
        // Older watch builds sent the ack as a Notify frame. Still accepted, and still
        // named in the trace, so a mixed pairing is diagnosable from events alone.
        report('tap.received', { i: msg.i, a: msg.a, via: 'notify', device_ts: msg.ts })
        sendAck({ id: msg.i, action: msg.a, ts: msg.ts })
      } else if (msg.t === MSG.LOG) {
        report(msg.e || 'device.log', { data: msg })
      }
    })

    report('side.online', { version: SIDE_VERSION, url: readCfg().url })
  },

  onDestroy() {
    report('side.destroy', { lastError, requests, uptime_ms: Date.now() - startedAt })
  },

  // Settings changed on the phone: nothing to reschedule any more, the next tick
  // simply reads the new config.
  onSettingsChange() {
    report('side.settings_changed')
  },
})
