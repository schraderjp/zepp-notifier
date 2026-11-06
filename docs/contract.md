# Relay API contract — v1 final (2026-11-05)

Status: **final and implemented.** `server/spike_server.py` implements everything
below except the items explicitly marked deferred or dropped. Behaviour is covered by
`tools/test-contract.py` and `tools/schema-check.py --live
docs/schema-as-implemented.json`; `docs/schema-v1.json` mirrors the implemented
contract.

---

## 1. Principles

1. **The relay owns the wire format; the sender owns policy.** How to resolve two
   answers, whether to escalate, whether to re-ask — that is the sending app's
   business. The relay records facts and never picks a winner.
2. **Delivery is at-least-once with bounded duplicates.** An item is served until the
   watch reports it rendered. A lost report costs a duplicate on the wrist, not a lost
   notification. Bounded by `MAX_SERVES`, then parked as `abandoned`.
3. **Facts are append-only.** Senders observe by reading a log from a cursor. No
   webhooks, no inbound ports, no broker.
4. **A sender must be able to tell "queued" from "will be delivered".** Chain health is
   part of every queue response and of the health endpoint.
5. **Additive compatibility.** Unknown request fields are ignored; response fields are
   only ever added. `/v1` stays `/v1`.

## 2. Objects

### 2.1 Notification

```jsonc
{
  "id": "44-069fc5",            // relay-assigned, stable
  "key": "med:2026-11-05:0700", // sender's logical identity (optional, see 5.1)
  "tag": "meds",                // sender's routing label (optional, see 5.2)
  "title": "💊 Evening dose",   // <= 40 chars
  "body": "2 tablets with food",// <= 160 chars
  "vibrate": 4,                 // 0..5 pattern (see 5.4)
  "actions": [                  // 0..3
    { "id": "got_it", "label": "Got it" }
  ],
  "expires_at": 1762348800000,  // epoch ms, optional (see 5.3)
  "created_at": 1762345678901,
  "state": "queued",            // queued|rendered|answered|expired|abandoned
  "served_count": 2,
  "served_at": 1762345700000,
  "rendered_at": null,
  "answers": [],                // append-only, see 5.5
  "supersedes": null            // id of the item this replaced, if any
}
```

### 2.2 Answer

```jsonc
{ "action": "got_it", "at": 1762345710000, "seq": 1 }
```

Answers accumulate. Identical retries of the same `(id, action)` collapse into one
answer (an outbox replay must not create a second fact). Distinct actions stay distinct.

### 2.3 Fact

One line per state change, monotonic `seq`, the unit of the observation API.

```jsonc
{
  "seq": 1287,          // opaque cursor for this stream
  "kind": "answered",   // queued|rendered|answered|expired|abandoned|replaced
  "id": "44-069fc5",
  "key": "med:2026-11-05:0700",
  "tag": "meds",
  "at": 1762345710000,
  // kind-specific:
  "action": "got_it",   // answered only
  "reason": "ttl"       // expired only: ttl|lapsed
}
```

`queued` also carries the full notification snapshot, so a sender that starts
mid-stream can reconstruct what it asked for without a second call.

## 3. Lifecycle

```
                (sender)                (watch, per wake)
                   │                          │
                   ▼                          ▼
POST /v1/notify ──▶ queued ──────serve────▶ served ──render──▶ rendered
                     │  ▲                     │                   │
        replace (key)│  └──re-serve (report lost)◀──┘              │ tap
                     │                                            ▼
                     ├───────────────────────────────────────▶ answered
                     │
                     ├── expires_at passes ───────────────▶ expired
                     └── MAX_SERVES exhausted ────────────▶ abandoned
```

`rendered` is not `seen`: only an answer proves attention.

### 5.0 What `rendered` actually means

`rendered` means **the notification was accepted into the watch's notification centre**. It
does not mean the screen lit, a banner appeared, or that anyone looked. Consequences a
sender must design around:

* with the screen off, an item can be `rendered` hours before it is first visible;
* render reports are lost roughly 30-40% of the time, so a missing `rendered` does not
  prove a missing render (the notification centre is the only ground truth);
* today the device reports `rendered` when `notify()` does not throw. `notify()` returns
  `0` on failure and the centre ID otherwise, and the Watch build does not yet check it,
  so a silent OS-level drop would still be reported as rendered. To be fixed in the next
  device build.

