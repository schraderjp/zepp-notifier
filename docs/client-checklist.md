# Client checklist — exact shapes, one line per endpoint

This is the file to write a client *from*. `docs/contract.md` explains **why** (semantics,
trade-offs, the delivery model); this file states **what bytes come back**, so a client can
be typed and its fakes built without guessing. Where the two disagree, this file and
[`schema-v1.json`](./schema-v1.json) win — and `schema-v1.json` wins over this file, because
it is machine-checked:

```bash
tools/check-checklist.py            # every field below is verified against the schema
tools/schema-check.py docs/schema-v1.json --defs
python3 tools/test-contract.py      # the relay actually answers with these shapes
```

Types are written the way the schema writes them: `string|null` is a nullable string, and
`"ack-driven"` is a const. `http://relay/…` below means the relay base URL; every request
carries `Authorization: Bearer <token>` unless noted.

Every table is preceded by a `schema: $defs/<name>` line naming the definition it comes
from. That binding is what `tools/check-checklist.py` reads: a row cannot rename a field
or mistype it without that command failing, which is the only reason to trust a
document written by hand.

## The five that cost a night

Each of these was a real client bug, found only after deployment, because the client was
written from prose that said "expires_at is a date" and similar. They are listed first so
nobody re-derives them:

| assumption | actual | what it looks like |
|---|---|---|
| `expires_at` is an ISO string | **integer epoch ms**; an ISO string is `400 invalid_expires_at` | every prompt silently rejected |
| `GET /v1/events` returns an `events` array | returns **`facts`**, plus `next`, `more`, `oldest_seq` | empty loop, no events consumed |
| the answer kind is `"answer"` | **`"answered"`** | answers never recorded |
| an answer's `at` is an ISO string | **integer epoch ms** | wrong timestamps |
| `notification.answer.action` | **`answers[]`** of `{action, at, seq}`; `answer` is a legacy mirror | repair path never works |
| `chain` is a bare word | **nested** `{chain, last_poll_age_s, queue_depth}`, in `/health` and in every `/v1/notify` reply | chain health never recorded |
| the cursor is the last fact's `seq` | use the response's own **`next`** — it is defined for empty pages and for `more: true` | stalled cursor |

## POST /v1/notify — queue or replace

`201` for a new item, `200` for a no-op retry or an in-place replacement. `429 queue_full`
when the queue is at capacity.

Request body (`$defs/notifyRequest`):

schema: $defs/notifyRequest

| field | type | notes |
|---|---|---|
| `title` | string | 1–40 chars; truncated, default `"Notification"` |
| `body` | string | 0–160 chars; truncated |
| `vibrate` | integer | 0–5 severity channel. 0 means default (it vibrates); there is no silent value |
| `actions` | array | max 3; each `{id, label}` — see `$defs/action`. `label` > 18 chars is **rejected**, not truncated |
| `key` | string | replacement + retry idempotency (§5.1) |
| `tag` | string | `[a-z0-9][a-z0-9._-]*`, ≤ 32. Required to be inside an app token's prefix |
| `expires_at` | integer | **epoch milliseconds**, not a date string. Serve-time gate |
| `not_before` | integer | **epoch milliseconds**. Not served before this |
| `extras` | object | ≤ 8 entries, string keys ≤ 32, string values ≤ 128. Round-tripped, never interpreted |
| `retract` | boolean | cancel the wrist item once it expires |

Response body (`$defs/notifyResponse`):

schema: $defs/notifyResponse

| field | type | notes |
|---|---|---|
| `id` | string | `^[0-9]+-[0-9a-f]{6}$` |
| `key` | string\|null | echoed |
| `tag` | string\|null | echoed |
| `state` | queued\|rendered\|answered\|expired\|abandoned | after this call |
| `duplicate` | boolean | `true` = identical payload for an existing key, nothing changed |
| `supersedes` | string\|null | set when this item replaced an already-rendered one |
| `replaced` | boolean | `true` = the earlier unrendered item was rewritten in place, same `id` |
| `warnings` | array | strings; present only when the body looked malformed (no title, no actions) |
| `chain` | chain | `{chain, last_poll_age_s, queue_depth}` — see below |

