#!/usr/bin/env python3
"""Summarise a relay event trace.

Answers the questions the spike exists for, without jq quoting games:

  python3 server/summarize.py                 # default server/log/events.jsonl
  python3 server/summarize.py --since 12:00   # only events after a local time

Sessions are split on gaps > 5 minutes, so a suspended phone, a dead poller and
a relay restart are all visible as separate blocks with their own statistics.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from datetime import datetime

DEFAULT_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "log", "events.jsonl")
SESSION_GAP_MS = 5 * 60 * 1000


def hhmmss(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%H:%M:%S")


def load(path: str) -> list[dict]:
    events = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    return events


def summarize(events: list[dict]) -> int:
    if not events:
        print("no events")
        return 1

    sessions, current = [], [events[0]]
    for previous, event in zip(events, events[1:]):
        if event["received_at"] - previous["received_at"] > SESSION_GAP_MS:
            sessions.append(current)
            current = []
        current.append(event)
    sessions.append(current)

    for index, session in enumerate(sessions, 1):
        start, end = session[0]["received_at"], session[-1]["received_at"]
        pongs = [e for e in session if e.get("event") == "pong"]
        gaps = [e["gap_ms"] for e in pongs if isinstance(e.get("gap_ms"), int)]
        unanswered = [e for e in session if e.get("event") == "ping.unanswered"]
        silent = [e for e in session if e.get("event") == "watch.silent"]
        errors = [e for e in session if e.get("event") == "poll.error"]
        shown = [e for e in session if e.get("event") == "notify.shown"]
        queued = [e for e in session if e.get("event") == "notify.queued"]
        acks = [e for e in session if e.get("event") == "ack.received"]

        print(f"--- session {index}: {hhmmss(start)} -> {hhmmss(end)} "
              f"({(end - start) / 60000:.1f} min, {len(session)} events) ---")
        print(f"  pongs={len(pongs)}  queued={len(queued)}  shown={len(shown)}  acks={len(acks)}"
              f"  unanswered={len(unanswered)}  silent={len(silent)}  poll_errors={len(errors)}")

        if gaps:
            ordered = sorted(gaps)
            p90 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.9))]
            print(f"  pong gap: median={statistics.median(ordered) / 1000:.1f}s "
                  f"p90={p90 / 1000:.1f}s max={ordered[-1] / 1000:.1f}s "
                  f"mean={statistics.mean(ordered) / 1000:.1f}s")

        for event in shown:
            data = event.get("data") or {}
            print(f"  notify.shown {hhmmss(event['received_at'])} id={data.get('i')} "
                  f"actions={data.get('actionCount')}")

        for event in unanswered:
            print(f"  ! ping.unanswered {hhmmss(event['received_at'])} "
                  f"since={event.get('since_ms')}ms")

        for event in silent:
            print(f"  ! watch.silent {hhmmss(event['received_at'])} "
                  f"silent={event.get('silent_ms')}ms")

        for event in errors[:5]:
            print(f"  ! poll.error {hhmmss(event['received_at'])} {event.get('err')}")

    # Delivery latency: queued -> shown, matched by id (nearest later match).
    queued_at = {}
    for event in events:
        if event.get("event") == "notify.queued":
            queued_at[event.get("id")] = event["received_at"]
    latencies = []
    for event in events:
        if event.get("event") != "notify.shown":
            continue
        nid = (event.get("data") or {}).get("i")
        if nid in queued_at:
            latencies.append(event["received_at"] - queued_at[nid])
    if latencies:
        ordered = sorted(latencies)
        print(f"--- delivery (server queue -> watch render), n={len(ordered)}: "
              f"min={ordered[0] / 1000:.1f}s median={statistics.median(ordered) / 1000:.1f}s "
              f"max={ordered[-1] / 1000:.1f}s ---")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", default=DEFAULT_LOG)
    parser.add_argument("--since", help="local HH:MM[:SS] cutoff")
    args = parser.parse_args()

    if not os.path.exists(args.log):
        print(f"no trace at {args.log}")
        return 1

    events = load(args.log)
    if args.since:
        now = datetime.now()
        parts = [int(p) for p in args.since.split(":")]
        cutoff = now.replace(hour=parts[0], minute=parts[1] if len(parts) > 1 else 0,
                             second=parts[2] if len(parts) > 2 else 0, microsecond=0)
        events = [e for e in events if e["received_at"] >= cutoff.timestamp() * 1000]
    return summarize(events)


if __name__ == "__main__":
    sys.exit(main())