A `dismissed` fact (from `getAllNotifications()`, reported per wake) is proposed for v2:
it would distinguish "swiped away unanswered" from "still sitting there unanswered",
which is a real difference for a medication reminder, and it needs the same
relay_id -> centre_id map as retraction. `expires_at` bounds how long
an item may be *served*; it cannot retract one already on the wrist (see 5.3).

## 4. Endpoints

### 4.1 Sender-facing

| method | path | purpose | today |
|---|---|---|---|
| POST | `/v1/notify` | queue or replace a notification | partial — no `key`/`tag`/`expires_at` |
| GET | `/v1/events` | read facts from a cursor, optional long-poll | **missing** |
| GET | `/v1/notification/<id>` | full state of one item (reconciliation) | ✅ (app tokens see only their own prefix; cross-app reads are 404) |
| GET | `/v1/events?kind=answered` | answers; `/v1/answers` kept as an alias | ✅ |
| GET | `/v1/apps` | list sender applications (operator) | ✅ |
| POST | `/v1/apps` | create an app, returns its token exactly once | ✅ |
| DELETE | `/v1/apps/<id>` | revoke an app's token | ✅ |

### 4.2 Device-facing (the watch, via its side service)

| method | path | purpose | today |
|---|---|---|---|
| GET | `/v1/inbox` | items to render (`?peek=1` = cache refresh, no serve accounting) | ✅ |
| POST | `/v1/seen` | report what actually rendered | ✅ |
| POST | `/v1/ack` | report an answer | ✅ (single answer, not append-only) |

### 4.3 Operator-facing

| method | path | purpose | today |
|---|---|---|---|
| GET | `/health` | liveness, chain age, queue depth | partial |
| GET | `/state` | full dump for inspection | ✅ |
| POST | `/v1/log` | device telemetry beacons | ✅ |
| POST | `/v1/reset` | clear queue (dangerous, operator only) | ✅ |

### 4.4 Auth

Two token kinds, like Gotify's `appToken` / `clientToken` split:

* **Operator token** (`--token` / `RELAY_TOKEN` / `--token-file`): administers
  applications, reads everything, and is what the phone side holds (device endpoints
  serve every tag, so app tokens stay out of `/v1/inbox`, `/v1/seen`, `/v1/ack`,
  `/v1/log`, `/v1/reset`, `/state`).
* **App tokens**: created and revoked at runtime from the dashboard or
  `POST/DELETE /v1/apps` — no relay code, config, or restart to add a sender. Each
  app owns one tag prefix; its token queues only inside that prefix (exact or dotted
  child) and reads only its own facts. Outside its prefix it gets `403 forbidden_tag`
  on write and filter, and `404` on a single-item read (indistinguishable from
  missing, so apps cannot probe each other). Overlapping prefixes are rejected with
  `409 prefix_taken`.

The plaintext app token is returned exactly once at creation and never stored — only
a `sha256` hash and a `token_preview` persist. Lose it and you revoke + recreate.
With no operator token configured every endpoint is open (dev mode): startup prints
`auth: DISABLED` plus an exposure warning when bound beyond loopback, and `/health`
reports `auth: false`. `GET /health`, the dashboard shell and `/docs` always stay
open. When `DASHBOARD_USER`/`DASHBOARD_PASS` are set, `/` and `/state` additionally
require the browser-native login (remembered per session); the dashboard's
bearer-token field remains for the API calls it makes. `/v1/*` always uses bearer
tokens — the dashboard login never substitutes. See `docs/hosting.md`.

## 5. Semantics

### 5.1 `key` — replacement and idempotent retry

* While the item is **not yet rendered**, `POST /v1/notify` with the same `key`
  **replaces** the payload in place: same `id`, new content, `served_count` preserved,
  fact `replaced`. This is free — nobody has seen it.
* If it **has been rendered**, replacement cannot retract it. A new item is queued with
  the same `key` and `supersedes: <old id>`; the old item stops being served, and the
  sender receives `rendered` (old) + `queued` (new) and decides what to do.
* **Retry safety:** a retried POST with an identical payload for an existing `key` is a
  no-op returning the existing item with `duplicate: true`. A sender whose POST timed
  out can retry blindly.

