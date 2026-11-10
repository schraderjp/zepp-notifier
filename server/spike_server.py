#!/usr/bin/env python3
"""Throwaway relay server for the Zepp notifier spike.

Purpose: prove the transport, not to be a product. Everything is in memory plus
one JSONL file of timestamped events, because the whole point of the spike is to
see *when* each hop happened.

Endpoints
  POST /v1/notify    queue a notification            {title, body, actions, vibrate}
  GET  /v1/inbox     what the phone polls            ?since=<timestamp cursor>
  POST /v1/ack       a watch button was pressed      {id, action, ts}
  POST /v1/log       telemetry from the phone        {event, ts, ...}
  GET  /state        machine-readable summary
  GET  /             tiny HTML dashboard (form + event log)

Auth: set RELAY_TOKEN (or --token) to require "Authorization: Bearer <token>".

Run:  python3 server/spike_server.py --port 8099
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STATE_LOCK = threading.Lock()
NOTIFICATIONS: dict[str, dict] = {}
EVENTS: list[dict] = []
SEQ = 0
MAX_EVENTS = 500
MAX_INBOX_ITEMS = 5
# Bounds duplicated renders if the watch's `seen` report is itself lost: an item is
# served at most this many times, then parked as 'abandoned' and reported.
MAX_SERVES = 10
# States that end an item's life. `rendered` is deliberately not here: it records that
# the watch accepted the notification, not that the user dealt with it. There used to be
# an `acked` member here that nothing ever wrote, which hid the fact that the one live
# terminal value — `answered` — was missing from every one of these checks.
TERMINAL_STATES = ("answered", "expired", "abandoned")
# An item served this many times without a render report means delivery is failing
# (measured: the phone-side service stops delivering payload-carrying responses after
# ~12 h / ~680 polls, while empty responses keep working). Surface it rather than let
# it look like silence.
STUCK_SERVES = int(os.environ.get('STUCK_SERVES', 3))
# With the side answering from a 12 s cache, an item can be handed to the watch
# many times without the relay ever seeing another /v1/inbox fetch that returns it
# (the side's refreshes pass peek=1), so served_count stays unset and a
# serve-count-based rule would never fire. Age is the reliable signal: an item that
# has been queued and unrendered this long is not being delivered.
STUCK_AGE_MS = int(os.environ.get('STUCK_AGE_MS', 300000))
LAST_STUCK_AT = 0
LOG_PATH = ""
STATE_PATH = ""
TOKEN = ""
# Dashboard login (human UX): DASHBOARD_USER + DASHBOARD_PASS in env. When set, the
# browser-native login dialog is the only credential a human needs: it opens the page,
# /state, app management and the test-notify box, and the browser remembers it per
# session. The operator token stays a deployment/API secret (senders, apps, the watch);
# the dashboard does not ask for it again. Writes authenticated by the login must carry
# X-Relay-Dashboard, which a cross-site form cannot set.
DASHBOARD_USER = ""
DASHBOARD_PASS = ""
DASHBOARD_WRITE_HEADER = "X-Relay-Dashboard"
# Routes the human login may reach: what the dashboard page actually calls. Everything
# else (/v1/inbox, /v1/seen, /v1/ack, /v1/log, /v1/reset, /v1/events,
# /v1/notification/*) keeps needing the operator token: the watch holds it, and the login
# must not be able to impersonate the watch or wipe state. Reading is covered by /state.
DASHBOARD_PATHS = ("/state", "/v1/apps", "/v1/notify")
# Human + machine API docs served by the relay itself (GET /docs...). Resolves to the
# repo's docs/ in dev and to the files baked into the image in Docker.
DOCS_DIR = ""
LAST_EVENT_TS = 0

# ---- v1 sender contract ----------------------------------------------------
# FACTS is the sender-facing append-only log (GET /v1/events). EVENTS stays what it
# always was: operator telemetry for /state and events.jsonl. Keeping them apart means
# a sender reading its answers does not wade through poll.served noise.
FACTS: list[dict] = []
FACT_SEQ = 0
FACT_LOCK = threading.Lock()
MAX_FACTS = int(os.environ.get('MAX_FACTS', 5000))
KEY_INDEX: dict[str, str] = {}
LAST_POLL_MS = 0

# ---- application registry (Gotify-style app keys) ---------------------------
# Operator token (RELAY_TOKEN) administers; each app gets its own bearer token bound
# to one tag prefix, created and revoked from the dashboard or API with no relay
# restart. Adding a sender never touches relay code or config: create an app, hand
# the token to the sender, done.
APPS: dict[str, dict] = {}
APP_SEQ = 0
# A sender may hold this many unrendered items before the relay pushes back. The watch
# drains 5 per ~60 s wake, so 50 is ~10 minutes of backlog: enough for a burst, small
# enough that a broken chain cannot accumulate an unbounded flood.
QUEUE_MAX = int(os.environ.get('QUEUE_MAX', 50))
CHAIN_STALE_S = int(os.environ.get('CHAIN_STALE_S', 180))
CHAIN_SILENT_S = int(os.environ.get('CHAIN_SILENT_S', 900))


class BadRequest(Exception):
    """A request the contract rejects. Carries the machine-readable code and field."""

    def __init__(self, code: str, message: str, field: str = "", status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field
        self.status = status


def now_ms() -> int:
    return int(time.time() * 1000)


def record(event: str, payload: dict) -> None:
    """Append one timestamped event.

    `gap_ms` (time since the previous event, whatever it was) is added to every
    entry so poll cadence, doze throttling and watch silence can be read straight
    off the trace with jq instead of inferred. Note it measures gaps between
    *received* events, i.e. it mixes poller drift with transport loss.
    """
    global LAST_EVENT_TS
    ts = now_ms()
    with STATE_LOCK:
        gap = (ts - LAST_EVENT_TS) if LAST_EVENT_TS else None
        LAST_EVENT_TS = ts
        entry = {"received_at": ts, "gap_ms": gap, **payload, "event": payload.get("event", event)}
        EVENTS.append(entry)
        del EVENTS[:-MAX_EVENTS]
        if LOG_PATH:
            try:
                with open(LOG_PATH, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError:
                pass


def emit_facts(items: list[dict]) -> None:
    """Append sender-facing facts and assign the cursor. Never call under STATE_LOCK."""
    global FACT_SEQ
    if not items:
        return
    with FACT_LOCK:
        for item in items:
            FACT_SEQ += 1
            item["seq"] = FACT_SEQ
            FACTS.append(item)
        del FACTS[:-MAX_FACTS]


def fact(kind: str, notif: dict, **extra) -> dict:
    """Build one fact. Fields are top-level so a sender can switch on `kind` cheaply."""
    item = {
        "kind": kind,
        "id": notif.get("id"),
        "key": notif.get("key"),
        "tag": notif.get("tag"),
        "at": now_ms(),
    }
    if kind == "queued":
        # A fact is a snapshot, not a window onto the live item. Without the copy the
        # stored `queued` fact shares its `answers`/`action` objects with the item, so a
        # sender reading the log an hour later sees an answer inside a fact that predates
        # it - which reads as "the relay answered its own prompt".
        item["notification"] = copy.deepcopy(
            {k: v for k, v in notif.items() if k != "fingerprint"}
        )
    item.update({k: v for k, v in extra.items() if v is not None})
    return item


def fingerprint(fields: dict) -> str:
    """Stable hash of the sender-controlled payload, used for retry idempotency.

    Deliberately excludes timestamps the relay assigns and includes every field that
    would change what the user sees, so "same key, same content" is a true no-op while
    "same key, corrected body" is a replacement.
    """
    keep = ("title", "body", "vibrate", "actions", "expires_at", "not_before", "extras", "tag")
    blob = json.dumps({k: fields.get(k) for k in keep}, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()


def chain_status() -> dict:
    """Liveness of the watch's poll chain, included in every queue response."""
    age = None if not LAST_POLL_MS else int((now_ms() - LAST_POLL_MS) / 1000)
    if age is None or age > CHAIN_SILENT_S:
        state = "silent"
    elif age > CHAIN_STALE_S:
        state = "stale"
    else:
        state = "online"
    with STATE_LOCK:
        depth = sum(1 for n in NOTIFICATIONS.values() if deliverable(n))
    return {"chain": state, "last_poll_age_s": age, "queue_depth": depth}


