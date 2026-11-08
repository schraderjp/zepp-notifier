# Bug: an answered-but-unrendered notification is served again

Status: **fixed** 2026-11-08 — see [Fix applied](#fix-applied-2026-11-08) at the end.
Verification evidence and the ordered work are in `docs/plan-fix-answered-items.md`.
Found 2026-11-08 while exercising the relay from an n8n node.
Severity: **medium** — causes a duplicate prompt on the wrist in a path that the
contract explicitly promises to prevent, and corrupts `queue_depth`.

## Summary

`ack()` sets `state = "answered"`. Neither `deliverable()` nor the abandoned scan
knows that value: both filter on `("acked", "expired", "abandoned")`, and `"acked"` is
never written anywhere in the server.

So an item that is answered **before** its render report arrives stays deliverable. It
is handed to the watch again on the next wake, counts in `queue_depth`, and after
`MAX_SERVES` is parked as `abandoned` — a fact that claims the chain is broken.

## Why this is reachable in production, not just in tests

`docs/contract.md` §5.0 states render reports are lost **30–40 %** of the time. The
sequence below therefore happens on a real device:

1. item is served, `notify()` succeeds on the watch → `rendered` reported;
2. the report is **lost** (documented, common) → `rendered_at` stays `NULL`;
3. the user taps a button → `ack` arrives → `state = "answered"`;
4. next wake: `deliverable()` still returns `True`, so the item is served a second
   time and shows up again.

Nothing retracts it either: `centre_id` is only recorded from a `seen` report, so the
`cancel` list has no id for it (`server/spike_server.py:541-556` — that block *does*
check `state == "answered"`, which is what makes the inconsistency visible).

## Root cause

`server/spike_server.py`:

```python
189 def deliverable(n: dict) -> bool:
191     if n.get("state") in ("acked", "expired", "abandoned"):
192         return False
```

and the same tuple again in the abandoned scan:

```python
508         if (
509             n.get("state") not in ("acked", "expired", "abandoned")
```

versus what is actually written:

| line | writes |
|---|---|
| 430 | `"queued"` |
| 496 | `"expired"` |
| 512 | `"abandoned"` |
| 622 | `"rendered"` |
| 662 | `"answered"` |

`"acked"` appears in exactly those two tuples and nowhere else. It is a dead value, and
the one live terminal value — `"answered"` — is missing from both.

Normal traffic masks the bug because `rendered_at` is set before the ack, and line 193
short-circuits on it. Only ack-before-render reaches the gap.

## Reproduction

```sh
R=http://127.0.0.1:8097

# 1. queue a prompt with one button
ID=$(curl -s -X POST $R/v1/notify -H 'Content-Type: application/json' \
  -d '{"title":"bug repro","body":"tap yes","tag":"bugdemo","key":"bug:1",
       "actions":[{"id":"yes","label":"Yes"}]}' | jq -r .id)

# 2. ack it WITHOUT any /v1/seen report (simulates a lost render report)
curl -s -X POST $R/v1/ack -H 'Content-Type: application/json' \
  -d "{\"id\":\"$ID\",\"action\":\"yes\"}" > /dev/null

# 3. what the watch is handed on the next wake
curl -s $R/v1/inbox | jq --arg id "$ID" '[.items[] | select(.id==$id)]'

# 4. what the relay reports about the queue
curl -s $R/health | jq '{queue_depth}'
```

**Observed** on an isolated instance (temp `--state` file, port 8099), relay as of
2026-11-05:

```
notify -> 201 1-a35c35
ack   -> 200
inbox serve #1 -> SERVED AGAIN | items: 1
inbox serve #2 -> SERVED AGAIN
health queue_depth -> 1
state: answered | served_count: 2 | rendered_at: None | answers: 1
after 12 serves -> state: abandoned | served_count: 10
abandoned facts -> 1 [{'kind': 'abandoned', 'id': '1-a35c35', 'key': 'bug:1', 'tag': 'bugdemo', 'served': 10, 'seq': 3}]
health queue_depth after -> 0
```

**Expected:** step 3 returns no such item, step 4 reports `queue_depth: 0`, and no
`abandoned` fact is ever emitted for an answered item. Contract §5.5: "The first answer
stops the item being served (otherwise it re-renders forever)."

## Suggested fix

Prefer the invariant over the state string, so a future state rename cannot break it
again:

```python
def deliverable(n: dict) -> bool:
    """One predicate, so 'ready to serve' is defined in exactly one place."""
    if n.get("answers"):
        # §5.5: the first answer stops the item being served, whatever `state` says.
        return False
    if n.get("state") in ("answered", "expired", "abandoned"):
        return False
    ...
```

The abandoned scan needs the same change, or an answered item still reaches
`MAX_SERVES` and is reported as `abandoned`:

```python
        if (
            not n.get("answers")
            and n.get("state") not in ("expired", "abandoned")
            ...
```

Then drop the dead `"acked"` value (or start writing it, but nothing needs it), and
grep for other copies of the tuple. `entities`/`/state` output and the dashboard may
also switch on state strings — check `server/spike_server.py` and the dashboard JS for
`"acked"`.

## Tests to add (`tools/test-contract.py`)

1. **ack-before-render is not re-served** — notify → ack → `/v1/inbox` twice, assert
   the id is absent both times and `served_count` did not change.
2. **ack-before-render does not count in the queue** — same setup, assert
   `GET /health` reports `queue_depth: 0` and that a subsequent `/v1/notify` is not
   rejected by the `QUEUE_MAX` guard.
3. **no `abandoned` fact for an answered item** — drive 12 `/v1/inbox` polls and assert
   no `abandoned` fact for that id.
4. Keep the existing rendered→answered path (test at line ~306) as the control: the
   cancellation behaviour there must not change.

## Related, decide separately (do not "fix" silently)

`replaceable` (`server/spike_server.py:414-419`) requires `state == "queued"` **and**
no answers, so an answered-but-unrendered item cannot be replaced in place; a new item
is queued with `supersedes` instead. Contract §5.1 only requires "not yet rendered".

The code comment in the `else` branch says *"The predecessor was already rendered, so it
cannot be un-shown on the wrist"* — which is false on this path, since `rendered_at` is
`NULL`. Either:

- accept the behaviour as deliberate (an answered item should never be rewritten) and
  fix the comment and §5.1 to say "not yet rendered **and** not yet answered"; or
- relax `replaceable` to `not existing.get("rendered_at") and not existing.get("superseded_by")`.

The second option conflicts with append-only answers in spirit, so the first is
probably right — but it should be a decision, not an accident.

## Fix applied (2026-11-08)

Re-verified on HEAD `673a748` on a throwaway relay before changing anything. The report
is correct, and the dead value appears **four** times, not two — the expiry scan was
missed, and it produces a second contract violation:

| line | site | before | after |
|---|---|---|---|
| 189-204 | `deliverable()` | `"acked"` | `answered(n) or state in TERMINAL_STATES` |
| 488-497 | expiry scan | `"acked"` → an answered item is relabelled `expired` and a false `expired` fact (reason `ttl`) is emitted | skips answered/terminal items |
| 505-515 | abandoned scan | `"acked"` | skips answered items |
| 619-624 | `seen()` | first render report after an ack demotes `answered` → `rendered` | records `rendered_at`/`centre_id` but keeps the terminal state |

The fourth row matters because it is reachable *through* this bug: the item is re-served,
re-rendered, and its `seen` report then un-answers it. With `state` demoted, the item
drops out of the `cancel` list (§5.3 keys off `answered`) and the notification the user
already answered stays on the wrist until it is dismissed by hand.

Fix shape: one invariant (`answers`) plus one `TERMINAL_STATES` tuple, used by every
scan, so a future state rename cannot reopen the gap. `queue_depth`, `create_notification`'s
`QUEUE_MAX` guard and the abandoned/stuck telemetry all follow `deliverable()` and needed
no edits.

`replaceable` was decided rather than changed: an answered item is **not** rewritten in
place even when `rendered_at` is `NULL`. Contract §5.1 now says "not yet rendered **and**
not yet answered", and the misleading comment in the `else` branch ("already rendered, so
it cannot be un-shown") is corrected — that sentence was false on this path, which is how
the inconsistency went unnoticed.

Tests: seven scenarios added to `tools/test-contract.py` (ack-before-render is not
re-served, does not inflate `served_count`, does not count in `queue_depth`, does not free
nothing / does free its `QUEUE_MAX` slot, emits no `abandoned` fact after 12 polls, is not
relabelled `expired` by its TTL, survives a restart, and a late render report neither
un-answers it nor drops it from `cancel`). All 11 new assertions were confirmed failing on
the unfixed server, then passing: **117 passed, 0 failed** (baseline 98, 0).

No state migration: existing files may hold `abandoned`/`expired` items that carry
answers, but the invariant makes them non-deliverable without rewriting history that
`/v1/events` already described.