### 5.2 `tag` — routing label

A single string, `<= 32` chars, carried into every fact for that item and filterable on
`/v1/events` (`?tag=meds`). It is the machine-readable counterpart to the emoji the
sender puts in `title` for the human. Arrays, hierarchies and server-side decoration
are deliberately out of scope.

### 5.3 `expires_at` — opt-in expiry

The relay drops the item at serve time if `expires_at <= now`, records `expired`, and
stops serving it. Nothing is dropped by default: a sender that wants "late is useless"
sets it, a sender that wants "late is fine" does not.

**Retraction is sender-set** (`retract: true`) and, as of the 0.6.0 watch build, real:
the device reports notification-centre ids in `/v1/seen`, the relay holds the map, and
each poll carries `cancel: [centreId...]` for items that are answered, superseded, or
expired-with-retract. Cancellation happens on the **next wake** (≤ ~60 s), and
`cancel()` on an id the user already dismissed is a no-op, so the list repeats until the
device confirms via `seen.cancelled`.

**What expiry alone cannot do:** without `retract: true`, an item rendered at 06:58
and expired at 07:30 is still sitting there at 11:00 asking for a tap — the relay has
no push channel, and the centre is a local object. With `retract: true` (and a 0.6.0+
device, which reports centre ids), the expired item joins the next wake's `cancel`
list instead. Either way this is the sender's choice per notification, not a
relay-wide policy — and because a stale prompt gets cancelled within a wake, the
window in which a late tap can log an answer against outdated content is bounded by
the cadence, not open-ended.

### 5.3b `not_before` — do not serve before

Epoch ms; the relay will not hand the item to the watch before then. Adopted from ntfy's
`X-At`/`X-Delay`: it lets a sender queue "remind at 07:00" instead of owning a scheduler.
It is the same serve-time comparison as `expires_at`, so a `not_before` after
`expires_at` is rejected (`invalid_not_before`) rather than storing an item that could
never be served.

### 5.3c `extras` — opaque passthrough

A flat map of short strings, carried into facts and never interpreted by the relay.
Borrowed from Gotify's namespaced `extras`, in the constrained form: at most 8 entries,
keys ≤32 chars, values ≤128. It exists so client-side hints can appear later without a
`/v1` schema change. The relay promises only that it round-trips.

### 5.4 `vibrate`

`0` = default (it vibrates), `1` beep, `2` birdsong, `3` drumbeat, `4` gentle, `5` buzz.
There is no silent value on this platform; system DND is the only mute. Use it as a
severity channel, not as a mute switch.

### 5.5 Answers

Each `POST /v1/ack` appends an answer unless an identical `(id, action)` already exists.
The first answer stops the item being served (otherwise it re-renders forever); later
answers are still recorded, because the sender may care that a second button was
pressed. No `unanswered` fact: a sender that wants "rendered but never answered" has
`rendered` and `answered` facts and can compute it, and `expires_at` gives it a bounded
window to escalate within.

### 5.6 Duplicates, stuck, abandoned

| condition | effect | fact |
|---|---|---|
| report lost, item re-served | duplicate render (bounded) | `rendered` again when reported |
| queued and unrendered for 5 min | `stuck` flag on the inbox response | none (telemetry) |
| `MAX_SERVES` reached (10) | parked, never served again | `abandoned` |

`stuck` is age-based, not serve-count-based: under cache serving the relay never sees a
fetch that returns an already-delivered item, so `served_count` stays unset.

### 5.7 Chain health

A stopped chain looks exactly like "nothing to report", so it is part of the contract:

`GET /health` → `{ ok, last_poll_age_s, chain: "online"|"stale"|"silent", device,
queue_depth, next_seq }`, with `stale` past 3 missed polls (~180 s) and `silent` past
15 min. `POST /v1/notify` returns the same `chain` block so a sender can decide to queue
anyway, escalate, or hold.

## 6. Field limits

