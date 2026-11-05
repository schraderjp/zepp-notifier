// Wire contract between the watch and the phone (Side Service).
//
// 0.4.0 changed the DIRECTION, not just the tags: the phone no longer pushes
// anything. Every exchange is initiated by the watch from a one-shot tick, and
// the phone only ever answers. That is the shape that was measured to work
// (page probe, alarm-woken service, Weather-service, zml#3), and it removes the
// long-lived BLE session that dies silently when the mini app leaves the
// foreground.
//
//   watch  --Request-->  side      { t: 'probe' | 'poll' | 'ack' }
//   watch  <--Response-- side      one answer per request
//   watch  --Notify-->   side      fire-and-forget telemetry { t: 'l' }
//
// Keep this file free of runtime-specific imports so all three runtimes
// (page, App Service, Side Service) can share it.

export const MSG = {
  PROBE: 'probe', // watch -> phone: diagnostics round trip, no side effects
  POLL: 'poll', // watch -> phone: hand over queued notifications (E2)
  ACK: 'a', // watch -> phone: a button was pressed
  SEEN: 'seen', // watch -> phone: ids that were actually rendered (stops re-serving)
  LOG: 'l', // watch -> phone: telemetry, forwarded to the server
}

const MAX_PARAM_LEN = 120

// Notification action buttons only receive a plain string in `param`, so the
// notification id and the action id are packed into a query-like string.
export function encodeActionParam({ i, a }) {
  const safe = (v) => String(v == null ? '' : v).replace(/[&=%?#\s]/g, '_')
  const out = 'i=' + safe(i) + '&a=' + safe(a)
  return out.slice(0, MAX_PARAM_LEN)
}

export function decodeActionParam(param) {
  const out = { i: '', a: '' }
  if (typeof param !== 'string' || !param) return out
  for (const pair of param.split('&')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const key = pair.slice(0, idx)
    let value = pair.slice(idx + 1)
    try {
      value = decodeURIComponent(value)
    } catch (e) {
      // decodeURIComponent can be missing or throw on a malformed escape; the
      // raw value is still usable.
    }
    if (key === 'i') out.i = value
    else if (key === 'a') out.a = value
  }
  return out
}

// Notifications are rendered from a shallow object; these helpers keep the
// renderer defensive against a malformed server payload.
export function normalizeNotification(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null
  const actions = Array.isArray(raw.actions) ? raw.actions : []
  return {
    id: String(raw.id),
    title: String(raw.title || 'Notification'),
    body: String(raw.body || ''),
    vibrate: typeof raw.vibrate === 'number' ? raw.vibrate : undefined,
    actions: actions
      .slice(0, 3)
      .map((a) => ({
        id: String((a && a.id) || ''),
        label: String((a && a.label) || (a && a.id) || ''),
      }))
      .filter((a) => a.id),
  }
}
