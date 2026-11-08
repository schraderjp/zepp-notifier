# Plan — verify and fix "an answered-but-unrendered notification is served again"

Companion to `docs/bug-answered-items-still-deliverable.md`. That document describes the
suspected defect; this one records the verification result against HEAD (`673a748`) and
the ordered work to close it.

> **Status: implemented** — all four sites fixed, docs updated, `tools/test-contract.py`
> at 117 passed / 0 failed (baseline 98). The section below is the plan as written before
the edit; "expected" numbers are kept next to the measured ones where they differ.

## 0. Verification result — reproduced, and wider than reported

Everything below was measured on a throwaway relay (`--state`/`--log` under `mktemp -d`,
random free port), current working tree, Python 3.15, no code changes.

### 0.1 Static confirmation

The dead value appears **four** times, not two — the report missed the expiry scan — and
all four sites are the same root cause (a terminal-state check written against a state
string that no code produces):

| line | site | check today | what it does to an answered item |
|---|---|---|---|
| 191 | `deliverable()` | `"acked"` | serves it again (`queue_depth` counts it) |
| 491 | expiry scan in `inbox()` | `"acked"` | relabels `answered` → `expired`, emits a false `expired` fact |
| 507 | abandoned scan in `inbox()` | `"acked"` | after `MAX_SERVES` relabels `answered` → `abandoned` |
| 621 | `seen()` render report | `not "acked"` | first render report after an ack downgrades `answered` → `rendered` |

`"acked"` is written by nothing (`grep -n '"acked" server/` → those four lines only), and
is not even in the schema's `state` enum (`docs/schema-as-implemented.json:175-182`).
States actually written: `queued` (430, 443), `expired` (496), `abandoned` (512),
`rendered` (622), `answered` (662).

### 0.2 Dynamic confirmation (scenario A — the reported bug)

```
notify -> "1-19eec0"
ack (no /v1/seen) -> 200
inbox #1 -> {"served":1,"cancel":[]}     # served again
inbox #2 -> {"served":1,"cancel":[]}     # and again
health queue_depth -> 1
item -> {"state":"answered","served_count":2,"rendered_at":null,"answers":1}
after 12 polls -> {"state":"abandoned","served_count":10}
abandoned facts -> [{"kind":"abandoned","id":"1-19eec0","served":10,...}]
queue_depth after -> 0
```

Matches the report line for line. Note `served_count` grew on every poll, so the
`stuck` telemetry fires on an item the user already dealt with.

### 0.3 New findings not in the report

**D1 — an answered item is also relabelled `expired`.** Same tuple at line 491:

```
notify(expires_at=now+1.5s) -> ack -> wait 2s -> inbox
item -> {"state":"expired","expired_at":...,"answers":1}
expired facts -> [{"kind":"expired","id":"1-559f51","reason":"ttl"}]
```

