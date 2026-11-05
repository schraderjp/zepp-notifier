#!/usr/bin/env python3
"""Reference sender: the canonical way to use the relay API (docs/contract.md).

One loop, three jobs: queue idempotently, observe via the fact log, escalate locally.
Policy (what counts as an answer, when to nag) lives here, never in the relay.

    python3 tools/sender-example.py --relay http://127.0.0.1:8097 --token ... \\
        --tag meds.evening --key med:2026-11-05:1900 \\
        --title "Evening dose" --body "2 tablets" --action got_it "Got it"

Behaviour:
  * queue with a stable `key`: a retried POST after a timeout is a no-op
    (`duplicate: true`, same id), never a second reminder;
  * persist the event cursor (`next`) in a sidecar file, so a restart resumes
    instead of replaying;
  * long-poll `/v1/events?wait=20` filtered to our tag; exit 0 on `answered`;
  * `rendered` without `answered` within --timeout is the sender's own
    "unanswered" signal (the relay deliberately emits no such fact).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = ""
TOKEN = ""


def call(method, path, body=None, timeout=40):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + TOKEN} if TOKEN else {})},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {"error": {"code": "http_%d" % e.code, "message": str(e)}}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--relay", default="http://127.0.0.1:8097")
    ap.add_argument("--token", default=os.environ.get("RELAY_TOKEN", ""))
    ap.add_argument("--tag", default="meds.evening")
    ap.add_argument("--key", default="example:%d" % int(time.time() // 3600))
    ap.add_argument("--title", default="Evening dose")
    ap.add_argument("--body", default="2 tablets with food")
    ap.add_argument("--action", nargs=2, action="append", default=[], metavar=("ID", "LABEL"))
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--cursor-file", default="/tmp/sender-example.cursor")
    args = ap.parse_args()

    global BASE, TOKEN
    BASE = args.relay.rstrip("/")
    TOKEN = args.token

    actions = [{"id": i, "label": label} for i, label in args.action] or [{"id": "got_it", "label": "Got it"}]
    st, resp = call("POST", "/v1/notify", {
        "title": args.title, "body": args.body, "vibrate": 4,
        "actions": actions, "key": args.key, "tag": args.tag,
    })
    if st not in (200, 201):
        print("queue failed: %d %s" % (st, resp), flush=True)
        return 1
    print("queued %s (duplicate=%s) chain=%s" % (resp["id"], resp.get("duplicate"), resp.get("chain", {}).get("chain")), flush=True)
    if resp.get("chain", {}).get("chain") != "online":
        print("warning: chain is %s; the reminder is queued but the watch may not be listening"
              % resp.get("chain", {}).get("chain"), flush=True)

    try:
        with open(args.cursor_file) as fh:
            since = fh.read().strip() or "all"
    except OSError:
        since = "all"
    deadline = time.time() + args.timeout
    while True:
        wait = max(1, min(20, int(deadline - time.time())))
        st, page = call("GET", "/v1/events?since=%s&tag=%s&wait=%d" % (since, args.tag, wait))
        if st == 409:
            since = str(page["error"].get("oldest_seq", 0)) if isinstance(page.get("error"), dict) else "all"
            continue
        if st != 200:
            print("events failed: %d %s" % (st, page), flush=True)
            return 1
        for f in page.get("facts", []):
            if f.get("id") != resp["id"]:
                continue
            if f["kind"] == "answered":
                print("answered: %s" % f.get("action"), flush=True)
                return 0
            if f["kind"] == "expired":
                print("expired before it was answered", flush=True)
                return 3
            if f["kind"] == "rendered":
                print("rendered; waiting for an answer ...", flush=True)
        since = page.get("next", since)
        try:
            with open(args.cursor_file, "w") as fh:
                fh.write(str(since))
        except OSError:
            pass
        if time.time() >= deadline:
            print("UNANSWERED: rendered but no answer within %ds (sender-side escalation goes here)" % args.timeout, flush=True)
            return 2


if __name__ == "__main__":
    sys.exit(main())
