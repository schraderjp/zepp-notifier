#!/usr/bin/env python3
"""Check docs/client-checklist.md against docs/schema-v1.json, field by field.

Why this exists: a sender app written against docs/contract.md shipped five wrong
assumptions in one night, and its own test suite could not see any of them because the
fakes were written from the same prose. docs/schema-v1.json was right the whole time but
was not the file the author read. Prose cannot be executed; this can:

    tools/check-checklist.py             # exit 0 = checklist and schema agree
    tools/check-checklist.py -v          # print each field it verified

Convention in the checklist - one binding per table, then one row per field:

    schema: $defs/notifyResponse

    | field | type | notes |
    |---|---|---|
    | `id` | string | ... |

`type` must be exactly what this tool renders for that field in the schema:
  string / integer / boolean / object / array / string|null / online|stale|silent /
  "ack-driven" (const, quoted) / action|chain|fact|... (a $ref, named by its def).

Field paths may be dotted (`chain.queue_depth`) and may descend into array items with a
trailing `[]` (`actions[].id`). Anything the checklist invents, misspells, or types
differently is a failure - which is the point: a checklist that can drift is the bug.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHECKLIST = os.path.join(ROOT, "docs", "client-checklist.md")
SCHEMA = os.path.join(ROOT, "docs", "schema-v1.json")

VERBOSE = "-v" in sys.argv

BINDING = re.compile(r"^schema:\s*\$defs/([A-Za-z0-9_]+)\s*$")
# The type cell may contain escaped pipes (`string\|null`), which is how a markdown table
# spells a union. Stop at the first UNescaped pipe.
ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*((?:\\.|[^|\\])+?)\s*\|")


def deref(node, root):
    seen = 0
    while isinstance(node, dict) and "$ref" in node:
        ref = node["$ref"]
        target = root
        for part in ref.lstrip("#/").split("/"):
            target = target.get(part) if isinstance(target, dict) else None
        node = target
        seen += 1
        if seen > 10 or node is None:
            return {}
    return node


def render_type(node, root):
    # A `$ref` is reported by the name of the definition it points at: that is how a
    # reader follows the shape, and how the checklist can be grepped for it.
    if isinstance(node, dict) and "$ref" in node:
        return node["$ref"].rsplit("/", 1)[-1]
    node = deref(node, root)
    if not isinstance(node, dict) or not node:
        return "?"
    if "const" in node:
        return json.dumps(node["const"])
    if "enum" in node:
        return "|".join(str(x) for x in node["enum"])
    t = node.get("type")
    if isinstance(t, list):
        return "|".join(t)
    if t:
        return t
    return "?"


def resolve(name, path, root):
    """Walk a dotted field path through one $defs entry. Returns the field node."""
    node = root["$defs"].get(name)
    if node is None:
        return None
    for part in path.split("."):
        into_items = part.endswith("[]")
        if into_items:
            part = part[:-2]
        node = deref(node, root)
        props = (node or {}).get("properties") or {}
        if part not in props:
            return None
        node = props[part]
        if into_items:
            node = deref(node, root).get("items") or {}
    return node


def main():
    if not os.path.exists(CHECKLIST):
        print("missing " + CHECKLIST)
        return 2
    root = json.load(open(SCHEMA, encoding="utf-8"))
    defs = root.get("$defs", {})

    name = None
    checked = 0
    failures = []
    bound = set()

    for lineno, line in enumerate(open(CHECKLIST, encoding="utf-8"), 1):
        text = line.rstrip("\n")
        m = BINDING.match(text.strip())
        if m:
            name = m.group(1)
            if name not in defs:
                failures.append(f"line {lineno}: `schema: $defs/{name}` is not in schema-v1.json")
                name = None
            else:
                bound.add(name)
            continue
        m = ROW.match(text)
        if not m or name is None:
            continue
        field, declared = m.group(1).strip(), m.group(2).strip()
        node = resolve(name, field, root)
        if node is None:
            failures.append(f"line {lineno}: {name}.{field} is not in the schema")
            continue
        expected = render_type(node, root)
        if norm(declared) != norm(expected):
            failures.append(
                f"line {lineno}: {name}.{field} declared {declared!r}, schema says {expected!r}"
            )
            continue
        checked += 1
        if VERBOSE:
            print(f"  ok   {name}.{field} : {expected}")

    uncovered = sorted(k for k in defs if k not in bound)
    print(f"client-checklist: {checked} field(s) checked against {len(bound)} definition(s)")
    if uncovered:
        print("  not covered (fine for internal shapes, suspicious for anything a client reads): "
              + ", ".join(uncovered))
    for f in failures:
        print("  FAIL " + f)
    print("PASS" if not failures else f"{len(failures)} failure(s)")
    return 0 if not failures else 1


def norm(text):
    return re.sub(r"\s+", "", text.replace("\\|", "|"))


if __name__ == "__main__":
    sys.exit(main())