The sender gets `answered` and `expired` for the same item, and §5.5 ("the first answer
stops the item being served") is violated by a state the contract treats as terminal.

**D2 — a late first render report silently un-answers the item.** Ack first, then the
lost report finally arrives:

```
after ack            -> {"state":"answered","rendered_at":null}
after late seen      -> {"state":"rendered","rendered_at":...,"centre_id":5555}
cancel list          -> []
```

Two consequences: `/v1/notification` and the dashboard now report `rendered` for an item
with `answers`, and the answered notification drops off the `cancel` list (§5.3 promises
answered items are cancelled on the next wake) so it stays on the wrist until it is
dismissed by hand. This is reachable today because the bug re-serves the item, the watch
re-renders it, and that handover reports `seen` again.

**D3 — the `replaceable` observation in the report is correct, and is not a bug.** An
answered-but-unrendered item is not replaced in place; a successor is queued with
`supersedes`:

```
supersede attempt -> {"id":"3-ae66e9","replaced":false,"supersedes":"1-19eec0"}
```

That is the documented "decide separately" item; §5.1 says "not yet rendered", the code
says "not yet rendered **and** not yet answered". Treat as a doc fix, not a behaviour
change (see step 5).

### 0.4 What the existing suite says

`python3 tools/test-contract.py` on HEAD: **98 passed, 0 failed**. The defect has no
coverage at all — the suite asserts `state == "answered"` on the rendered-then-acked
path only (`tools/test-contract.py:201`), which is exactly the path that masks the bug.
So 98 is the baseline the new assertions are added to, and "still 98/0" after the fix
would mean nothing ran.

## 1. Fix design

One predicate for "the user has dealt with this", used by every scan, so a future state
rename cannot reintroduce the gap. Prefer the invariant (`answers`) over the state
string, as the report suggests; keep the state string as a secondary guard for
`expired`/`abandoned`, which have no other trace.

```python
# States that end an item's life. `rendered` is deliberately not here: it records that
# the watch accepted the notification, not that the user dealt with it. `acked` is gone:
# it was never written by anything, and its presence hid the missing "answered".
TERMINAL_STATES = ("answered", "expired", "abandoned")


def answered(n: dict) -> bool:
    """§5.5: the first answer stops the item being served, whatever `state` says."""
    return bool(n.get("answers"))


def deliverable(n: dict) -> bool:
    if answered(n) or n.get("state") in TERMINAL_STATES:
        return False
    # ... unchanged: rendered_at/superseded_by, MAX_SERVES, expires_at, not_before
```

Then, per site:

| site | change |
|---|---|
| `deliverable()` 189-204 | add `answered()` + `TERMINAL_STATES`; drop `"acked"` |
| expiry scan 488-497 | skip `answered(n)` and `TERMINAL_STATES`; drop `"acked"` (D1) |
| abandoned scan 505-515 | skip `answered(n)`; drop `"acked"` |
| `seen()` 619-624 | do not touch `state` when `answered(notif)` or already terminal (D2) |
| `chain_status()` 185 | no edit — `queue_depth` follows `deliverable()` by construction |
| `create_notification()` `depth` 403 | no edit — same reason |

`ack()` keeps its current behaviour: it sets `state = "answered"` even for an
expired/abandoned item, because the user really did answer and the cancel list keys off
`answered` to remove the stale notification from the wrist. Sanity-check that this is
intentional with a test (step 3, T6) rather than leaving it implicit.

Not in scope, deliberately:

* **No persisted-state rewrite.** Production state files may already contain items with
  `answers` whose `state` is `abandoned`/`expired` (scenarios A and D1). The invariant in
  `deliverable()` makes them non-deliverable without touching the file; a load-time
  rewrite would edit history that `/v1/events` already described. If the misleading
  `state` matters for the dashboard, add a read-only derived field later.
* **No change to `replaceable`.** Behaviour stays as the report recommends (an answered
  item is never rewritten); only the comment and §5.1 wording change.
* **No new fact kinds.** Nothing new is emitted, so senders need no change.

## 2. Order of work

1. `git grep -n '"acked"'` before editing, to confirm the four sites and nothing else
   (including `watch/` and `docs/schema-*.json`).
2. Edit `server/spike_server.py` in one pass: module-level `TERMINAL_STATES` next to
   `MAX_SERVES`, `answered()` helper beside `deliverable()`, then the four sites.
3. Add the tests in step 3 to `tools/test-contract.py` **before** running anything else,
   and confirm they fail on the unfixed code (`git stash` the server edit, or run the new
   section against a stashed copy) — a regression test that never failed proves nothing.
4. Re-apply the fix and run the full suite.
5. Docs (step 5).
6. Commit as one change; the bug doc's status line flips to `fixed` and names the commit.

## 3. Tests to add (`tools/test-contract.py`)

New section using its own `Relay()` instance, placed after the "centre ids, cancel list"
block. A dedicated instance keeps `queue_depth` assertions free of earlier items.

| id | test | assertions |
|---|---|---|
| T1 | served → ack without `seen` → two `/v1/inbox` | id absent from `items` both times; `served_count` stays at its pre-ack value; `state == "answered"`; `rendered_at` still `None` |
| T2 | ack-before-render does not occupy the queue | `GET /health` → `queue_depth == 0`; with `Relay({"QUEUE_MAX": "1"})`, the next `/v1/notify` is `201`, not `429 queue_full` |
| T3 | no `abandoned` fact, no state rewrite | 12 × `/v1/inbox`; `kind=abandoned` filtered to this id is `[]`; `state == "answered"`; `served_count` unchanged |
| T4 | late first render report does not un-answer (D2) | notify → ack → `seen(ids, centre)`; `state == "answered"`, `rendered_at` set, `centre_id` stored, `inbox.cancel` contains the centre id |
| T5 | answered item is not relabelled expired (D1) | notify with `expires_at = now+1500ms` → ack → sleep past it → `/v1/inbox`; `kind=expired` filtered to the id is `[]`; `state == "answered"` |
| T6 | control: the rendered → answered path is unchanged | existing block at ~line 300 already asserts `cancel == [4242]` and that a confirmed cancel is not repeated; keep as-is, plus assert `state` stays `answered` after a duplicate `seen` for the same id |
| T7 | restart does not resurrect it | ack-before-render, `r.restart()`, then `/v1/inbox` → id absent (guards the state file, not just the in-memory dict) |

Expected new assertion count: ~14, on top of the baseline. T2's second half belongs to the
existing `queue cap` instance (it already builds `QUEUE_MAX=1`), so reuse it instead of
starting another relay.

## 4. Acceptance gates

Run all of these; each has an expected output, not just "no error".

1. `python3 tools/test-contract.py` → `N passed, 0 failed`, `N = 98 + new assertions`.
   Measured after the fix: **117 passed, 0 failed** (19 new assertions, not the ~14
   estimated above). Record both numbers in the commit message.
2. `bash <repro A>` (scenario A script, kept out of the repo) →
   `served: 0` twice, `queue_depth: 0`, `state: answered`, no `abandoned` fact.
3. Scenario D1 → no `expired` fact, `state: answered`.
4. Scenario D2 → `state: answered`, `cancel` contains the centre id.
5. `git grep -n '"acked"' -- server watch tools` → no hits (the bug doc is the only
   remaining mention, and it is historical).
6. `python3 tools/schema-check.py` → unchanged/pass (no schema edit expected).
7. Restart check by hand, same as T7, on a state file produced by the *fixed* server:
   confirm the answered item is not served after a restart and stays out of
   `queue_depth`.
8. Confirm `queue_depth` semantics did not silently narrow: queue two items, ack one,
   `queue_depth == 1`; render the other, `queue_depth == 0`.

## 5. Doc changes

| file | change |
|---|---|
| `docs/bug-answered-items-still-deliverable.md` | Status → `fixed` (date, commit); add D1/D2 and the corrected site count; note the `replaceable` decision taken |
| `docs/contract.md` §5.5 | one sentence making the invariant explicit: an answer is terminal for delivery and for expiry; a late render report never demotes it |
| `docs/contract.md` §5.1 | add "**and** not yet answered" to the in-place-replacement condition, so the text matches the code and D3 is closed by decision rather than accident |
| `docs/contract.md` §5.6 | note that `abandoned` is only reachable for unanswered items |
| `docs/status.md` | NOW block: one line under the current build — "answered-before-rendered no longer re-served (relay-only fix; no watch rebuild required)" |

§5.1 wording is the only user-visible contract change, and it narrows a promise the code
never made. Call it out in the commit message rather than burying it.

## 6. Risk, rollback, open decisions

* **Risk:** the only behavioural change is that items with `answers` stop being served.
  `ack()` is the only writer of `answers` outside the legacy migration, so no item can
  be silenced without a button press. Rollback is `git revert` of a single commit; state
  files are untouched by the fix, so a revert restores the old serving behaviour without
  a migration step.
* **Decision needed (default in this plan):** accept `replaceable`'s "not yet answered"
  rule and fix the comment + §5.1 — do not relax it. The alternative (rewriting an
  answered item in place) contradicts append-only answers.
* **Decision needed (default in this plan):** leave persisted `state` values alone and
  rely on the invariant; do not rewrite `abandoned`/`expired` items that carry answers.
* **Decision needed:** whether D1/D2 are fixed in the same commit. Default yes: they are
  the same dead value and the same tuple, and splitting them leaves the contract
  internally inconsistent in between.
* **Not covered:** no watch/device change is required or proposed, so the 30-40 % report
  loss that makes the path common stays as documented in §5.0.