def answered(n: dict) -> bool:
    """Contract 5.5: the first answer stops the item being served, whatever `state` says.

    Delivery keys off the invariant rather than a state string, because the answer is
    recorded even when the render report was lost — the normal case on this device —
    and a future state rename must not be able to resurrect an answered prompt.
    """
    return bool(n.get("answers"))


def deliverable(n: dict) -> bool:
    """One predicate, so 'ready to serve' is defined in exactly one place."""
    if answered(n) or n.get("state") in TERMINAL_STATES:
        return False
    if n.get("rendered_at") or n.get("superseded_by"):
        return False
    if int(n.get("served_count") or 0) >= MAX_SERVES:
        return False
    now = now_ms()
    if n.get("expires_at") and int(n["expires_at"]) <= now:
        return False
    if n.get("not_before") and int(n["not_before"]) > now:
        return False
    return True


def validate_body(body: dict) -> dict:
    """Coerce and validate a /v1/notify body, or raise BadRequest.

    Truncation is used only where it is harmless and visible (title, body). Anything
    that changes meaning — an over-long button label, a bad key charset — is rejected,
    because silent truncation is how a sender ends up debugging the wrong end.
    """
    out = {}
    title = str(body.get("title") or "Notification")
    bodytext = str(body.get("body") or "")
    out["title"] = title[:40]
    out["body"] = bodytext[:160]

    vibrate = body.get("vibrate", 4)
    if vibrate is None:
        vibrate = 4
    if not isinstance(vibrate, int) or isinstance(vibrate, bool) or not 0 <= vibrate <= 5:
        raise BadRequest("invalid_vibrate", "vibrate must be an integer 0-5", "vibrate")
    out["vibrate"] = vibrate

    raw_actions = body.get("actions") or []
    if not isinstance(raw_actions, list):
        raise BadRequest("invalid_actions", "actions must be a list", "actions")
    if len(raw_actions) > 3:
        raise BadRequest("too_many_actions", "at most 3 actions", "actions")
    actions = []
    for i, a in enumerate(normalize_actions(raw_actions)):
        if not re.match(r"^[a-z0-9_]{1,16}$", a["id"]):
            raise BadRequest(
                "invalid_action_id",
                "action id must be 1-16 chars of [a-z0-9_]",
                "actions[%d].id" % i,
            )
        if not 1 <= len(a["label"]) <= 18:
            raise BadRequest(
                "invalid_action_label",
                "label must be 1-18 chars (the watch truncates at 18)",
                "actions[%d].label" % i,
            )
        actions.append({"id": a["id"], "label": a["label"]})
    out["actions"] = actions

    key = body.get("key")
    if key not in (None, ""):
        key = str(key)
        if len(key) > 64 or not re.match(r"^[ -~]+$", key):
            raise BadRequest("invalid_key", "key must be 1-64 printable ASCII chars", "key")
        out["key"] = key
    else:
        out["key"] = None

    tag = body.get("tag")
    if tag not in (None, ""):
        tag = str(tag)
        if not re.match(r"^[a-z0-9][a-z0-9._-]{0,31}$", tag):
            raise BadRequest(
                "invalid_tag", "tag must match [a-z0-9][a-z0-9._-] up to 32 chars", "tag"
            )
        out["tag"] = tag
    else:
        out["tag"] = None

    for name in ("expires_at", "not_before"):
        value = body.get(name)
        if value in (None, ""):
            out[name] = None
            continue
        try:
            out[name] = int(value)
        except (TypeError, ValueError):
            raise BadRequest(
                "invalid_%s" % name, "%s must be an epoch millisecond integer" % name, name
            )
    if out.get("expires_at") and out.get("not_before") and out["not_before"] > out["expires_at"]:
        raise BadRequest(
            "invalid_not_before", "not_before is after expires_at, so it could never be served", "not_before"
        )

    extras = body.get("extras")
    if extras in (None, ""):
        out["extras"] = {}
    else:
        if not isinstance(extras, dict) or len(extras) > 8:
            raise BadRequest("invalid_extras", "extras must be an object of at most 8 entries", "extras")
        clean = {}
        for k, v in extras.items():
            if not isinstance(v, str) or len(str(k)) > 32 or len(v) > 128:
                raise BadRequest(
                    "invalid_extras", "extras keys/values must be short strings", "extras"
                )
            clean[str(k)] = v
        out["extras"] = clean

    retract = body.get("retract")
    out["retract"] = bool(retract) if isinstance(retract, bool) else False
    return out


def normalize_actions(raw) -> list[dict]:
    """Accept ["Yes", "No"] or [{"id": "yes", "label": "Yes"}]."""
    out = []
    for item in raw or []:
        if isinstance(item, str):
            out.append({"id": item.strip().lower().replace(" ", "_"), "label": item})
        elif isinstance(item, dict) and item.get("id"):
            out.append(
                {
                    "id": str(item["id"]),
                    "label": str(item.get("label") or item["id"]),
                }
            )
    return out[:3]


def save_state() -> None:
    if not STATE_PATH:
        return
    with STATE_LOCK:
        with FACT_LOCK:
            facts = list(FACTS[-1000:])
        snapshot = {
            "notifications": NOTIFICATIONS,
            "apps": APPS,
            "app_seq": APP_SEQ,
            # Facts and the poll clock are persisted because `key` idempotency lives in
            # the item fingerprints: an empty state after a restart would turn a
            # sender's retry into a duplicate reminder.
            "facts": facts,
            "fact_seq": FACT_SEQ,
            "last_poll_ms": LAST_POLL_MS,
        }
        try:
            tmp = STATE_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(snapshot, fh)
            os.replace(tmp, STATE_PATH)
        except OSError:
            pass