| field | limit | on violation |
|---|---|---|
| `title` | 40 chars | truncate (visible, harmless) |
| `body` | 160 chars | truncate |
| `actions` | 3 | reject 400 |
| `actions[].label` | 18 chars | reject 400 (device truncates at 18; silent truncation changes meaning) |
| `actions[].id` | 16 chars, `[a-z0-9_]+` | reject 400 (packed as `i=<id>&a=<action>`, 120 chars total) |
| `key` | 64 chars | reject 400 |
| `tag` | 32 chars, `[a-z0-9][a-z0-9._-]*` | reject 400 |
| `expires_at` | epoch ms | reject 400 if not an integer |
| `retract` | boolean, default false | accepted and stored; no effect until v2 |
| `not_before` | epoch ms | reject 400 if not an integer, or if it is after `expires_at` |
| `extras` | ≤8 entries, key ≤32, value ≤128 | reject 400 |
| queue depth | 50 unrendered | reject 429 with `queue_depth` |
| inbox batch | 5 items per wake | — (drains at ~5/min) |

## 7. Errors

```jsonc
{ "error": { "code": "invalid_action_label", "message": "label exceeds 18 chars",
             "field": "actions[1].label" } }
```

| status | when |
|---|---|
| 400 | invalid field; `field` names it |
| 401 | missing/wrong bearer token |
| 404 | unknown notification id |
| 200 | `duplicate: true` (identical retry) or `replaced: true` (in-place replacement) — nothing new was created |
| 201 | a newly queued item |
| 409 | `since` cursor older than retained facts (`cursor_too_old`, response carries `oldest_seq`) |
| 429 | queue depth exceeded, with a `Retry-After` header |
| 500 | relay fault; safe to retry the same request (idempotency per 5.1) |

## 8. Observation API

```
GET /v1/events?since=<cursor>&kind=answered,expired&tag=meds&wait=20&limit=100
```

* `since` — opaque cursor from a previous response's `next`; `all`; or a duration such
  as `10m`, `2h`, `1d` (ntfy's shape, and the friendly answer for a sender that just
  restarted). Omit for "from the oldest retained fact". An unparseable value is
  `invalid_since`.
* `kind` — comma-separated filter; omit for all sender facts.
* `tag` — exact or **dotted-prefix** match, so `?tag=meds` also returns `meds.evening`.
* `tag` — filter to one sender label.
* `wait` — long-poll seconds, `0..30`. `wait=0` is plain polling, so one mechanism
  covers both; the relay's `ThreadingHTTPServer` means a blocked long-poll cannot stall
  the watch's `/v1/inbox`.
* `limit` — max facts per response, default 100.

Response: `{ facts: [...], next: "1290", more: false }`. Senders persist `next` and
resume from it; the stream is cursor-resumable and needs no broker.

## 9. Ordering and delivery rate

Items are served oldest-`created_at` first, up to 5 per wake, one wake per ~60 s. A
backlog therefore drains at roughly 5 per minute, and a burst arrives grouped. Delivery
is wake-quantised: nothing arrives faster than the cadence.

## 10. Retention

Facts are kept in a bounded ring (proposed: 5000 facts) plus the operator's
`events.jsonl`. A cursor older than the ring returns 409 with `oldest_seq`; the sender
resyncs with `GET /v1/notification/<id>` for the items it still cares about. Senders are
expected to consume at least hourly.

## 11. Compatibility table

| item | implemented | proposed |
|---|---|---|
| ack-driven serving, `peek`, `stuck`, `abandoned` | ✅ | — |
| `key`, `tag`, `expires_at`, `not_before`, `extras` | ✅ | §5.1-5.3c |
| append-only answers | ✅ (legacy `answer` mirrored for compatibility) | §5.5 |
| `/v1/events`, `/v1/notification/<id>` | ✅ | §4.1, §8 |
| chain health on queue + `/health` | ✅ | §5.7 |
| auth on all endpoints when a token is set | ✅ | §4.4 |
| app keys managed in the UI, no relay touch to add a sender | ✅ | §4.1, §4.4 |
| sender facts separated from ops telemetry | ✅ (`FACTS` vs `EVENTS`) | §2.3 |
| `retract` flag accepted and stored | ✅ (inert until v2) | §5.3 |
| retraction of rendered notifications | ✅ | `inbox.cancel` + `seen.centre` |
| dismiss an answered notification (`clear`, as ntfy does) | ✅ | on the next wake |
| replace a rendered notification (ntfy sequence-ID semantics) | ✅ | `cancel(oldCentreId)` + `notify(new)` |
| check `notify()`'s return value before reporting `rendered` | ✅ | 0 = failure, no longer counted |
| `dismissed` fact | ❌ dropped | `getAllNotifications()` throws in the App Service (measured 0.7.2: `live=null` on every wake), so per-wake detection is impossible; page-reported presence was judged not worth the mechanism (the app is only opened to arm). A reminder cleared without answering simply stays `rendered`. |

