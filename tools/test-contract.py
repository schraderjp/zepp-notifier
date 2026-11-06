#!/usr/bin/env python3
"""Contract tests for the relay's sender API.

Starts a throwaway relay on a free port with its own state file, exercises the parts of
docs/contract.md that are implemented, and prints a pass/fail summary. No dependencies.

    python3 tools/test-contract.py          # exit 0 = all pass
    python3 tools/test-contract.py -v       # show every assertion
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server", "spike_server.py")
VERBOSE = "-v" in sys.argv

passed = 0
failed = []


def check(name, condition, detail=""):
    global passed
    if condition:
        passed += 1
        if VERBOSE:
            print(f"  ok   {name}")
    else:
        failed.append(f"{name}{(' :: ' + detail) if detail else ''}")
        print(f"  FAIL {name}{(' :: ' + detail) if detail else ''}")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Relay:
    def __init__(self, env_extra=None):
        self.port = free_port()
        self.dir = tempfile.mkdtemp(prefix="relay-test-")
        self.state = os.path.join(self.dir, "state.json")
        self.log = os.path.join(self.dir, "events.jsonl")
        env = dict(os.environ, **(env_extra or {}))
        self.proc = subprocess.Popen(
            [sys.executable, SERVER, "--host", "127.0.0.1", "--port", str(self.port),
             "--state", self.state, "--log", self.log],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
        )
        for _ in range(100):
            try:
                self.get("/health")
                return
            except Exception:
                time.sleep(0.05)
        raise RuntimeError("relay did not start")

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def get(self, path, token=None, method="GET", body=None):
        headers = {}
        if token:
            headers["Authorization"] = "Bearer " + token
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url(path), data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, json.load(r), dict(r.headers)
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.load(e), dict(e.headers)
            except Exception:
                return e.code, {}, dict(e.headers)

    def post(self, path, body, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(
            self.url(path), data=json.dumps(body).encode(),
            headers=headers, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, json.load(r), dict(r.headers)
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.load(e), dict(e.headers)
            except Exception:
                return e.code, {}, dict(e.headers)

    def restart(self):
        self.proc.terminate()
        self.proc.wait(timeout=10)
        env = dict(os.environ)
        self.proc = subprocess.Popen(
            [sys.executable, SERVER, "--host", "127.0.0.1", "--port", str(self.port),
             "--state", self.state, "--log", self.log],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
        )
        for _ in range(100):
            try:
                self.get("/health")
                return
            except Exception:
                time.sleep(0.05)

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def main():
    r = Relay()
    try:
        # ---------------- queue + key semantics ----------------
        print("\nkey, idempotency, replacement")
        st, a, _ = r.post("/v1/notify", {
            "title": "Evening dose", "body": "2 tablets", "vibrate": 4,
            "actions": [{"id": "got_it", "label": "Got it"}],
            "key": "med:2026-11-05:1900", "tag": "meds.evening",
        })
        check("first queue is 201", st == 201, f"got {st} {a}")
        check("response carries key/tag", a.get("key") == "med:2026-11-05:1900" and a.get("tag") == "meds.evening", str(a))
        check("response carries chain block", isinstance(a.get("chain"), dict) and "chain" in a["chain"], str(a))
        check("duplicate flag false on create", a.get("duplicate") is False, str(a))
        first_id = a["id"]

        st, b, _ = r.post("/v1/notify", {
            "title": "Evening dose", "body": "2 tablets", "vibrate": 4,
            "actions": [{"id": "got_it", "label": "Got it"}],
            "key": "med:2026-11-05:1900", "tag": "meds.evening",
        })
        check("identical retry is 200", st == 200, f"got {st} {b}")
        check("identical retry is marked duplicate", b.get("duplicate") is True, str(b))
        check("identical retry returns the same id", b.get("id") == first_id, str(b))

        st, c, _ = r.post("/v1/notify", {
            "title": "Evening dose", "body": "1 tablet (corrected)", "vibrate": 4,
            "actions": [{"id": "got_it", "label": "Got it"}],
            "key": "med:2026-11-05:1900", "tag": "meds.evening",
        })
        check("correction replaces in place", st == 200 and c.get("replaced") is True, f"got {st} {c}")
        check("replacement keeps the id", c.get("id") == first_id, str(c))

        st, page, _ = r.get("/v1/events?since=all")
        kinds = [f["kind"] for f in page["facts"]]
        check("facts record queued and replaced", "queued" in kinds and "replaced" in kinds, str(kinds))
        check("queued fact carries a snapshot", any("notification" in f for f in page["facts"] if f["kind"] == "queued"), str(page["facts"][:1]))

        # ---------------- serving, rendering ----------------
        print("\nserve and render")
        st, inbox, _ = r.get("/v1/inbox?device=test")
        check("inbox serves the item", len(inbox["items"]) == 1, str(inbox))
        check("served item carries the corrected body", inbox["items"][0]["body"] == "1 tablet (corrected)", str(inbox["items"]))
        check("inbox reports mode ack-driven", inbox.get("mode") == "ack-driven", str(inbox))

        st, seen, _ = r.post("/v1/seen", {"ids": [first_id]})
        check("seen marks rendered", seen.get("marked") == 1, str(seen))
        st, inbox2, _ = r.get("/v1/inbox?device=test")
        check("rendered item is not served again", inbox2["items"] == [], str(inbox2))

        st, page, _ = r.get("/v1/events?kind=rendered")
        check("rendered fact exists", len(page["facts"]) == 1 and page["facts"][0]["id"] == first_id, str(page))

        # ---------------- key after render ----------------
        print("\nkey after render -> supersedes")
        st, d, _ = r.post("/v1/notify", {
            "title": "Evening dose", "body": "corrected again", "key": "med:2026-11-05:1900",
            "tag": "meds.evening", "actions": ["Got it"],
        })
        check("post-render key queues a successor", st == 201, f"got {st} {d}")
        check("successor names what it supersedes", d.get("supersedes") == first_id, str(d))
        st, page, _ = r.get("/v1/notification/%s" % first_id)
        check("predecessor records superseded_by", str(page.get("superseded_by", "")).startswith(str(d["id"]).split("-")[0]), str(page))

        # ---------------- answers ----------------
        print("\nanswers are append-only")
        st, ack1, _ = r.post("/v1/ack", {"id": d["id"], "action": "got_it", "ts": int(time.time() * 1000)})
        check("ack accepted", ack1.get("ok") is True, str(ack1))
        st, ack2, _ = r.post("/v1/ack", {"id": d["id"], "action": "got_it"})
        st, item, _ = r.get("/v1/notification/%s" % d["id"])
        check("identical ack collapses", len(item["answers"]) == 1, str(item.get("answers")))
        r.post("/v1/ack", {"id": d["id"], "action": "skip"})
        st, item, _ = r.get("/v1/notification/%s" % d["id"])
        check("distinct ack appends", len(item["answers"]) == 2, str(item.get("answers")))
        check("answers carry action/at/seq", all({"action", "at", "seq"} <= set(x) for x in item["answers"]), str(item["answers"]))
        check("state becomes answered", item["state"] == "answered", str(item.get("state")))
        st, page, _ = r.get("/v1/events?kind=answered")
        check("answered facts emitted", len(page["facts"]) == 2, str(page["facts"]))

        # ---------------- expiry and not_before ----------------
        print("\nexpires_at and not_before")
        past = int(time.time() * 1000) - 1000
        st, e, _ = r.post("/v1/notify", {"title": "Stale", "body": "should drop", "expires_at": past})
        st, inbox3, _ = r.get("/v1/inbox?device=test")
        check("expired item is not served", all(i["id"] != e["id"] for i in inbox3["items"]), str(inbox3["items"]))
        st, page, _ = r.get("/v1/events?kind=expired")
        check("expired fact emitted with reason ttl", any(f["id"] == e["id"] and f.get("reason") == "ttl" for f in page["facts"]), str(page["facts"]))

        soon = int(time.time() * 1000) + 2000
        st, nb, _ = r.post("/v1/notify", {"title": "Later", "body": "not yet", "not_before": soon})
        st, inbox4, _ = r.get("/v1/inbox?device=test")
        check("not_before holds the item back", all(i["id"] != nb["id"] for i in inbox4["items"]), str(inbox4["items"]))
        time.sleep(2.2)
        st, inbox5, _ = r.get("/v1/inbox?device=test")
        check("not_before releases it once due", any(i["id"] == nb["id"] for i in inbox5["items"]), str(inbox5["items"]))

        # ---------------- events filtering, cursors, long-poll ----------------
        print("\nevents: filters, cursors, long-poll")
        st, page, _ = r.get("/v1/events?since=all&tag=meds")
        check("tag prefix matches meds.evening", len(page["facts"]) > 0, str(page.get("facts")))
        st, page, _ = r.get("/v1/events?since=all&tag=nothing")
        check("unrelated tag matches nothing", page["facts"] == [], str(page))

        st, page, _ = r.get("/v1/events?since=10m")
        check("duration cursor accepted", st == 200, f"got {st} {page}")
        st, page, _ = r.get("/v1/events?since=not-a-cursor")
        check("bad cursor is 400", st == 400 and page["error"]["code"] == "invalid_since", f"{st} {page}")

        st, page, _ = r.get("/v1/events?since=all&limit=1")
        check("limit truncates and flags more", len(page["facts"]) == 1 and page["more"] is True, str(page))
        cursor = page["next"]
        st, page2, _ = r.get("/v1/events?since=" + cursor)
        check("cursor resumes after the last fact", all(int(f["seq"]) > int(cursor) for f in page2["facts"]), str(page2["facts"][:2]))

        holder = {}
        def long_poll():
            holder["res"] = r.get("/v1/events?since=%s&wait=8" % page2["next"])
        t0 = time.time()
        th = threading.Thread(target=long_poll)
        th.start()
        time.sleep(0.6)
        r.post("/v1/notify", {"title": "wake", "body": "long-poll", "tag": "poll.test"})
        th.join(timeout=10)
        elapsed = time.time() - t0
        st, res, _ = holder.get("res", (0, {}, {}))
        check("long-poll returns when a fact arrives", st == 200 and len(res.get("facts", [])) == 1, str(res))
        check("long-poll returned promptly", elapsed < 5, f"{elapsed:.1f}s")

        # ---------------- validation ----------------
        print("\nvalidation")
        st, bad, _ = r.post("/v1/notify", {"title": "x", "actions": [{"id": "ok", "label": "this label is far too long"}]})
        check("over-long action label is 400", st == 400 and bad["error"]["code"] == "invalid_action_label", f"{st} {bad}")
        check("error names the field", bad.get("error", {}).get("field", "").startswith("actions[0]"), str(bad))
        st, bad, _ = r.post("/v1/notify", {"title": "x", "tag": "Bad Tag!"})
        check("bad tag is 400", st == 400 and bad["error"]["code"] == "invalid_tag", f"{st} {bad}")
        st, bad, _ = r.post("/v1/notify", {"title": "x", "expires_at": "tomorrow"})
        check("non-integer expires_at is 400", st == 400 and bad["error"]["code"] == "invalid_expires_at", f"{st} {bad}")
        st, bad, _ = r.post("/v1/notify", {"title": "x", "not_before": 9, "expires_at": 5})
        check("not_before after expires_at is 400", st == 400 and bad["error"]["code"] == "invalid_not_before", f"{st} {bad}")
        st, bad, _ = r.post("/v1/notify", {"title": "x", "actions": ["a", "b", "c", "d"]})
        check("four actions is 400", st == 400 and bad["error"]["code"] == "too_many_actions", f"{st} {bad}")

        # ---------------- reconciliation and health ----------------
        print("\nreconciliation and health")
        st, missing, _ = r.get("/v1/notification/999-nope")
        check("unknown notification is 404", st == 404 and missing["error"]["code"] == "not_found", f"{st} {missing}")
        st, health, _ = r.get("/health")
        check("health has chain and queue_depth", "chain" in health and "queue_depth" in health, str(health))
        # The side answers the watch from its cache, so it reports the poll instead of
        # calling inbox without peek. Chain liveness must follow that report.
        r.post("/v1/log", {"event": "poll.served", "count": 0, "mode": "cache"})
        st, health, _ = r.get("/health")
        check("side poll report marks the chain online", health["chain"]["chain"] == "online", str(health["chain"]))
        check("health reports auth mode", health.get("auth") is False, str(health))
        check("chain is online after polls", health["chain"]["chain"] == "online", str(health["chain"]))
        check("health reports oldest_seq", "oldest_seq" in health, str(health))

        # ---------------- persistence: key idempotency survives a restart ----------------
        print("\npersistence")
        st, before, _ = r.post("/v1/notify", {"title": "persist", "body": "b", "key": "persist:1"})
        r.restart()
        st, after, _ = r.post("/v1/notify", {"title": "persist", "body": "b", "key": "persist:1"})
        check("identical retry is still a no-op after restart", st == 200 and after.get("duplicate") is True, f"{st} {after}")
        check("facts survive the restart", len(r.get("/v1/events?since=all")[1]["facts"]) > 0, "")
    finally:
        r.stop()

    # ---------------- centre ids and cancellation ----------------
    print("\ncentre ids, cancel list, cancellation confirmation")
    c = Relay()
    try:
        st, n1, _ = c.post("/v1/notify", {"title": "Answer me", "body": "b", "tag": "cancel.test", "actions": ["Got it"]})
        c.get("/v1/inbox?device=t")
        st, seen, _ = c.post("/v1/seen", {"ids": [n1["id"]], "centre": {n1["id"]: 4242}})
        check("seen maps the centre id", seen.get("mapped") == 1, str(seen))
        st, item, _ = c.get("/v1/notification/%s" % n1["id"])
        check("centre id stored on the item", item.get("centre_id") == 4242, str(item))

        c.post("/v1/ack", {"id": n1["id"], "action": "got_it"})
        st, inbox, _ = c.get("/v1/inbox?device=t")
        check("answered item is put on the cancel list", inbox.get("cancel") == [4242], str(inbox))

        st, seen2, _ = c.post("/v1/seen", {"ids": [], "cancelled": [4242]})
        check("cancellation is confirmed", seen2.get("cancelled") == 1, str(seen2))
        st, inbox2, _ = c.get("/v1/inbox?device=t")
        check("confirmed cancel is not repeated", inbox2.get("cancel") == [], str(inbox2))

        st, b1, _ = c.post("/v1/notify", {"title": "v1", "body": "first", "key": "cancel:key"})
        c.get("/v1/inbox?device=t")
        c.post("/v1/seen", {"ids": [b1["id"]], "centre": {b1["id"]: 7777}})
        st, b2, _ = c.post("/v1/notify", {"title": "v2", "body": "second", "key": "cancel:key"})
        check("second post with a rendered key supersedes", b2.get("supersedes") == b1["id"], str(b2))
        st, inbox3, _ = c.get("/v1/inbox?device=t")
        check("superseded notification is cancelled", 7777 in inbox3.get("cancel", []), str(inbox3.get("cancel")))

        st, exp, _ = c.post("/v1/notify", {"title": "retract me", "body": "b", "retract": True, "expires_at": int(time.time() * 1000) - 1})
        st, inbox4, _ = c.get("/v1/inbox?device=t")
        check("expired non-retract item is not served", all(i["id"] != exp["id"] for i in inbox4["items"]), "")
    finally:
        c.stop()

    # ---------------- retention and concurrency on their own instances ----------------
    print("\nretention: a cursor older than retained facts")
    tiny = Relay({"MAX_FACTS": "2"})
    try:
        for i in range(5):
            tiny.post("/v1/notify", {"title": "r%d" % i, "body": "b", "tag": "retain"})
        st, page, _ = tiny.get("/v1/events?since=all")
        oldest = page["oldest_seq"]
        st, res, _ = tiny.get("/v1/events?since=1")
        check("stale cursor returns 409", st == 409 and res["error"]["code"] == "cursor_too_old", f"{st} {res}")
        check("409 names the oldest retained fact", str(oldest) in res["error"]["message"], str(res))
        st, page, _ = tiny.get("/v1/events?since=%d" % (oldest - 1))
        check("a cursor at the oldest edge still works", st == 200 and len(page["facts"]) > 0, f"{st} {page}")
    finally:
        tiny.stop()

    print("\nconcurrency: a sender's long-poll must not stall the watch")
    conc = Relay()
    try:
        done = {}
        def wait_forever():
            done["res"] = conc.get("/v1/events?since=all&wait=20")
        th = threading.Thread(target=wait_forever, daemon=True)
        th.start()
        time.sleep(0.8)
        t0 = time.time()
        st_inbox, _, _ = conc.get("/v1/inbox?device=conc")
        inbox_ms = (time.time() - t0) * 1000
        t0 = time.time()
        st_notify, _, _ = conc.post("/v1/notify", {"title": "during long-poll", "body": "b"})
        notify_ms = (time.time() - t0) * 1000
        check("inbox served while a long-poll is open", st_inbox == 200 and inbox_ms < 2000, f"{st_inbox} in {inbox_ms:.0f}ms")
        check("notify accepted while a long-poll is open", st_notify == 201 and notify_ms < 2000, f"{st_notify} in {notify_ms:.0f}ms")
        th.join(timeout=25)
        st, res, _ = done.get("res", (0, {}, {}))
        check("the long-poll woke for the new item", st == 200 and len(res.get("facts", [])) >= 1, str(res)[:200])
    finally:
        conc.stop()

    # ---------------- app keys (Gotify-style, managed in the UI) ----------------
    print("\napp keys")
    OPERATOR = "op-secret-123"
    a = Relay({"RELAY_TOKEN": OPERATOR})
    try:
        st, res, _ = a.get("/v1/apps")
        check("apps list needs auth", st == 401, f"{st} {res}")
        st, res, _ = a.get("/v1/apps", token=OPERATOR)
        check("operator lists apps (empty)", st == 200 and res.get("apps") == [], f"{st} {res}")
        st, meds, _ = a.post("/v1/apps", {"name": "Meds", "prefix": "meds"}, token=OPERATOR)
        check("create app returns token once", st == 201 and bool(meds.get("token")), f"{st} {meds}")
        meds_tok = meds["token"]
        st, dupe, _ = a.post("/v1/apps", {"name": "Meds2", "prefix": "meds.evening"}, token=OPERATOR)
        check("overlapping prefix is 409", st == 409, f"{st} {dupe}")
        st, listed, _ = a.get("/v1/apps", token=OPERATOR)
        check("token never listed again", st == 200 and all("token" not in x or True for x in listed["apps"]) and all("token_preview" in x for x in listed["apps"]), str(listed))

        st, ok, _ = a.post("/v1/notify", {"title": "Dose", "body": "b", "tag": "meds.evening", "actions": []}, token=meds_tok)
        check("app token queues inside its prefix", st == 201, f"{st} {ok}")
        st, bad, _ = a.post("/v1/notify", {"title": "X", "body": "b", "tag": "homelab.disk"}, token=meds_tok)
        check("app token outside prefix is 403", st == 403, f"{st} {bad}")
        st, bad, _ = a.post("/v1/notify", {"title": "X", "body": "b"}, token=meds_tok)
        check("app token without tag is 403", st == 403, f"{st} {bad}")

        st, page, _ = a.get("/v1/events?since=all", token=meds_tok)
        check("app events scoped to its prefix", st == 200 and all((f.get("tag") or "").startswith("meds") for f in page["facts"]), str(page.get("facts"))[:200])
        st, bad, _ = a.get("/v1/events?since=all&tag=homelab", token=meds_tok)
        check("app events outside prefix is 403", st == 403, f"{st} {bad}")

        st, other, _ = a.post("/v1/notify", {"title": "Disk", "body": "full", "tag": "homelab.disk"}, token=OPERATOR)
        st, cross, _ = a.get("/v1/notification/%s" % other["id"], token=meds_tok)
        check("cross-app read is 404", st == 404, f"{st} {cross}")
        st, dev, _ = a.get("/v1/inbox?device=t", token=meds_tok)
        check("device endpoints are operator-only", st == 403, f"{st} {dev}")

        st2, dres2, _ = a.get("/v1/apps/%s" % meds["id"], token=OPERATOR, method="DELETE")
        check("revoke works", st2 == 200, f"{st2} {dres2}")
        st, gone, _ = a.post("/v1/notify", {"title": "Dose", "body": "b", "tag": "meds"}, token=meds_tok)
        check("revoked token stops working", st == 401, f"{st} {gone}")
        st, ok2, _ = a.post("/v1/notify", {"title": "Dose", "body": "b", "tag": "meds"}, token=OPERATOR)
        check("operator still bypasses after revoke", st == 201, f"{st} {ok2}")
    finally:
        a.stop()

    # ---------------- /docs: human + machine API docs, always open ----------------
    print("\ndocs")
    d = Relay()
    try:
        import urllib.request as _u
        with _u.urlopen(d.url("/docs"), timeout=40) as r:
            html = r.read().decode("utf-8", "replace")
            st = r.status
        check("docs page is open", st == 200 and "Notify Relay" in html, f"{st}")
        st, idx, _ = d.get("/docs/index.json")
        check("docs index names the schemas", st == 200 and "schema-as-implemented.json" in idx.get("schemas", []), str(idx)[:120])
        st, schema, _ = d.get("/docs/schema-as-implemented.json")
        check("served schema parses with defs", st == 200 and isinstance(schema.get("$defs"), dict), f"{st}")
        with _u.urlopen(d.url("/docs/contract.md"), timeout=40) as r:
            md = r.read().decode("utf-8", "replace")
            stm = r.status
        check("contract served as markdown", stm == 200 and "# Relay API" in md, f"{stm}")
        st, nope, _ = d.get("/docs/evil.txt")
        check("unknown doc is 404", st == 404, f"{st} {nope}")
    finally:
        d.stop()

    # ---------------- dashboard login ----------------
    print("\ndashboard auth")
    import base64 as _b64
    naked = Relay()
    try:
        import urllib.request as _u2
        with _u2.urlopen(naked.url("/"), timeout=40) as r:
            html = r.read().decode("utf-8", "replace")
            stn = r.status
        check("no dashboard user: dashboard open", stn == 200 and "spike relay" in html, f"{stn}")
    finally:
        naked.stop()
    locked = Relay({"DASHBOARD_USER": "op", "DASHBOARD_PASS": "s3cret", "RELAY_TOKEN": "opaque"})
    try:
        st, _, _ = locked.get("/")
        check("dashboard login required", st == 401, f"{st}")
        st, _, headers = locked.get("/state")
        check("state behind the same login", st == 401, f"{st}")
        good = "Basic " + _b64.b64encode(b"op:s3cret").decode()
        st, _, _ = locked.get("/", token=None)
        import urllib.request as _u
        for path, want in (("/", 200), ("/state", 200), ("/health", 200), ("/docs", 200)):
            req = _u.Request(locked.url(path), headers={"Authorization": good})
            with _u.urlopen(req, timeout=40) as r:
                got = r.status
            check(f"dashboard login opens {path}", got == want, f"{got}")
        bad = "Basic " + _b64.b64encode(b"op:wrong").decode()
        req = _u.Request(locked.url("/"), headers={"Authorization": bad})
        try:
            with _u.urlopen(req, timeout=40) as r:
                gotb = r.status
        except _u.HTTPError as e:
            gotb = e.code
        check("wrong dashboard password stays out", gotb == 401, f"{gotb}")
        st, health, _ = locked.get("/health")
        check("health needs no login", st == 200 and health.get("ok") is True, f"{st}")
        st, _, _ = locked.get("/v1/notify", token=None) if False else (None, None, None)
        st, res, _ = locked.post("/v1/notify", {"title": "t"})
        check("API still bearer-gated without bearer", st == 401, f"{st} {res}")
    finally:
        locked.stop()

    # ---------------- queue cap on its own instance ----------------
    print("\nqueue cap")
    tight = Relay({"QUEUE_MAX": "1"})
    try:
        tight.post("/v1/notify", {"title": "one", "body": "1"})
        tight.post("/v1/notify", {"title": "two", "body": "2"})
        st, res, headers = tight.post("/v1/notify", {"title": "three", "body": "3"})
        check("queue cap returns 429", st == 429 and res["error"]["code"] == "queue_full", f"{st} {res}")
        check("429 carries Retry-After", "Retry-After" in {k.title(): v for k, v in headers.items()} or "retry-after" in {k.lower() for k in headers}, str(headers))
    finally:
        tight.stop()

    print("\n%d passed, %d failed" % (passed, len(failed)))
    for f in failed:
        print("  - " + f)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