def load_state() -> None:
    """Restore the queue so a relay restart does not strand undelivered items."""
    global NOTIFICATIONS, SEQ, FACTS, FACT_SEQ, LAST_POLL_MS, KEY_INDEX, APPS, APP_SEQ
    if not STATE_PATH or not os.path.exists(STATE_PATH):
        return
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
        loaded = data.get("notifications") or {}
        if isinstance(loaded, dict):
            NOTIFICATIONS = loaded
            SEQ = max([int(n.get("seq") or 0) for n in loaded.values()] + [0])
            KEY_INDEX = {
                n["key"]: n["id"] for n in loaded.values() if n.get("key") and n.get("id")
            }
        apps = data.get("apps")
        if isinstance(apps, dict):
            APPS = {str(k): v for k, v in apps.items() if isinstance(v, dict)}
            APP_SEQ = max([int(v.get("id") or 0) for v in APPS.values()] + [int(data.get("app_seq") or 0)])
            # Migrate state written before the v1 contract: those items have a single
            # `answer` string and no `answers` list. Seeding the list from the legacy
            # field keeps "answers are append-only" true across the upgrade instead of
            # silently losing the one answer that was recorded.
            for n in loaded.values():
                n.setdefault("answers", [])
                if not n["answers"] and n.get("answer"):
                    n["answers"] = [
                        {"action": n["answer"], "at": int(n.get("acked_at") or now_ms()), "seq": 1}
                    ]
                for field, default in (
                    ("key", None), ("tag", None), ("extras", {}), ("retract", False),
                    ("supersedes", None), ("superseded_by", None), ("expires_at", None),
                    ("not_before", None), ("expired_at", None), ("served_count", 0),
                    ("peek_count", 0), ("peeked_at", None),
                    ("centre_id", None), ("cancelled_at", None),
                ):
                    n.setdefault(field, default)
        facts = data.get("facts")
        if isinstance(facts, list):
            FACTS = facts
            FACT_SEQ = max([int(f.get("seq") or 0) for f in facts] + [int(data.get("fact_seq") or 0)])
        else:
            FACT_SEQ = int(data.get("fact_seq") or 0)
        LAST_POLL_MS = int(data.get("last_poll_ms") or 0)
    except (OSError, ValueError):
        pass


def create_notification(body: dict) -> tuple[dict, dict]:
    """Queue, replace or no-op, per the `key` semantics in docs/contract.md 5.1."""
    global SEQ
    clean = validate_body(body)
    fp = fingerprint(clean)
    clean["fingerprint"] = fp  # so the in-place replacement loop copies it too
    meta = {"duplicate": False, "replaced": False, "supersedes": None}
    facts: list[dict] = []

    with STATE_LOCK:
        depth = sum(1 for n in NOTIFICATIONS.values() if deliverable(n))
        if depth >= QUEUE_MAX:
            raise BadRequest(
                "queue_full",
                "queue holds %d undelivered items; the watch drains ~5/min" % depth,
                status=429,
            )

        existing = NOTIFICATIONS.get(KEY_INDEX.get(clean["key"])) if clean["key"] else None

        replaceable = (
            existing
            and existing.get("state") == "queued"
            and not existing.get("rendered_at")
            and not existing.get("answers")
            and not existing.get("superseded_by")
        )
        if replaceable:
            if existing.get("fingerprint") == fp:
                # Identical retry: the sender's POST timed out and came back. Nothing
                # changes, and it must not create a second reminder.
                meta["duplicate"] = True
                return existing, meta
            for field in (
                "title", "body", "vibrate", "actions", "expires_at", "not_before",
                "extras", "tag", "retract", "fingerprint",
            ):
                existing[field] = clean[field]
            existing["state"] = "queued"
            facts.append(fact("replaced", existing))
            meta["replaced"] = True
            notif = existing
        else:
            SEQ += 1
            notif = dict(clean)
            notif.update(
                {
                    "id": "%d-%s" % (SEQ, uuid.uuid4().hex[:6]),
                    "seq": SEQ,
                    "fingerprint": fp,
                    "created_at": now_ms(),
                    "state": "queued",
                    "supersedes": None,
                    "served_count": 0,
                    "served_at": None,
                    "peek_count": 0,
                    "peeked_at": None,
                    "rendered_at": None,
                    "answers": [],
                    "expired_at": None,
                }
            )
            if existing:
                # The predecessor is already rendered, or already answered, so it cannot
                # be rewritten in place: §5.1 only allows that while it is not yet
                # rendered *and* not yet answered (an answer is append-only). Queue a
                # successor, stop serving the old one, and let the sender decide (v2
                # replaces it properly via cancel + notify).
                notif["supersedes"] = existing["id"]
                existing["superseded_by"] = notif["id"]
                meta["supersedes"] = existing["id"]
            NOTIFICATIONS[notif["id"]] = notif
            if clean["key"]:
                KEY_INDEX[clean["key"]] = notif["id"]
            facts.append(fact("queued", notif))

    emit_facts(facts)
    record(
        "notify.queued",
        {
            "id": notif["id"],
            "title": notif["title"],
            "actions": [a["id"] for a in notif["actions"]],
            "key": notif.get("key"),
            "tag": notif.get("tag"),
            "duplicate": meta["duplicate"],
            "replaced": meta["replaced"],
        },
    )
    save_state()
    return notif, meta


def inbox(since: int, peek: bool = False) -> dict:
    global LAST_POLL_MS
    facts: list[dict] = []
    peek_served = False
    with STATE_LOCK:
        now = now_ms()

        # Expiry is a serve-time gate, not a background job: an item past its deadline
        # must never be handed over, and the sender needs a fact saying so.
        for n in NOTIFICATIONS.values():
            if (
                not answered(n)
                and n.get("state") not in TERMINAL_STATES
                and not n.get("rendered_at")
                and n.get("expires_at")
                and int(n["expires_at"]) <= now
            ):
                n["state"] = "expired"
                n["expired_at"] = now
                facts.append(fact("expired", n, reason="ttl"))

        candidates = [
            n for n in sorted(NOTIFICATIONS.values(), key=lambda x: x["created_at"]) if deliverable(n)
        ][:MAX_INBOX_ITEMS]

        abandoned = []
        for n in NOTIFICATIONS.values():
            if (
                not answered(n)
                and n.get("state") not in ("expired", "abandoned")
                and not n.get("rendered_at")
                and not n.get("superseded_by")
                and int(n.get("served_count") or 0) >= MAX_SERVES
            ):
                n["state"] = "abandoned"
                abandoned.append((n["id"], n.get("served_count")))
                facts.append(fact("abandoned", n, served=n.get("served_count")))

        items = [
            {
                "id": n["id"],
                "title": n["title"],
                "body": n["body"],
                "vibrate": n["vibrate"],
                "actions": n["actions"],
            }
            for n in candidates
        ]
        if not peek:
            # Only a real handover to the watch counts as a serve. The side's cache
            # refresh asks every 12 s and must not inflate this, or `stuck` would
            # fire on any item older than half a minute.
            for n in candidates:
                n["served_count"] = int(n.get("served_count") or 0) + 1
                n["served_at"] = now
            LAST_POLL_MS = now
        elif candidates:
            # Peek serves are counted, just not as serves. They say the item reached the
            # PHONE's cache, which is the earlier half of the delivery path: without this
            # counter GET /v1/notification/<id> showed a rendered item with
            # served_count 0 and no way to tell "never handed to a wrist" from "handed
            # over, then vanished". Kept as a separate field so neither reading of
            # served_count changes for existing senders.
            for n in candidates:
                n["peek_count"] = int(n.get("peek_count") or 0) + 1
                n["peeked_at"] = now
            peek_served = True

        # Which notification-centre ids should the watch delete? An answered reminder
        # has had its attention, a superseded item has been replaced, and an expired
        # item the sender marked `retract` is stale. All three are clutter on the wrist.
        # The list repeats on every wake until the device confirms, because a lost
        # response must cost a retry, not a stranded notification.
        cancel_ids = []
        for n in NOTIFICATIONS.values():
            if not n.get("centre_id") or n.get("cancelled_at"):
                continue
            if (
                n.get("state") == "answered"
                or n.get("superseded_by")
                or (n.get("state") == "expired" and n.get("retract"))
            ):
                try:
                    cancel_ids.append(int(n["centre_id"]))
                except (TypeError, ValueError):
                    pass

        now = now_ms()
        stuck = (
            []
            if peek
            else [
                n["id"]
                for n in candidates
                if int(n.get("served_count") or 0) >= STUCK_SERVES
                or (now - int(n.get("created_at") or now)) >= STUCK_AGE_MS
            ]
        )

    if items or abandoned or facts or peek_served:
        save_state()
    emit_facts(facts)
    for nid, served in abandoned:
        record("notify.abandoned", {"id": nid, "served": served})
    global LAST_STUCK_AT
    if stuck and now_ms() - LAST_STUCK_AT > 60000:
        LAST_STUCK_AT = now_ms()
        record("notify.stuck", {"ids": stuck[:5], "count": len(stuck), "serves": STUCK_SERVES})
    return {
        "cursor": 0,
        "items": items,
        "cancel": cancel_ids[:5],
        "server_time": now_ms(),
        "mode": "ack-driven",
        "stuck": bool(stuck),
        "stuck_ids": stuck[:3],
    }