## 12. Decisions taken (2026-11-05)

1. **Retraction — shipped, sender-set.** The device reports notification-centre ids in
   `/v1/seen`, the relay holds the map, and each poll carries `cancel: [centreId...]`
   for answered, superseded, or expired-with-retract items (deletion confirmed via
   `seen.cancelled`, repeated until confirmed). Residual limit, stated plainly:
   cancellation lands on the next wake (≤ ~60 s at 60 s cadence, ~20 s at 20 s), never
   instantly, and `cancel()` on an id the user already dismissed is a no-op.
2. **`key` on an already-rendered item — new item with `supersedes`.** The relay does
   not mutate a rendered item and does not refuse the write; the sender sees `rendered`
   for the old item and `queued` for the new one and owns the decision. Chosen because
   policy belongs to the sender; replacement is `cancel(oldCentreId)` + `notify(new)`,
   so the duplicate is cleaned up on the next wake.
3. **No `unanswered` fact.** Each sender computes "rendered but not answered within my
   window" from `rendered` + `answered` facts and its own timer. The relay cannot know
   whether a dose reminder or a disk alert is the one going unanswered, so a relay-side
   deadline would be policy in the wrong place. `expires_at` covers the "drop it, it is
   stale" case.
4. **`tag` — single string with prefix matching.** `?tag=meds` matches `meds`,
   `meds.evening` and `meds.daily`, which delivers most of what an array would without
   a schema change. Widening a string's *meaning* later is free; widening its *type* is
   not.
5. **Per-sender tokens — shipped as Gotify-style app keys.** Applications are created
   and revoked from the dashboard or API at runtime; adding a sender never touches
   relay code or config. Each app owns one tag prefix (exact or dotted child, overlaps
   rejected). The operator token administers and remains what the phone side holds.
6. **Dismissed — dropped.** `getAllNotifications()` throws in the App Service
   (measured 0.7.2: `live=null` on every wake), so per-wake detection is impossible,
   and page-reported presence would only land when the app is opened — which is only
   to arm. A reminder cleared without answering stays `rendered`; no fact claims
   otherwise.

## 12b. Prior art

See `docs/api-prior-art.md` for the ntfy/Gotify comparison that produced `not_before`,
`extras`, duration cursors, `Retry-After`, and the v2 `clear`/replace/dismiss items.

## 13. Machine-readable schemas and reference client

| file | what it is |
|---|---|
| `docs/schema-as-implemented.json` | the payloads the running relay actually emits, verified against it live |
| `docs/schema-v1.json` | same contract, kept in parallel so a diff answers "what changed" |
| `tools/schema-check.py` | dependency-free validator: `--live` checks the running relay, `--defs` checks a schema's own examples |
| `tools/test-contract.py` | 88 assertions: the executable half of this contract |
| `tools/sender-example.py` | reference sender: queue with a stable `key`, persist the event cursor, long-poll `wait=20` filtered by `tag`, exit 0 on answered / 2 on unanswered-within-timeout / 3 on expired. Copy it; do not re-derive the loop. |
| relay `GET /docs`, `/docs/index.json`, `/docs/*.md`, `/docs/*.json` | this contract, human page + raw files, served open (no secrets in them); an integrating sender or agent starts at `index.json` |

`tools/sender-example.py` was exercised against the live relay (queued, `chain=online`,
rendered-then-unanswered path) before this was marked final.

| file | what it is |
|---|---|
| `docs/schema-as-implemented.json` | the payloads the running relay actually emits today, descriptions included where behaviour differs from the proposal |
| `docs/schema-v1.json` | the proposed contract, with worked examples per definition |
| `tools/schema-check.py` | dependency-free validator: `--live` checks the running relay against a schema, `--defs` checks a schema's own examples |

`tools/schema-check.py --live docs/schema-as-implemented.json` currently passes against
health, inbox and every stored notification, so the "as implemented" file is verified
rather than remembered.
