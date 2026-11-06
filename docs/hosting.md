# Hosting and auth

Two modes, same code path. Nothing is compiled in or enabled by a build flag.

## Development (no auth)

```sh
server/relay.sh start          # binds 0.0.0.0:8097, no token
```

With no token configured every endpoint is open, which is the frictionless case: the
watch's phone-side settings can leave the relay token blank, `curl` needs no headers,
and the dashboard at `http://<host>:8097/` works without typing anything.

Because "open" and "open by accident" must not look the same, startup says so:

```
auth: DISABLED - no token configured
relay: WARNING: bound to 0.0.0.0 with no token, so anyone who can reach this port
relay:          can queue notifications and read /state. Fine for a dev box on
relay:          loopback; set RELAY_TOKEN or --token-file before exposing it.
```

`GET /health` reports `{"auth": false}` so a monitor or dashboard can tell the mode
without guessing.

## Production (token required)

Set either `RELAY_TOKEN` (environment) or `RELAY_TOKEN_FILE` (a file containing the
token). Precedence is `--token`, then `--token-file`, then `RELAY_TOKEN`, so an explicit
flag always wins. An unreadable token file exits with status 2 rather than starting
unauthenticated:

```
relay: cannot read --token-file /run/secrets/relay_token: [Errno 2] No such file...
```

### What the token protects

| endpoint | with token | notes |
|---|---|---|
| `GET /health` | **open** | a monitor must be able to watch without a secret |
| `GET /` | **open** | static dashboard shell; it asks for the token, then fetches |
| `GET /state` | gated | carries notification bodies and answers |
| `GET /v1/inbox` | gated | device-facing |
| `POST /v1/notify`, `/v1/seen`, `/v1/ack`, `/v1/log` | gated | |
| `POST /v1/reset` | gated | same token wipes the queue: a leaked token is destructive |

The dashboard stores whatever token you type in `localStorage` and sends it as a bearer
header, so it works in both modes without a server-side session.

### Applications: no relay touch to add a sender

Open the dashboard, enter the operator token, and create an app per sender: a name
plus one tag prefix (e.g. `meds`). The token is shown exactly once — hand it to the
sender as its `Authorization: Bearer` value. It queues only inside its prefix and
reads only its own facts; overlapping prefixes are refused, revoking is one click
(`DELETE /v1/apps/<id>`), and nothing restarts. The API equivalents are
`GET/POST /v1/apps` (operator).

### Dashboard login

Set `DASHBOARD_USER` and `DASHBOARD_PASS` (compose passes both through; either works
from Dockhand variables or `.env`). The browser pops its native login dialog once and
remembers it per session — no more typing the bearer token to view the dashboard. The
API is untouched: senders, apps and the watch keep using bearer tokens, `/health` and
`/docs` stay open, and half-configuring (user without password) refuses to start
rather than running half-locked.

### The watch also needs the token

Not a server setting: the Side Service sends the token it reads from the phone-side app
settings (the `relay_token` field in the Zepp app's mini-program settings). If you enable
auth on the relay and leave that blank, every poll returns 401 and the watch goes quiet —
which looks exactly like a dead chain. Change both, or neither.

## Docker

The relay is a plain Python process with two writable files, so it containerises without
a wrapper.

See `compose.yaml` at the repo root (verified by building `zepp-notify-relay:1.0`
from `server/Dockerfile` and running the auth + app-key + persistence matrix against
it with plain `docker run`). Copy `.env.example` to `.env` and create
`secrets/relay_token` (`chmod 600`, gitignored).

Two environment notes that cost real debugging time:

* **SELinux.** On an enforcing host, the secrets bind-mount needs a relabel
  (`...:ro,z`), otherwise the container's `nobody` user gets `Permission denied`
  reading the token file and the relay exits 2. Docker-managed secrets do not need
  this; a file bind does.
* **Secret file permissions.** The image runs as `nobody`, so the token file must be
  readable by uid 65534 inside the container. A `600` file owned by you works through
  a `:z` bind on a single-user box; real Docker secrets mount `0444` and need no
  thought.

### Data lives at HOST_DATA_DIR

`/data` is a host-path bind (`HOST_DATA_DIR`, e.g. `/opt/docker/zepp-relay`): queue,
answers, app registry, fact log. The directory is created automatically; it must be
writable by uid 65534 (the image runs as `nobody`) — `chown 65534:65534
/path/to/dir` or equivalent. First start self-seeds an empty state, so a fresh deploy
needs nothing; to carry over an existing queue, copy your `state.json` into the
directory before the first start (only worth it for real undelivered items — the dev
copy holds test notifications that would re-render on the watch).

Token mechanism: plain `RELAY_TOKEN` variable, matching a Dockhand-managed setup. A
secrets file is stricter (invisible to `docker inspect` and `/proc/1/environ`) and the
relay still supports it (`RELAY_TOKEN_FILE` / `--token-file`) — but pick one. An env
value here plus a `secrets:` entry pointing at a file you never created crashes the
relay at startup, because an unreadable token file is treated as fatal, by design.

### The volume is part of the contract, not just storage

`state.json` holds the queue, the answers, and (once `key` ships) the idempotency memory
that lets a sender retry a timed-out POST safely. An empty volume on restart therefore
turns a retry into a duplicate notification, and a leaked/unbacked-up state file loses
every unanswered reminder. Mount `/data` deliberately and include it in backups.

### Reverse proxy and TLS

A bearer token authenticates requests; it does not protect them in transit. On a plain
HTTP LAN, a neighbour can read notification bodies and answers off the wire even though
they cannot send. Options, cheapest first:

* trust the LAN and skip TLS (the token stops writes, not sniffing);
* Tailscale, which gives you an authenticated encrypted path and no certificate work;
* a reverse proxy with real TLS (below), keeping the relay on loopback.

```caddy
# Proxy in Docker on the same internal network (see INTERNAL_NETWORK):
relay.example.lan {
    reverse_proxy relay:8097
}
```

```nginx
location / {
    proxy_pass http://127.0.0.1:8097;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;   # pass the token through
}
```

Then point the watch's phone-side relay URL at `https://relay.example.lan` and set the
same token in the app settings. In Dockhand this is all it takes: set
`INTERNAL_NETWORK` to the proxy's network (or leave it unset), create the
`relay_token` secret, up — no post-pull edits, the compose file stays canonical.

## Notes

* **Clock.** `expires_at` and the 5-minute `stuck` rule compare against the relay's clock.
  A container inherits the host clock, so keep NTP healthy on the host; a drifting clock
  expires reminders early or never.
* **Logs appear promptly.** stdout is line-buffered at startup, so `docker logs` shows the
  banner and the auth warning immediately instead of after a buffer flush.
* **Long-poll and threads.** The server is a `ThreadingHTTPServer`, so a sender's
  `/v1/events?wait=20` cannot stall the watch's `/v1/inbox`.