def seen(body: dict) -> dict:
    """The watch reports what it actually put in the notification centre.

    This is the only thing that stops an item being served again, so it is sent from
    the device in the same wake it rendered, over the device->phone direction that
    works even when responses do not arrive.
    """
    raw = body.get("ids")
    ids = [str(i) for i in raw] if isinstance(raw, list) else []
    # relay id -> notification-centre id, so the relay can ask the watch to cancel a
    # notification later without the device persisting anything. Each wake is a fresh
    # JS context, so the map has to live on the relay.
    centre = {}
    if isinstance(body.get("centre"), dict):
        for k, v in body["centre"].items():
            try:
                centre[str(k)] = int(v)
            except (TypeError, ValueError):
                pass
    cancelled = set()
    if isinstance(body.get("cancelled"), list):
        for c in body["cancelled"]:
            try:
                cancelled.add(int(c))
            except (TypeError, ValueError):
                pass
    marked = 0
    mapped = 0
    cancelled_now = 0
    facts: list[dict] = []
    with STATE_LOCK:
        for nid in ids:
            notif = NOTIFICATIONS.get(nid)
            if notif and not notif.get("rendered_at"):
                notif["rendered_at"] = now_ms()
                # A late report is real information — the notification did reach the
                # centre — but it must not demote a terminal state. In particular an
                # answer that arrived before the report keeps `answered`, or the item
                # silently drops off the cancel list and stays on the wrist (§5.3).
                if not answered(notif) and notif.get("state") not in TERMINAL_STATES:
                    notif["state"] = "rendered"
                marked += 1
                facts.append(fact("rendered", notif))
            if notif is not None and nid in centre and notif.get("centre_id") != centre[nid]:
                notif["centre_id"] = centre[nid]
                mapped += 1

        # The device confirms each cancel it performed, so the relay only stops asking
        # once the notification is actually gone rather than assuming the frame arrived.
        if cancelled:
            for notif in NOTIFICATIONS.values():
                cid = notif.get("centre_id")
                if not cid or notif.get("cancelled_at"):
                    continue
                if cid in cancelled:
                    notif["cancelled_at"] = now_ms()
                    cancelled_now += 1

    if marked or mapped or cancelled_now:
        save_state()
    emit_facts(facts)
    record(
        "notify.rendered",
        {"ids": ids, "marked": marked, "mapped": mapped, "cancelled": cancelled_now, "source": "device"},
    )
    return {"ok": True, "marked": marked, "mapped": mapped, "cancelled": cancelled_now}


def ack(body: dict) -> dict:
    """One button press. Answers append; identical retries collapse."""
    nid = str(body.get("id") or "")
    action = str(body.get("action") or "")
    added = None
    with STATE_LOCK:
        notif = NOTIFICATIONS.get(nid)
        if notif:
            answers = notif.setdefault("answers", [])
            if not any(a.get("action") == action for a in answers):
                answers.append({"action": action, "at": now_ms(), "seq": len(answers) + 1})
                added = fact("answered", notif, action=action)
            notif["state"] = "answered"
            notif["answer"] = action  # legacy mirror of the latest answer
            notif["acked_at"] = now_ms()
    if added is not None:
        emit_facts([added])
    owned = nid.startswith("test_")
    record(
        "ack.received",
        {
            "id": nid,
            "action": action,
            "device_ts": body.get("ts"),
            "transit_ms": (now_ms() - body["ts"]) if isinstance(body.get("ts"), int) else None,
            "replay": bool(body.get("replay")),
            "owned": owned,
            "known": bool(notif),
            "appended": added is not None,
        },
    )
    if notif:
        save_state()
    toast = "Recorded" if owned else ("Got it: " + action if action else "Got it")
    return {"ok": True, "toast": toast, "action": action}


def resolve_since(since: str) -> int:
    """Map a caller cursor to a fact seq.

    Accepts an opaque seq, "all", or a duration like "10m". The duration form is
    borrowed from ntfy: a sender that restarted should not have to remember a cursor to
    say "the last ten minutes".
    """
    if since in ("", "all", None):
        return 0
    if re.match(r"^\d+$", str(since)):
        return int(since)
    m = re.match(r"^(\d+)([smhd])$", str(since))
    if m:
        mult = {"s": 1000, "m": 60000, "h": 3600000, "d": 86400000}[m.group(2)]
        cutoff = now_ms() - int(m.group(1)) * mult
        with FACT_LOCK:
            for f in FACTS:
                if int(f.get("at") or 0) >= cutoff:
                    return int(f["seq"]) - 1
        return FACT_SEQ
    raise BadRequest(
        "invalid_since", "since must be a cursor, 'all', or a duration like 10m", "since"
    )


def tag_matches(fact_tag, wanted: str) -> bool:
    """Tag filters match exactly or by dotted prefix: ?tag=meds also matches
    meds.evening, which is what makes a single-string tag enough (5.2)."""
    if not wanted:
        return True
    fact_tag = fact_tag or ""
    return fact_tag == wanted or fact_tag.startswith(wanted + ".")


def events_page(since: str, kinds: set, tag: str, wait: int, limit: int) -> dict:
    """Facts after `since`, optionally long-polled.

    The wait is implemented by re-checking with a short sleep rather than a condition
    variable: the mutators already hold a lock that non-reentrant code cannot re-enter,
    and a homelab poll loop costs nothing at this rate. No lock is held across the wait,
    so the watch's /v1/inbox cannot be blocked behind a sender's long-poll.
    """
    start = resolve_since(since)
    deadline = time.time() + max(0, wait)

    while True:
        with FACT_LOCK:
            oldest = FACTS[0]["seq"] if FACTS else FACT_SEQ + 1
            snapshot = list(FACTS)
        if start and start < oldest - 1:
            raise BadRequest(
                "cursor_too_old",
                "cursor %d is older than retained facts (oldest is %d)" % (start, oldest),
                "since",
                status=409,
            )
        matched = [
            f
            for f in snapshot
            if f["seq"] > start and (not kinds or f["kind"] in kinds) and tag_matches(f.get("tag"), tag)
        ]
        if matched or time.time() >= deadline:
            page = matched[:limit]
            return {
                "facts": page,
                "next": str(page[-1]["seq"] if page else start),
                "more": len(matched) > len(page),
                "oldest_seq": oldest,
            }
        time.sleep(0.25)


def _bearer() -> str:
    return ""