Literal response (`201`):

```json
{
  "id": "1-572040",
  "key": "med:2026-11-10:2200",
  "tag": "meds.bedtime",
  "state": "queued",
  "duplicate": false,
  "supersedes": null,
  "replaced": false,
  "chain": { "chain": "silent", "last_poll_age_s": null, "queue_depth": 1 }
}
```

`chain` (`$defs/chain`), identical in `/health` and in this reply:

schema: $defs/chain

| field | type | notes |
|---|---|---|
| `chain` | online\|stale\|silent | `stale` past ~180 s without a device poll, `silent` past 15 min |
| `last_poll_age_s` | integer\|null | `null` = the relay has never seen this device poll |
| `queue_depth` | integer | items currently deliverable |

## GET /v1/events — append-only facts

Query: `?since=<cursor|all|10m>&kind=<kind>[.<kind>]&tag=<tag>&wait=<s>&limit=<n>`.
`kind` accepts a dotted prefix (`?kind=notify` matches nothing; `?kind=queued` matches
exactly). `since` accepts a cursor, `all`, or a duration like `10m`.

Response (`$defs/eventsResponse`):

schema: $defs/eventsResponse

| field | type | notes |
|---|---|---|
| `facts` | array | oldest first; each `$defs/fact` |
| `next` | string | **the cursor to send back.** Defined even when `facts` is empty |
| `more` | boolean | more facts are already waiting; keep reading |
| `oldest_seq` | integer | facts below this have been retained away |

Literal response:

```json
{
  "facts": [
    { "seq": 2, "kind": "answered", "id": "1-572040", "key": "med:2026-11-10:2200",
      "tag": "meds.bedtime", "at": 1794281125700, "action": "taken" }
  ],
  "next": "2",
  "more": false,
  "oldest_seq": 1
}
```

One fact (`$defs/fact`):

schema: $defs/fact

| field | type | notes |
|---|---|---|
| `seq` | integer | 1-based, monotonic, the cursor currency |
| `kind` | queued\|rendered\|answered\|replaced\|expired\|abandoned | `answered`, not `answer` |
| `id` | string | the notification id |
| `key` | string\|null | |
| `tag` | string\|null | |
| `at` | integer | **epoch ms** |
| `notification` | notification | present on `queued` only — a snapshot, not a live view |
| `action` | string | present on `answered` |
| `reason` | ttl | present on `expired` |
| `served` | integer | present on `abandoned` |

## GET /v1/notification/&lt;id&gt; — one item, full state

