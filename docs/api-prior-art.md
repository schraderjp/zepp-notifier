# Prior art: what ntfy and Gotify got right

Reviewed 2026-11-05 against the published docs:
`docs.ntfy.sh/publish/`, `docs.ntfy.sh/subscribe/api/`, `gotify.net/docs/pushmsg`,
and Gotify's OpenAPI spec (`raw.githubusercontent.com/gotify/server/master/docs/spec.json`).

Both are one-way notification systems, so neither solves our real differentiator — an
answer that reaches the sender's server. But several adjacent problems are solved well,
and two of them fix genuine gaps in our design.

## Comparison

| dimension | ours (proposed v1) | ntfy | Gotify |
|---|---|---|---|
| **auth** | bearer token; per-sender tokens proposed | access tokens + per-topic ACLs ("the topic is essentially a password") | two token kinds: `appToken` sends, `clientToken` receives/manages; token in `X-Gotify-Key`, `?token=`, or `Authorization: Bearer` |
| **send** | `POST /v1/notify` | `POST /<topic>` | `POST /message` (form or JSON) |
| **observe** | `GET /v1/events?since&kind&tag&wait` — forward cursor, long-poll | `/<topic>/json` stream, `/sse`, `/raw`; `poll=1` for one-shot; `since=` accepts a **duration, timestamp, message id, or `all`** | `GET /message?limit&since` — **descending** ("id less than this"), ≤200 per page; plus WebSocket `/stream` |
| **idempotent retry** | **`key`** (same key + same payload = no-op) | none documented | none |
| **replace a queued item** | `key` replaces while unrendered | **sequence ID** (`X-Sequence-ID`, or `POST /<topic>/<seq>`): clients *replace* the notification, history stays append-only | none |
| **expiry** | `expires_at`, opt-in per notification | server cache duration (12 h default) → `expires` in the message JSON; `Cache: no` opts out entirely; attachments expire after 3 h | none |
| **priority** | `vibrate` 0–5, presentation only | **`Priority` 1–5 with defined client behaviour**, incl. `1 = no vibration or sound` | `priority` 0–10 plus a per-application `defaultPriority` |
| **actions** | `{id, label}`, answered through the relay | typed: `view` (URL), **`http`** (request with method/headers/body), `broadcast`, `copy` — each with **`clear`** to dismiss after tap | click-through URL only |
| **scheduling** | none (sender runs its own cron) | **`X-Delay` / `X-At` / `X-In`**: timestamp, RFC3339, duration, or natural language (`tomorrow, 3pm`) with `Timezone` | none |
| **extensibility** | none (additive fields only) | tags, icons, click URL, attachments, markdown | **`extras`**: namespaced key/value (`client::display`, `client::notification`) accepted only as JSON |
| **payload** | title 40, body 160, ≤3 actions | body limit 4 KB, attachments up to 15 MB by reference | message up to a server-configured size |
| **rate limits** | queue cap → 429 (proposed) | per-visitor limits, daily bandwidth budget | server-configured |
| **transport** | HTTP only, device-pull | HTTP stream / SSE / WebSocket / JSON poll | HTTP + WebSocket |

## Adopt — fixes a real gap in our design

1. **`clear` on an action: dismiss the notification when it is answered.** Today a tapped
   reminder stays in the notification centre, asking for attention it has already had.
   ntfy makes this an explicit per-action flag; we should treat it as always-on for
   `status` actions and implement it with `cancel(centreId)` on the wake *after* the ack,
   or immediately in the tap path. Needs the centre-id map (v2 bundle).
2. **Replace, don't duplicate, when `key` changes after render.** ntfy's sequence-ID
   semantics are what our `supersedes` was reaching for, and we have the primitives:
   `cancel(oldCentreId)` then `notify(new)`. That upgrades `supersedes` from "queue a
   second reminder and hope the user forgives you" to an actual replacement. Same v2
   bundle, and it makes `retract` fall out for free.
3. **`not_before` (ntfy's `X-At`).** A sender should be able to queue "remind at 07:00"
   without owning a scheduler. It is the same serve-time gate as `expires_at` — one
   comparison in `inbox()` — so it is nearly free, and it removes a whole cron loop from
   the medication app.
4. **`since` accepting a duration** (`?since=10m`) as well as an opaque cursor. Trivial,
   and it makes a restarted sender's first call obvious instead of "replay everything".
5. **`Retry-After` on 429**, and document the backoff. Both platforms require clients to
   back off; saying so explicitly beats a bare status code.
6. **Per-sender tokens** — independently validated by both. ntfy's per-topic ACLs and
   Gotify's `appToken` per application are the same idea: a sender's credential scopes it
   to its own traffic.
7. **`extras` as a namespaced passthrough (Gotify's best idea).** An opaque map carried
   into facts and (optionally) to the device, never interpreted by the relay. It gives
   future client hints a place to live without a `/v1` schema change. Adopt in the
   constrained form: validate that it is a flat string map, cap it, and promise only that
   it round-trips.

## Reject — and why

* **`http` action buttons.** ntfy puts the callback in the *client*: the phone makes the
  request. That requires the phone to reach every sender and to hold every sender's
  credential — N network paths and N secrets on a wrist-adjacent device. Our answers go
  through one relay with one auth surface. The cost is latency bounded by the poll
  cadence rather than instant; acceptable for reminders, and the tap path itself still
  acks in about a second.
* **Attachments, icons, click URLs, markdown.** `notify()` supports title, content,
  actions and vibrate — nothing else. No amount of API design changes that.
* **`priority: 1` = silent.** ntfy's minimum implies no sound or vibration. On this
  platform `vibrate: 0` means *default*, which vibrates; system DND is the only mute. So
  a semantic priority tier we cannot honour would be a promise we cannot keep. Keep
  `vibrate` as a severity channel and say so.
* **Server-side cache as the delivery guarantee.** ntfy keeps messages for 12 h so a
  client that reconnects catches up. Ours holds an item until the watch *reports it
  rendered*, bounded by `MAX_SERVES`, which is a stronger promise for the thing that
  matters here — and it is why a lost response costs a duplicate rather than a
  notification.
* **Gotify's descending `since`.** Sensible for paginating a message log backwards; wrong
  shape for a long-polling consumer that needs "everything after this point".

## Differences worth stating in our docs

* **Neither platform has idempotent publishing.** A retried POST is a second
  notification in both. Our `key`-plus-payload-fingerprint retry story is ahead of both,
  and it is the one place where our design is measurably better rather than merely
  different.
* **Neither tracks answers.** They are fire-and-forget by design. The receipt/answer path
  is our reason to exist, so comparisons on features like markdown are not the point.
* **Both are push-first; we are pull-only**, because the watch cannot be reached from the
  network. That is a constraint, not a preference — and the relay's job is to make it
  invisible to senders.