def app_lookup(token: str):
    """Return the app bound to this sender token, or None."""
    import hashlib as _hl

    digest = _hl.sha256(token.encode("utf-8")).hexdigest()
    with STATE_LOCK:
        for app in APPS.values():
            if app.get("token_hash") == digest:
                return dict(app)
    return None


def auth_role(header: str):
    """(role, app): operator > app > none. No TOKEN configured means open dev."""
    if not TOKEN:
        return ("open", None)
    header = (header or "").strip()
    if header == "Bearer " + TOKEN:
        return ("operator", None)
    if header.startswith("Bearer ") and len(header) > 7:
        # "Bearer " is 7 chars; [8:] was silently chopping the token's first char.
        app = app_lookup(header[7:].strip())
        if app:
            return ("app", app)
    return ("none", None)


def prefix_allowed(app_prefix: str, tag) -> bool:
    """App tokens may only use their own prefix (exact or dotted child)."""
    if not tag:
        return False
    tag = str(tag)
    return tag == app_prefix or tag.startswith(app_prefix + ".")


class Handler(BaseHTTPRequestHandler):
    server_version = "SpikeRelay/0.1"

    def log_message(self, fmt, *args):  # keep stdout readable
        return

    def _send(self, code: int, payload, content_type="application/json", extra_headers=None) -> None:
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload).encode("utf-8")
        else:
            body = str(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _serve_docs(self, name: str) -> None:
        """API docs for humans and machines. Open by design: the contract, schemas and
        hosting notes contain no secrets (no tokens, no notification bodies), and an
        LLM agent configuring a sender needs them without a credential."""
        files = {
            "contract.md": ("text/markdown; charset=utf-8", "contract.md"),
            "hosting.md": ("text/markdown; charset=utf-8", "hosting.md"),
            "schema-as-implemented.json": ("application/json", "schema-as-implemented.json"),
            "schema-v1.json": ("application/json", "schema-v1.json"),
        }
        if name == "index.json":
            return self._send(
                200,
                {
                    "contract": "contract.md",
                    "schemas": ["schema-as-implemented.json", "schema-v1.json"],
                    "hosting": "hosting.md",
                    "note": "schema-as-implemented.json describes this exact relay; start there, then read contract.md",
                },
            )
        if name not in files:
            return self._send(404, {"error": "not found"})
        ctype, fname = files[name]
        path = os.path.join(DOCS_DIR, fname)
        try:
            with open(path, "rb") as fh:
                body = fh.read()
        except OSError:
            return self._send(404, {"error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _serve_docs_page(self) -> None:
        html = (
            "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            "<title>relay API docs</title>"
            "<style>body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;padding:20px;max-width:760px;background:#111;color:#eee}"
            "table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #333;text-align:left;padding:4px 6px;vertical-align:top}"
            "code{background:#222;padding:1px 5px;border-radius:4px}a{color:#7fd18d}</style>"
            "<h1>Notify Relay — API</h1>"
            "<p>Senders queue with <code>POST /v1/notify</code> and observe with "
            "<code>GET /v1/events</code>; the watch pulls <code>GET /v1/inbox</code> and reports "
            "through <code>POST /v1/seen</code> / <code>POST /v1/ack</code>. Delivery is "
            "ack-driven and at-least-once: items are served until reported rendered.</p>"
            "<h2>Endpoints</h2>"
            "<table><tr><th>method</th><th>path</th><th>who</th><th>purpose</th></tr>"
            "<tr><td>POST</td><td><code>/v1/notify</code></td><td>sender</td><td>queue or replace (<code>key</code>), idempotent retry</td></tr>"
            "<tr><td>GET</td><td><code>/v1/events?since&amp;kind&amp;tag&amp;wait&amp;limit</code></td><td>sender</td><td>append-only facts, cursor-resumable, long-poll</td></tr>"
            "<tr><td>GET</td><td><code>/v1/notification/&lt;id&gt;</code></td><td>sender</td><td>reconcile one item</td></tr>"
            "<tr><td>GET</td><td><code>/health</code></td><td>anyone</td><td>liveness + chain state, no token needed</td></tr>"
            "<tr><td>GET</td><td><code>/v1/apps</code></td><td>operator</td><td>list sender applications</td></tr>"
            "<tr><td>POST</td><td><code>/v1/apps</code></td><td>operator</td><td>create an app (token shown once)</td></tr>"
            "<tr><td>DELETE</td><td><code>/v1/apps/&lt;id&gt;</code></td><td>operator</td><td>revoke an app</td></tr>"
            "<tr><td>GET</td><td><code>/v1/inbox</code></td><td>device</td><td>items to render (<code>?peek=1</code> = cache refresh)</td></tr>"
            "<tr><td>POST</td><td><code>/v1/seen</code> <code>/v1/ack</code></td><td>device</td><td>render reports, answers</td></tr>"
            "</table>"
            "<h2>Machine-readable</h2>"
            "<ul><li><a href='/docs/index.json'>index.json</a> — where to start</li>"
            "<li><a href='/docs/schema-as-implemented.json'>schema-as-implemented.json</a> — this relay, verified live</li>"
            "<li><a href='/docs/schema-v1.json'>schema-v1.json</a> — the v1 contract</li>"
            "<li><a href='/docs/contract.md'>contract.md</a> — full semantics</li>"
            "<li><a href='/docs/hosting.md'>hosting.md</a> — docker, TLS, migration</li></ul>"
            "<p>App tokens own one tag prefix; the operator token administers and is what "
            "the phone side holds. A sender that wants to integrate starts at "
            "<code>index.json</code>.</p>"
        )
        self._send(200, html, "text/html; charset=utf-8")

    def _error(self, exc: "BadRequest") -> None:
        """Rejections carry a machine-readable code and the offending field."""
        payload = {"error": {"code": exc.code, "message": exc.message}}
        if exc.field:
            payload["error"]["field"] = exc.field
        # A 429 without guidance just gets retried immediately; say how long to wait.
        headers = {"Retry-After": "60"} if exc.status == 429 else None
        self._send(exc.status, payload, extra_headers=headers)

    def _dashboard_ok(self) -> bool:
        """Human login for / and /state. Open when no dashboard user is configured."""
        if not DASHBOARD_USER:
            return True
        import base64 as _b64
        import hmac as _hm

        header = (self.headers.get("Authorization") or "").strip()
        if not header.startswith("Basic "):
            return False
        try:
            decoded = _b64.b64decode(header[6:].strip()).decode("utf-8")
        except Exception:
            return False
        return _hm.compare_digest(decoded, DASHBOARD_USER + ":" + DASHBOARD_PASS)

    def _require_dashboard(self) -> bool:
        if self._dashboard_ok():
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="relay"')
        self.send_header("Content-Type", "application/json")
        body = json.dumps({"error": "dashboard login required"}).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def _authorized(self) -> bool:
        role, _ = auth_role(self.headers.get("Authorization") or "")
        return role in ("open", "operator", "app")

    def _auth(self):
        """(role, app). The dashboard login is a role of its own, not a bearer alias.

        It is accepted only where the dashboard page actually calls, so the human
        password can never drive the watch or wipe state. Bearer still wins, and an
        open relay (no TOKEN) stays "open" rather than pretending to be a login.
        """
        role, app = auth_role(self.headers.get("Authorization") or "")
        if role == "none" and DASHBOARD_USER and self._dashboard_ok():
            return ("dashboard", None)
        return (role, app)

    def _dashboard_write_ok(self) -> bool:
        """A cross-site form can carry the browser's cached Basic credential but cannot
        add a custom header, and this relay answers no CORS preflight. Requiring one on
        writes keeps the dashboard login from being usable as CSRF."""
        return (self.headers.get(DASHBOARD_WRITE_HEADER) or "").strip() == "1"

    def _require(self, *roles):
        role, app = self._auth()
        if role not in roles:
            if role == "none":
                self._send(401, {"error": "unauthorized"})
            else:
                self._send(403, {"error": {"code": "forbidden", "message": "operator only"}})
            return None
        return (role, app)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            record("http.empty_body", {"path": self.path, "content_type": self.headers.get("Content-Type")})
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            # Most common real-world failure: shell ate the quotes, so the body is
            # not JSON at all. Without this event it looked like an empty request.
            record(
                "http.bad_json",
                {
                    "path": self.path,
                    "error": str(exc),
                    "raw": raw[:300].decode("utf-8", "replace"),
                    "content_type": self.headers.get("Content-Type"),
                },
            )
            return {}

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            # Open by design: a monitor must be able to watch without a secret. It
            # carries chain liveness because a stopped chain is otherwise
            # indistinguishable from an empty queue.
            with STATE_LOCK:
                queued = len(NOTIFICATIONS)
                oldest = FACTS[0]["seq"] if FACTS else FACT_SEQ + 1
            chain = chain_status()
            return self._send(
                200,
                {
                    "ok": True,
                    "auth": bool(TOKEN),
                    "chain": chain,
                    "queue_depth": chain["queue_depth"],
                    "queued": queued,
                    "next_seq": SEQ,
                    "oldest_seq": oldest,
                },
            )
        # Everything except /health and the dashboard shell needs a credential when one
        # is configured: the operator/app bearer token, or the dashboard login for the
        # routes that page itself calls. /state stays behind one of them: it carries
        # notification bodies and answers, and a token that protects writes while
        # exposing reads is worse than no token because it misleads.
        if parsed.path == "/docs" or parsed.path == "/docs/":
            return self._serve_docs_page()
        if parsed.path == "/docs/index.json" or parsed.path.startswith("/docs/"):
            return self._serve_docs(parsed.path.rsplit("/", 1)[-1])
        if parsed.path not in ("/health", "/"):
            role, _app = self._auth()
            if role == "none":
                return self._send(401, {"error": "unauthorized"})
            if role == "dashboard" and parsed.path not in DASHBOARD_PATHS:
                return self._send(403, {"error": {"code": "forbidden", "message": "operator token required"}})
            # Device endpoints serve every tag, so they stay operator-only: the
            # phone side holds the operator token. App tokens are sender-scoped.
            if parsed.path in ("/v1/inbox", "/v1/seen", "/v1/ack", "/v1/log", "/v1/reset", "/state") and role == "app":
                return self._send(403, {"error": {"code": "forbidden", "message": "operator only"}})

        if parsed.path == "/v1/inbox":
            query = parse_qs(parsed.query)
            since = int((query.get("since") or ["0"])[0] or 0)
            # peek=1 is the side's cache refresh: it must not count as a handover to
            # the watch, or served_count (and therefore `stuck`) becomes meaningless.
            peek = (query.get("peek") or ["0"])[0] in ("1", "true")
            return self._send(200, inbox(since, peek))
        if parsed.path == "/v1/apps":
            auth = self._require("open", "operator", "dashboard")
            if not auth:
                return None
            role, _ = auth
            if role == "app":
                return self._send(403, {"error": {"code": "forbidden", "message": "operator only"}})
            with STATE_LOCK:
                rows = [
                    {k: a[k] for k in ("id", "name", "prefix", "created_at", "token_preview") if k in a}
                    for a in sorted(APPS.values(), key=lambda a: a["id"])
                ]
            return self._send(200, {"apps": rows})

        if parsed.path == "/v1/events":
            try:
                role, app = self._auth()
                query = parse_qs(parsed.query)

                def one(name, default=""):
                    return (query.get(name) or [default])[0]

                try:
                    wait = max(0, min(30, int(one("wait", "0") or 0)))
                    limit = max(1, min(500, int(one("limit", "100") or 100)))
                except ValueError:
                    raise BadRequest("invalid_wait", "wait and limit must be integers")
                kinds = {k.strip() for k in one("kind").split(",") if k.strip()}
                tag = one("tag")
                if role == "app":
                    # Sender-scoped: an app token sees only its own prefix. A tag
                    # outside it is rejected rather than silently emptied, so a
                    # misconfigured sender learns immediately.
                    if tag and not prefix_allowed(app["prefix"], tag):
                        raise BadRequest("forbidden_tag", "tag outside this app's prefix", "tag", status=403)
                    tag = tag or app["prefix"]
                return self._send(200, events_page(one("since"), kinds, tag, wait, limit))
            except BadRequest as exc:
                return self._error(exc)

        if parsed.path.startswith("/v1/notification/"):
            role, app = self._auth()
            nid = parsed.path.rsplit("/", 1)[-1]
            with STATE_LOCK:
                found = NOTIFICATIONS.get(nid)
                payload = dict(found) if found else None
            if not payload:
                return self._error(BadRequest("not_found", "no such notification", status=404))
            if role == "app" and not prefix_allowed(app["prefix"], payload.get("tag")):
                # Same shape as missing: an app token must not learn whether
                # another app's notification exists.
                return self._error(BadRequest("not_found", "no such notification", status=404))
            payload.pop("fingerprint", None)
            return self._send(200, payload)

        if parsed.path == "/state":
            role_state, _ = self._auth()
            if role_state == "app":
                return self._send(403, {"error": {"code": "forbidden", "message": "operator only"}})
            # Either credential works: the operator bearer token (dashboard JS,
            # apps API) or the dashboard login (browser dialog). App tokens stay
            # out; /state carries notification bodies and answers.
            if role_state == "none" and not self._require_dashboard():
                return None
            with STATE_LOCK:
                recent = EVENTS[-60:]
            return self._send(
                200,
                {
                    "next_seq": SEQ,
                    "cursor_note": "the poll cursor is a created_at timestamp, not next_seq",
                    "notifications": list(NOTIFICATIONS.values())[-20:],
                    "events": recent,
                },
                extra_headers={"Cache-Control": "no-store"},
            )
        if parsed.path == "/":
            if not self._require_dashboard():
                return None
            return self._send(
                200, dashboard_html(), "text/html; charset=utf-8",
                {"Cache-Control": "no-store"},
            )
        return self._send(404, {"error": "not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            role, _ = self._auth()
            if role == "none":
                return self._send(401, {"error": "unauthorized"})
            path = urlparse(self.path).path
            if role == "dashboard" and not self._dashboard_write_ok():
                return self._send(403, {"error": {"code": "csrf_header_required", "message": "dashboard writes need %s: 1" % DASHBOARD_WRITE_HEADER}})
            if path.startswith("/v1/apps/"):
                if role not in ("operator", "dashboard") and not (role == "open" and not TOKEN):
                    return self._send(403 if role == "app" else 401, {"error": {"code": "forbidden", "message": "operator only"}})
                return self._apps_revoke(path.rsplit("/", 1)[-1])
            return self._send(404, {"error": "not found"})
        except BadRequest as exc:
            self._error(exc)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._post()
        except BadRequest as exc:
            self._error(exc)

    def _apps_create(self, body: dict) -> None:
        import hashlib as _hl
        import secrets as _secrets

        global APP_SEQ
        name = str(body.get("name") or "").strip()[:40]
        prefix = str(body.get("prefix") or "").strip()
        if not name:
            return self._error(BadRequest("invalid_name", "name is required", "name"))
        import re as _re

        if not _re.match(r"^[a-z0-9][a-z0-9._-]{0,31}$", prefix):
            return self._error(BadRequest("invalid_tag", "prefix must match [a-z0-9][a-z0-9._-] up to 32 chars", "prefix"))
        with STATE_LOCK:
            for a in APPS.values():
                other = a.get("prefix") or ""
                if other == prefix or prefix.startswith(other + ".") or other.startswith(prefix + "."):
                    return self._error(
                        BadRequest("prefix_taken", "prefix overlaps app %r (%s)" % (a.get("name"), other), "prefix", status=409)
                    )
            APP_SEQ += 1
            token = _secrets.token_urlsafe(24)
            APP_SEQ_LOCAL = APP_SEQ
        digest = _hl.sha256(token.encode("utf-8")).hexdigest()
        with STATE_LOCK:
            APPS[str(APP_SEQ_LOCAL)] = {
                "id": APP_SEQ_LOCAL,
                "name": name,
                "prefix": prefix,
                "token_hash": digest,
                "token_preview": token[:4] + "..." + token[-2:],
                "created_at": now_ms(),
            }
        save_state()
        record("app.created", {"id": APP_SEQ_LOCAL, "name": name, "prefix": prefix})
        # The plaintext token is returned exactly once, like Gotify: it is never
        # stored and cannot be listed again. Lose it and you revoke + recreate.
        return self._send(201, {"id": APP_SEQ_LOCAL, "name": name, "prefix": prefix, "token": token})

    def _apps_revoke(self, app_id: str) -> None:
        with STATE_LOCK:
            app = APPS.pop(str(app_id), None)
        if not app:
            return self._error(BadRequest("not_found", "no such app", status=404))
        save_state()
        record("app.revoked", {"id": app.get("id"), "name": app.get("name"), "prefix": app.get("prefix")})
        return self._send(200, {"ok": True, "id": app.get("id")})

    def _post(self) -> None:
        role, app = self._auth()
        if role == "none":
            return self._send(401, {"error": "unauthorized"})
        body = self._read_json()
        path = urlparse(self.path).path

        if role == "dashboard":
            if path not in DASHBOARD_PATHS:
                return self._send(403, {"error": {"code": "forbidden", "message": "operator token required"}})
            if not self._dashboard_write_ok():
                return self._send(403, {"error": {"code": "csrf_header_required", "message": "dashboard writes need %s: 1" % DASHBOARD_WRITE_HEADER}})

        if path == "/v1/apps":
            if role not in ("operator", "dashboard") and not (role == "open" and not TOKEN):
                return self._send(403 if role == "app" else 401, {"error": {"code": "forbidden", "message": "operator only"}})
            return self._apps_create(body)

        if path in ("/v1/inbox", "/v1/seen", "/v1/ack", "/v1/log", "/v1/reset", "/state"):
            # Device + ops endpoints serve every tag, so app tokens stay out: the
            # phone side holds the operator token.
            if role == "app":
                return self._send(403, {"error": {"code": "forbidden", "message": "operator only"}})

        if path == "/v1/notify":
            if role == "app":
                tag = body.get("tag")
                if not prefix_allowed(app["prefix"], tag):
                    return self._error(
                        BadRequest("forbidden_tag", "tag outside this app's prefix (owns %s)" % app["prefix"], "tag", status=403)
                    )
            notif, meta = create_notification(body)
            # A missing title or an actionless notification is almost always a
            # malformed request rather than a watch problem, so say so in the reply.
            warnings = []
            if not body.get("title"):
                warnings.append("no 'title' field received")
            elif not notif["actions"]:
                warnings.append("notification stored with no action buttons")
            payload = {
                "id": notif["id"],
                "key": notif.get("key"),
                "tag": notif.get("tag"),
                "state": notif["state"],
                "duplicate": meta["duplicate"],
                "supersedes": meta["supersedes"],
                "replaced": meta["replaced"],
                "chain": chain_status(),
            }
            if warnings:
                payload["warnings"] = warnings
            # 200 for "nothing new happened" (retry or in-place replacement), 201 for a
            # newly queued item.
            return self._send(200 if (meta["duplicate"] or meta["replaced"]) else 201, payload)
        if path == "/v1/seen":
            return self._send(200, seen(body))

        if path == "/v1/ack":
            return self._send(200, ack(body))
        if path == "/v1/log":
            global LAST_POLL_MS
            event = str(body.get("event") or "unknown")
            if event in ("poll.served", "poll.nores"):
                # Chain liveness used to be inferred from a non-peek /v1/inbox. Since the
                # side answers the watch from its 12 s cache it only ever calls inbox with
                # peek=1, so the relay would never learn that the watch woke and `chain`
                # would read "silent" on a perfectly healthy chain. The side's own poll
                # report is the honest signal: it is sent when the watch actually asked.
                with STATE_LOCK:
                    LAST_POLL_MS = now_ms()
            record(event, body)
            return self._send(200, {"ok": True})
        if path == "/v1/reset":
            with STATE_LOCK:
                NOTIFICATIONS.clear()
                EVENTS.clear()
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})


DASHBOARD_HTML = """<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zepp-notifier spike</title>
<style>
 body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}
 h1{font-size:18px;margin:0 0 12px}
 form{background:#1b1b1b;padding:12px;border-radius:8px;margin-bottom:16px}
 input,button{font:inherit;padding:8px;border-radius:6px;border:1px solid #333;background:#222;color:#eee;width:100%;margin:4px 0;box-sizing:border-box}
 button{background:#2d6ca3;border-color:#2d6ca3;font-weight:600}
 table{width:100%;border-collapse:collapse;font-size:12px}
 td,th{text-align:left;padding:3px 4px;border-bottom:1px solid #222;vertical-align:top}
 .e-notify\\.shown{color:#7fd18d}.e-ack\\.received{color:#ffd479}.e-poll\\.error,.e-ack\\.failed{color:#ff8f8f}
</style>
<h1>zepp-notifier spike relay</h1>\n<p style="color:#888;font-size:12px">API docs for humans and machines: <a href="/docs" style="color:#7fd18d">/docs</a></p>
<form id="f">
__TOKEN_INPUT__
 <input name="title" placeholder="Title" value="Medication">
 <input name="body" placeholder="Body" value="Did you take your morning medication?">
 <input name="actions" placeholder="Actions, comma separated" value="Yes,No,Snooze">
 <button>Send notification</button>
</form>
<h1 style="font-size:15px;margin:16px 0 8px">Applications <span style="font-weight:400;font-size:12px;color:#888">one tag prefix each; the app token is shown once</span></h1>
<form id="appform">
 <input name="name" placeholder="App name, e.g. Meds" style="width:38%;display:inline-block">
 <input name="prefix" placeholder="tag prefix, e.g. meds" style="width:38%;display:inline-block">
 <button style="width:22%;display:inline-block">Create app</button>
</form>
<div id="apptoken" style="background:#1b1b1b;padding:8px;border-radius:8px;margin-bottom:12px;display:none;font-size:12px"></div>
<table><thead><tr><th>app</th><th>prefix</th><th>token</th><th></th></tr></thead><tbody id="apps"></tbody></table>
<table style="margin-top:16px"><thead><tr><th>t</th><th>event</th><th>detail</th></tr></thead><tbody id="rows"></tbody></table>
<script>
// With DASHBOARD_USER/PASS set, the browser already carries the login and the relay
// accepts it for this page's calls: there is no bearer token to type. Without a login
// (dev / open relay) the operator token is typed here and kept in localStorage.
const DASHBOARD_LOGIN = __DASHBOARD_LOGIN__;
const tokEl = document.getElementById('tok');
if (tokEl) {
  tokEl.value = localStorage.getItem('relay_token') || '';
  tokEl.addEventListener('change', () => {
    localStorage.setItem('relay_token', tokEl.value.trim());
    refresh(); refreshApps();
  });
}
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (DASHBOARD_LOGIN) {
    // The login is ambient (a browser sends cached Basic auth on any same-origin
    // request, including a cross-site form POST), so a custom header is what proves
    // the caller is this page. The relay rejects dashboard writes without it.
    h['X-Relay-Dashboard'] = '1';
    return h;
  }
  const t = tokEl.value.trim();
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}
const f = document.getElementById('f');
f.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(f);
  await fetch('/v1/notify', {method:'POST',headers:authHeaders({'Content-Type':'application/json'}),
    body: JSON.stringify({title: fd.get('title'), body: fd.get('body'),
      actions: String(fd.get('actions')||'').split(',').map(s=>s.trim()).filter(Boolean)})});
  refresh();
});
function detail(e){const c={...e};['event','received_at'].forEach(k=>delete c[k]);return JSON.stringify(c)}
const appform = document.getElementById('appform');
appform.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(appform);
  const r = await fetch('/v1/apps', {method:'POST',headers:authHeaders({'Content-Type':'application/json'}),
    body: JSON.stringify({name: fd.get('name'), prefix: fd.get('prefix')})});
  const d = await r.json().catch(()=>({}));
  const box = document.getElementById('apptoken');
  if (r.ok && d.token) {
    box.style.display = 'block';
    box.innerHTML = 'Token for <b>' + d.name + '</b> (shown once, copy it now): <code>' + d.token + '</code>';
    appform.reset();
  } else {
    box.style.display = 'block';
    box.textContent = 'Create failed (' + r.status + '): ' + JSON.stringify(d);
  }
  refreshApps();
});
async function revokeApp(id){
  if (!confirm('Revoke app ' + id + '? Its token stops working immediately.')) return;
  await fetch('/v1/apps/' + id, {method:'DELETE',headers:authHeaders()});
  refreshApps();
}
async function refreshApps(){
  try{
    const r = await fetch('/v1/apps', {headers: authHeaders()});
    if (!r.ok) {
      document.getElementById('apps').innerHTML = '<tr><td colspan=4>' + (r.status === 401 ? 'enter the operator token above' : 'operator only (app tokens cannot manage apps)') + '</td></tr>';
      return;
    }
    const d = await r.json();
    document.getElementById('apps').innerHTML = (d.apps || []).map(a =>
      `<tr><td>${a.name}</td><td><code>${a.prefix}</code></td><td><code>${a.token_preview || ''}</code></td><td><button onclick="revokeApp(${a.id})">revoke</button></td></tr>`
    ).join('') || '<tr><td colspan=4>no apps yet — create one above</td></tr>';
  }catch(e){}
}
async function refresh(){
  try{
    const r = await fetch('/state', {headers: authHeaders()});
    if (r.status === 401) {
      document.getElementById('rows').innerHTML = '<tr><td colspan=3>unauthorized - enter the relay token above</td></tr>';
      return;
    }
    const s = await r.json();
    const rows = s.events.slice().reverse().map(e => {
      const t = new Date(e.received_at).toLocaleTimeString();
      return `<tr><td>${t}</td><td class="e-${e.event.replace(/\\./g,'\\\\.')}">${e.event}</td><td>${detail(e)}</td></tr>`;
    }).join('');
    document.getElementById('rows').innerHTML = rows || '<tr><td colspan=3>no events yet</td></tr>';
  }catch(e){}
}
refresh(); refreshApps(); setInterval(refresh, 3000); setInterval(refreshApps, 10000);
</script>
"""

TOKEN_INPUT_HTML = ' <input id="tok" placeholder="relay token (leave blank for dev)" autocomplete="off">'


def dashboard_html() -> str:
    """Dashboard shell, with the bearer-token field only when there is no login.

    With DASHBOARD_USER/PASS set the browser holds a credential the relay accepts for
    this page's own calls, so asking for the operator token again is precisely the
    friction the login exists to remove. Without a login (dev / open relay) the field
    stays: that is how the apps API and the send box authenticate.
    """
    manual = not DASHBOARD_USER
    return DASHBOARD_HTML.replace(
        "__TOKEN_INPUT__", TOKEN_INPUT_HTML if manual else ""
    ).replace("__DASHBOARD_LOGIN__", "false" if manual else "true")


def main() -> None:
    global LOG_PATH, STATE_PATH, TOKEN
    # Container logs are a pipe, and Python block-buffers a pipe: without this the
    # startup banner (including "auth DISABLED" and the exposure warning) can be
    # invisible for minutes under `docker logs`.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--log", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "log", "events.jsonl"))
    parser.add_argument("--state", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "log", "state.json"))
    parser.add_argument("--token", default=os.environ.get("RELAY_TOKEN", ""))
    # Docker secrets and Dockhand store the value in a file, so support that without
    # forcing it into the process environment (where `docker inspect` and
    # /proc/1/environ expose it). Precedence: --token, then --token-file.
    parser.add_argument("--token-file", default=os.environ.get("RELAY_TOKEN_FILE", ""))
    args = parser.parse_args()

    LOG_PATH = args.log
    STATE_PATH = args.state
    global DOCS_DIR
    here = os.path.dirname(os.path.abspath(__file__))
    DOCS_DIR = os.path.join(here, "docs") if os.path.isdir(os.path.join(here, "docs")) else os.path.join(os.path.dirname(here), "docs")
    global DASHBOARD_USER, DASHBOARD_PASS
    DASHBOARD_USER = (os.environ.get("DASHBOARD_USER") or "").strip()
    DASHBOARD_PASS = (os.environ.get("DASHBOARD_PASS") or "").strip()
    if bool(DASHBOARD_USER) != bool(DASHBOARD_PASS):
        print("relay: set both DASHBOARD_USER and DASHBOARD_PASS, or neither")
        raise SystemExit(2)
    TOKEN = (args.token or "").strip()
    if not TOKEN and args.token_file:
        try:
            with open(args.token_file, encoding="utf-8") as fh:
                TOKEN = fh.read().strip()
        except OSError as exc:
            print("relay: cannot read --token-file %s: %s" % (args.token_file, exc))
            raise SystemExit(2)
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    load_state()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("spike relay on http://%s:%d  (events -> %s)" % (args.host, args.port, LOG_PATH))
    print("auth:", ("bearer token required (%d chars)" % len(TOKEN)) if TOKEN else "DISABLED - no token configured")
    print(
        "dashboard auth:",
        ("HTTP Basic as %r (browser remembers it)" % DASHBOARD_USER) if DASHBOARD_USER else "disabled - dashboard is open",
    )
    if not TOKEN and args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            "relay: WARNING: bound to %s with no token, so anyone who can reach this port\n"
            "relay:          can queue notifications and read /state. Fine for a dev box on\n"
            "relay:          loopback; set RELAY_TOKEN or --token-file before exposing it."
            % args.host
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