`404 not_found` if it does not exist, or if it belongs to another app's prefix (the two
are indistinguishable on purpose). Response is `$defs/notification`, described under
[Shared shapes](#shared-shapes). Literal response, after a serve and before an answer:

```json
{
  "title": "\ud83d\udc8a Evening dose",
  "body": "2 tablets",
  "vibrate": 4,
  "actions": [{ "id": "taken", "label": "Taken" }, { "id": "skipped", "label": "Skipped" }],
  "key": "med:2026-11-10:2200",
  "tag": "meds.bedtime",
  "expires_at": 1794284725666,
  "not_before": null,
  "extras": { "client::display": "summary" },
  "retract": true,
  "id": "1-572040",
  "seq": 1,
  "created_at": 1794281125666,
  "state": "queued",
  "supersedes": null,
  "served_count": 1,
  "served_at": 1794281125667,
  "peek_count": 1,
  "peeked_at": 1794281125667,
  "rendered_at": null,
  "answers": [],
  "expired_at": null
}
```

## GET /health — liveness, open (no credential)

Response (`$defs/healthResponse`):

schema: $defs/healthResponse

| field | type | notes |
|---|---|---|
| `ok` | boolean | always `true` when the process is answering |
| `auth` | boolean | `false` = dev mode, every endpoint open |
| `chain` | chain | see `$defs/chain` |
| `queue_depth` | integer | same number as `chain.queue_depth` |
| `queued` | integer | rows in the store, including answered ones |
| `next_seq` | integer | last notification sequence allocated |
| `oldest_seq` | integer | oldest fact still retained |

```json
{
  "ok": true, "auth": true,
  "chain": { "chain": "online", "last_poll_age_s": 14, "queue_depth": 0 },
  "queue_depth": 0, "queued": 0, "next_seq": 42, "oldest_seq": 1
}
```

## GET /v1/inbox — device only

`?device=<id>` plus `?peek=1` for a cache refresh. A peek lists the same items but
increments `peek_count` instead of `served_count`, so "reached the phone" stays
distinguishable from "handed to a wrist". Response (`$defs/inboxResponse`):

schema: $defs/inboxResponse

| field | type | notes |
|---|---|---|
| `cursor` | integer | always `0`; delivery is ack-driven, there is no cursor |
| `items` | array | max 5; each `$defs/inboxItem` |
| `cancel` | array | notification-centre **integers** to delete; repeats until the device confirms via `/v1/seen` |
| `server_time` | integer | epoch ms |
| `mode` | "ack-driven" | const |
| `stuck` | boolean | items queued longer than ~5 min without a render report |
| `stuck_ids` | array | up to 3 ids, for telemetry |

```json
{
  "cursor": 0,
  "items": [{ "id": "1-572040", "title": "\ud83d\udc8a Evening dose", "body": "2 tablets",
              "vibrate": 4,
              "actions": [{ "id": "taken", "label": "Taken" }, { "id": "skipped", "label": "Skipped" }] }],
  "cancel": [42],
  "server_time": 1794281125667,
  "mode": "ack-driven",
  "stuck": false,
  "stuck_ids": []
}
```

One item (`$defs/inboxItem`):

schema: $defs/inboxItem

| field | type | notes |
|---|---|---|
| `id` | string | |
| `title` | string | |
| `body` | string | |
| `vibrate` | integer | |
| `actions` | array | each `$defs/action` |

## POST /v1/seen — device only

Body (`$defs/seenRequest`):

schema: $defs/seenRequest

| field | type | notes |
|---|---|---|
| `ids` | array | relay ids that actually reached the notification centre |
| `centre` | object | `relay id -> notification-centre integer` from `notify()` |
| `cancelled` | array | centre integers the device actually deleted |

Response (`$defs/seenResponse`):

schema: $defs/seenResponse

| field | type | notes |
|---|---|---|
| `ok` | boolean | |
| `marked` | integer | newly marked rendered; `0` for a repeat report |
| `mapped` | integer | centre ids newly learned |
| `cancelled` | integer | centre ids newly confirmed deleted |

```json
{ "ok": true, "marked": 1, "mapped": 1, "cancelled": 0 }
```

## POST /v1/ack — device only

Body (`$defs/ackRequest`):

schema: $defs/ackRequest

| field | type | notes |
|---|---|---|
| `id` | string | |
| `action` | string | the action id, not its label |
| `ts` | integer | device epoch ms, used for `transit_ms`. This is what makes a lost-then-replayed tap measurable |
| `replay` | boolean | set when the phone side drains its outbox after an outage |

Response (`$defs/ackResponse`):

schema: $defs/ackResponse

| field | type | notes |
|---|---|---|
| `ok` | boolean | |
| `toast` | string | display text |
| `action` | string | echoed |

```json
{ "ok": true, "toast": "Got it: taken", "action": "taken" }
```

A duplicate `(id, action)` is a `200` with `answers` unchanged: retries are free, which is
what lets the watch resend until it has proof.

## POST /v1/log — device telemetry

Body (`$defs/logRequest`) — free-form beyond these two fields; the whole object is
appended to `events.jsonl`.

schema: $defs/logRequest

| field | type | notes |
|---|---|---|
| `event` | string | event name. `poll.served` and `poll.nores` also refresh the chain clock |
| `ts` | integer | device epoch ms, observational only |

```json
{ "event": "tap.received", "ts": 1794281003964, "i": "18-93cebd", "a": "taken", "via": "request" }
```

Response: `{"ok": true}`.

## Applications

`POST /v1/apps` (operator) body `$defs/createAppRequest`, response `201`
`$defs/createAppResponse`. The `token` is returned exactly once.

schema: $defs/createAppRequest

| field | type | notes |
|---|---|---|
| `name` | string | |
| `prefix` | string | tag prefix this app may write and read |

Response (`201`):

schema: $defs/createAppResponse

| field | type | notes |
|---|---|---|
| `id` | integer | |
| `name` | string | |
| `prefix` | string | |
| `token` | string | the bearer token, returned here and never again |

```json
{ "id": 1, "name": "Meds", "prefix": "meds", "token": "7lOji9UgX4dShiPA1u1LgIvk3VLicwOz" }
```

`GET /v1/apps` (operator) response (`$defs/appsResponse`):

schema: $defs/appsResponse

| field | type | notes |
|---|---|---|
| `apps` | array | each `$defs/app`, alpha-sorted by prefix |

One app is `$defs/app`:

schema: $defs/app

| field | type | notes |
|---|---|---|
| `id` | integer | |
| `name` | string | |
| `prefix` | string | |
| `created_at` | integer | epoch ms |
| `token_preview` | string | first and last four characters; the token itself is never stored |

```json
{ "id": 1, "name": "Meds", "prefix": "meds", "created_at": 1794281094975, "token_preview": "7lOj...Oz" }
```

## Errors

Every failure is `{"error": {"code": string, "message": string}}`, plus `field` when one
field is at fault and `status` inside the object when the HTTP status is not 400:

schema: $defs/error

| field | type | notes |
|---|---|---|
| `error` | object | `{code, message}` plus optional `field` and `status` |

```json
{ "error": { "code": "too_many_actions", "message": "at most 3 actions", "field": "actions" } }
```

Codes a client must handle: `invalid_expires_at`, `invalid_not_before`,
`too_many_actions`, `unsupported` (an array `tag`), `queue_full` (429, with
`Retry-After`), `forbidden_tag` (403, outside the app's prefix), `not_found` (404),
`dashboard_login_required` (401 on `/state`), `csrf_header_required` (403 on dashboard
writes).

## Shared shapes

### `$defs/notification` — the stored item

schema: $defs/notification

| field | type | notes |
|---|---|---|
| `id` | string | `^[0-9]+-[0-9a-f]{6}$` |
| `seq` | integer | |
| `key` | string\|null | |
| `tag` | string\|null | |
| `title` | string | |
| `body` | string | |
| `vibrate` | integer | |
| `actions` | array | each `$defs/action` |
| `expires_at` | integer\|null | epoch ms |
| `not_before` | integer\|null | epoch ms |
| `extras` | object | |
| `retract` | boolean | |
| `created_at` | integer | epoch ms |
| `state` | queued\|rendered\|answered\|expired\|abandoned | `answered` is terminal for delivery |
| `supersedes` | string\|null | the older item this one replaced |
| `superseded_by` | string\|null | set when a later item replaced this one after it rendered |
| `served_count` | integer | handovers to the watch; a peek never increments it |
| `served_at` | integer\|null | epoch ms of the last handover |
| `peek_count` | integer | listings in a `?peek=1` reply, i.e. reaches into the phone cache |
| `peeked_at` | integer\|null | epoch ms of the last peek listing |
| `rendered_at` | integer\|null | when the device reported the render |
| `expired_at` | integer\|null | |
| `acked_at` | integer\|null | |
| `answer` | string | legacy mirror of the newest answer; use `answers` |
| `answers` | array | append-only; each `$defs/answer`. Identical `(id, action)` retries collapse |
| `centre_id` | integer\|null | the watch's notification-centre id, reported via `/v1/seen` |
| `cancelled_at` | integer\|null | set once the device confirmed the delete |

`fingerprint` is never exposed. Reading `served_count` alone is now ambiguous — that is
what `peek_count` fixes.

### `$defs/action`

schema: $defs/action

| field | type | notes |
|---|---|---|
| `id` | string | `[a-z0-9_]+`, ≤ 16. This is what comes back in `answers[].action` |
| `label` | string | ≤ 18 at write time; the watch truncates for display |

### `$defs/answer`

schema: $defs/answer

| field | type | notes |
|---|---|---|
| `action` | string | |
| `at` | integer | **epoch ms** |
| `seq` | integer | 1-based within this item |
