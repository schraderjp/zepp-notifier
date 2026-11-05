#!/usr/bin/env python3
"""Watch one unattended run and report the first anomaly, or a clean summary.

Purpose: the failure modes that matter are invisible in a passing glance at the log.
This process tails server/log/events.jsonl and exits as soon as something is actually
wrong, so nobody has to poll:

  * chain gap        - no poll.served for GAP_LIMIT seconds (sleep mode, lost alarm,
                       dead side service)
  * stuck            - the relay reported an item served repeatedly without a render
                       report, i.e. payload-carrying responses are not arriving
  * not rendered     - an item was handed over and no notify.rendered arrived within
                       RENDER_LIMIT (the overnight loss signature)
  * poll.nores       - the watch asked and got no parseable answer

Exit 0 = clean for the full duration. Exit 2 = anomaly (details on stdout).
Run with --from-end to ignore history and watch only new events.
"""
import json
import os
import sys
import time
from datetime import datetime

LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'server', 'log', 'events.jsonl')

DURATION = int(os.environ.get('WATCH_DURATION', 4 * 3600))
GAP_LIMIT = int(os.environ.get('WATCH_GAP_LIMIT', 150))
POLL_INTERVAL = 20


def ts_of(entry):
    return (entry.get('received_at') or 0) / 1000.0


def clock(t):
    return datetime.fromtimestamp(t).strftime('%H:%M:%S')


def main():
    from_end = '--from-end' in sys.argv
    pos = os.path.getsize(LOG) if from_end else 0
    start = time.time()
    polls = []
    rendered = {}
    anomalies = []

    def read_new():
        nonlocal pos
        try:
            if os.path.getsize(LOG) < pos:  # relay restarted and truncated
                pos = 0
            with open(LOG, 'r', encoding='utf-8') as fh:
                fh.seek(pos)
                chunk = fh.read()
                pos = fh.tell()
        except OSError:
            return []
        out = []
        for line in chunk.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
        return out

    def note(kind, detail):
        if not anomalies:
            anomalies.append((kind, detail))

    while True:
        for e in read_new():
            ev = e.get('event')
            t = ts_of(e)
            if ev == 'poll.served':
                polls.append(t)
            elif ev == 'notify.rendered':
                for nid in e.get('ids') or []:
                    rendered.setdefault(str(nid), t)
            elif ev == 'notify.stuck':
                note('stuck', f"relay reported stuck items {e.get('ids')} after {e.get('serves')} serves")
            elif ev == 'notify.abandoned':
                note('abandoned', f"item {e.get('id')} given up after {e.get('served')} serves")
            elif ev == 'poll.nores':
                note('poll.nores', f"watch got no answer for a poll at {clock(t)}")
            elif ev == 'side.online':
                # an install or app relaunch restarts the side: not a fault
                pass

        now = time.time()
        if polls and now - polls[-1] > GAP_LIMIT:
            note('chain gap', f"no wake for {now - polls[-1]:.0f}s (last {clock(polls[-1])})")

        if anomalies:
            break
        if now - start > DURATION:
            break
        time.sleep(POLL_INTERVAL)

    # ---- report ----
    gaps = [b - a for a, b in zip(polls, polls[1:])] if len(polls) > 1 else []
    lines = [
        'run summary',
        f"duration      : {int(time.time() - start)}s",
        f"wakes         : {len(polls)}",
    ]
    if gaps:
        gaps_sorted = sorted(gaps)
        lines.append(f"gap min/med/max: {min(gaps):.1f} / {gaps_sorted[len(gaps_sorted) // 2]:.1f} / {max(gaps):.1f} s")
    lines.append(f"render reports: {len(rendered)}")
    if anomalies:
        kind, detail = anomalies[0]
        lines.append(f"VERDICT       : ANOMALY - {kind}: {detail}")
        print('\n'.join(lines), flush=True)
        return 2
    lines.append('VERDICT       : clean for the full duration')
    print('\n'.join(lines), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
