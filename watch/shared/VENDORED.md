# Vendored Zepp OS messaging library

`message.js`, `message-side.js`, `data.js`, `defer.js`, `event.js` are copied
verbatim from the official samples repository:

- source: https://github.com/zepp-health/zeppos-samples
  `application/2.0/fetch-api/shared/`
- license: as published in that repository (Zepp Health sample code)

Why vendor instead of importing `@zeppos/zml`: ZML's device-side transport is
wired into `App()` / `Page()` mixins. An App Service is a third runtime that
never calls `App()`, and it must speak the *same* wire protocol as the page and
the Side Service. `MessageBuilder` is a plain class, so the same instance can be
created inside `App()`, a `Page()`, and `AppService()`.

Rules for this project:

- All three runtimes use these files. Do not mix in `@zeppos/zml` transports -
  the request/response envelope differs and only `call()` (fire-and-forget) is
  wire-compatible between the two.
- `request()` uses `setTimeout` for its timeout, and App Services have no timers.
  Inside `app-service/*` use `call()` only.
- Do not edit these files. If a fix is needed, patch it and note it here.

## Local modification (0.2.8) — do not re-vendor blindly

`message.js` is **no longer verbatim**. It carries a port of `MessageBuilder.fork()`
from [zepp-health/zml](https://github.com/zepp-health/zml) (`src/shared/message.js`).

Two defects in the upstream sample version break a *long-lived* device context (an
App Service), while a short-lived one (a page) is unaffected:

1. `sendShake()` transmits only while `appSidePort === 0`, so the handshake happens
   once per JS context and the port is trusted forever. The Side Service's port
   changes whenever the Zepp app restarts or comes back from doze; after that every
   send goes to a dead port.
2. Inbound Data packets are matched with `data.port2 === this.appSidePort`, so once
   that cached port is stale the side's messages are dropped silently too.

Symptom: a service that runs for hours and has "never spoken" — while a page's fresh
`MessageBuilder` (appSidePort 0) works every time.

Fix: `fork()` re-shakes before each `call()` and the timeout resolves rather than
hangs; the inbound port filter is removed. ZML does the same in
`wrapperMessage.call()` / `.request()`, which is why their app-service examples work
and the sample's do not.

Evidence: https://github.com/zepp-health/zml/issues/3 (maintainer htoooth: "device-app
is the browser and side-service is the server... if there is no communication link
established, side-service cannot send to device-app").

## Local modification (0.9.3) — `message-side.js` port filter

`message-side.js` is **no longer verbatim** either: `onFragmentData()` drops every
Data/DataWithSystemTool/Log frame whose `port2` is not the side's cached port, and an
inbound frame is built with `port2 = appSidePort`, which is 0 until the shake reply
arrives. So a frame the device sends during or before a handshake — the pre-shake
telemetry beacon in `app-service/notifier.js` — was discarded here with nothing but a
local `logger.error`, never reaching `POST /v1/log`.

Fix: `acceptsPort()` (used by the three inbound branches) treats port 0 as acceptable
and keeps the exact-match rule otherwise. The frame has already been routed to this
channel, so the port number is a staleness hint rather than an address.

Symptom it fixed: `grep -c '"event": "tick.wake"' events.jsonl` was 0 while the tick
was polling every 60 s, and every `devLog()` written during a failed tap was
unreadable remotely.
