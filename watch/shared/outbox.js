// Durable device->phone outbox, backed by whatever key/value storage the caller
// passes in (localStorage in every runtime).
//
// Why this exists at all: an App Service wake is a *fresh JS context*. Alarms are the
// only thing that survives it, so a button tap - which is a user action that has
// already happened by the time this code runs - has to be written to storage before
// the first BLE call, and removed only once the phone has answered. That is what makes
// taps at-least-once instead of "one fire-and-forget frame, then hope".
//
// Two queues use it:
//   * acks   - keyed by (id, action), so a double tap or a replay is one entry and the
//              relay's own (id, action) collapse makes a resend free
//   * logs   - append-only telemetry; loses the oldest rather than the newest
//
// No @zos imports here: this module is pure logic over a storage object, so it can be
// unit-tested on a laptop (watch/tools/test-outbox.mjs) without a watch.

function safeGet(storage, key) {
  try {
    const raw = storage.getItem(key)
    if (!raw || typeof raw !== 'string') return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch (e) {
    // Corrupt or unreadable: treat as empty. A queue that cannot be parsed must not
    // wedge every future wake.
    return null
  }
}

/**
 * @param {object} storage   getItem/setItem (localStorage, or a fake in tests)
 * @param {string} key       storage key
 * @param {number} max       cap; the OLDEST entries are dropped first
 * @param {function} keyOf   entry -> dedupe key, or null for append-only
 */
export function createOutbox(storage, key, max, keyOf) {
  const limit = typeof max === 'number' && max > 0 ? Math.floor(max) : 0
  const keyOfEntry = typeof keyOf === 'function' ? keyOf : null

  function read() {
    const list = safeGet(storage, key)
    if (!list) return []
    return list.filter((e) => e && typeof e === 'object')
  }

  function write(list) {
    try {
      storage.setItem(key, JSON.stringify(list))
      return true
    } catch (e) {
      // Storage full or unavailable. False so the caller can at least log it; the
      // in-memory truth is gone with this context either way.
      return false
    }
  }

  return {
    list: read,
    size() {
      return read().length
    },

    // Appending an entry whose dedupe key is already queued REPLACES it: pressing the
    // same button twice is one answer, and a replay must not grow the queue.
    push(entry) {
      const list = read()
      const k = keyOfEntry ? keyOfEntry(entry) : null
      const kept = k === null || k === '' ? list : list.filter((e) => keyOfEntry(e) !== k)
      kept.push(entry)
      if (limit) while (kept.length > limit) kept.shift()
      return write(kept) ? kept.length : -1
    },

    // Drop entries matching a predicate. Returns how many are left.
    drop(predicate) {
      const list = read()
      const kept = list.filter((e) => !predicate(e))
      if (kept.length !== list.length) write(kept)
      return kept.length
    },

    // Forget the first `n` entries - the ones the caller just handed over, in order.
    take(n) {
      const list = read()
      const count = Math.max(0, Math.min(Math.floor(n) || 0, list.length))
      if (!count) return list.length
      const rest = list.slice(count)
      write(rest)
      return rest.length
    },

    clear() {
      return write([])
    },
  }
}
