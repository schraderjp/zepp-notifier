#!/usr/bin/env python3
"""Validate relay payloads against a JSON Schema subset, with no dependencies.

Why a hand-rolled validator: this box has no `pip`, and the value here is not
standards-completeness — it is being able to point at the live relay and say "the
payloads really do look like the schema we documented". Supported keywords are the ones
the two schema files use: type, required, properties, additionalProperties (false only),
items, enum, const, oneOf, anyOf, minItems, maxItems, minLength, maxLength, pattern,
minimum, maximum. Unknown keywords are ignored, including if/then.

Usage:
    tools/schema-check.py --live docs/schema-as-implemented.json
    tools/schema-check.py docs/schema-v1.json --defs      # validate the built-in examples
    tools/schema-check.py docs/schema-v1.json file.json --def notifyRequest
"""
import json
import re
import sys
import urllib.request

TYPES = {
    'object': dict,
    'array': list,
    'string': str,
    'integer': int,
    'number': (int, float),
    'boolean': bool,
    'null': type(None),
}


def type_ok(value, name):
    expected = TYPES.get(name)
    if expected is None:
        return True
    if name == 'integer' and isinstance(value, bool):
        return False
    return isinstance(value, expected)


def validate(instance, schema, path='$', errors=None, root=None):
    errors = errors if errors is not None else []
    root = root or schema

    if '$ref' in schema:
        ref = schema['$ref']
        target = root
        for part in ref.lstrip('#/').split('/'):
            target = target[part]
        return validate(instance, target, path, errors, root)

    if 'type' in schema:
        names = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        if not any(type_ok(instance, n) for n in names):
            errors.append(f'{path}: expected {"|".join(names)}, got {type(instance).__name__}')
            return errors

    if 'const' in schema and instance != schema['const']:
        errors.append(f'{path}: expected const {schema["const"]!r}, got {instance!r}')

    if 'enum' in schema and instance not in schema['enum']:
        errors.append(f'{path}: {instance!r} not in {schema["enum"]}')

    if 'oneOf' in schema:
        matches = [s for s in schema['oneOf'] if not validate(instance, s, path, [], root)]
        if len(matches) != 1:
            errors.append(f'{path}: matched {len(matches)} of oneOf, expected exactly 1')
    if 'anyOf' in schema:
        if not any(not validate(instance, s, path, [], root) for s in schema['anyOf']):
            errors.append(f'{path}: matched none of anyOf')

    if isinstance(instance, dict):
        for key in schema.get('required', []):
            if key not in instance:
                errors.append(f'{path}: missing required {key!r}')
        props = schema.get('properties', {})
        for key, value in instance.items():
            if key in props:
                validate(value, props[key], f'{path}.{key}', errors, root)
            elif schema.get('additionalProperties') is False:
                errors.append(f'{path}: unexpected property {key!r}')

    if isinstance(instance, list):
        if 'minItems' in schema and len(instance) < schema['minItems']:
            errors.append(f'{path}: fewer than {schema["minItems"]} items')
        if 'maxItems' in schema and len(instance) > schema['maxItems']:
            errors.append(f'{path}: more than {schema["maxItems"]} items')
        if 'items' in schema:
            for i, item in enumerate(instance):
                validate(item, schema['items'], f'{path}[{i}]', errors, root)

    if isinstance(instance, str):
        if 'minLength' in schema and len(instance) < schema['minLength']:
            errors.append(f'{path}: shorter than {schema["minLength"]} chars')
        if 'maxLength' in schema and len(instance) > schema['maxLength']:
            errors.append(f'{path}: longer than {schema["maxLength"]} chars')
        if 'pattern' in schema and not re.search(schema['pattern'], instance):
            errors.append(f'{path}: {instance!r} does not match {schema["pattern"]}')

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if 'minimum' in schema and instance < schema['minimum']:
            errors.append(f'{path}: {instance} < minimum {schema["minimum"]}')
        if 'maximum' in schema and instance > schema['maximum']:
            errors.append(f'{path}: {instance} > maximum {schema["maximum"]}')

    return errors


def get(path, base='http://127.0.0.1:8097'):
    with urllib.request.urlopen(base + path, timeout=10) as r:
        return json.load(r)


def live(schema_path):
    schema = json.load(open(schema_path, encoding='utf-8'))
    defs = schema.get('$defs', {})
    cases = []

    health = get('/health')
    cases.append(('healthResponse', health))
    cases.append(('inboxResponse', get('/v1/inbox?device=schemacheck&peek=1')))

    state = get('/state')
    rows = state.get('notifications') or []
    for row in rows[:200]:
        cases.append(('notification', row))
    if not rows:
        print('note: no notifications in state, so `notification` was not exercised')

    failures = 0
    for name, payload in cases:
        if name not in defs:
            print(f'  SKIP {name}: not defined in {schema_path}')
            continue
        errs = validate(payload, defs[name], root=schema)
        if errs:
            failures += 1
            print(f'  FAIL {name}')
            for e in errs[:6]:
                print(f'        {e}')
        else:
            print(f'  ok   {name}')
    print(f'\n{schema_path}: {"PASS" if not failures else str(failures) + " failing case(s)"}')
    return 0 if not failures else 1


def examples(schema_path):
    schema = json.load(open(schema_path, encoding='utf-8'))
    defs = schema.get('$defs', {})
    failures = 0
    tested = 0
    for name, sub in defs.items():
        for i, example in enumerate(sub.get('examples', [])):
            tested += 1
            errs = validate(example, sub, root=schema)
            if errs:
                failures += 1
                print(f'  FAIL {name}[{i}]')
                for e in errs[:6]:
                    print(f'        {e}')
            else:
                print(f'  ok   {name}[{i}]')
    print(f'\n{schema_path}: {tested} example(s), {"PASS" if not failures else str(failures) + " failing"}')
    return 0 if not failures else 1


def one(schema_path, instance_path, name):
    schema = json.load(open(schema_path, encoding='utf-8'))
    defs = schema.get('$defs', {})
    instance = json.load(open(instance_path, encoding='utf-8'))
    target = defs.get(name) if name else schema
    if target is None:
        print(f'no $defs.{name} in {schema_path}')
        return 2
    errs = validate(instance, target, root=schema)
    for e in errs:
        print(e)
    print('PASS' if not errs else f'{len(errs)} error(s)')
    return 0 if not errs else 1


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if '--live' in flags:
        sys.exit(live(args[0]))
    if '--defs' in flags:
        sys.exit(examples(args[0]))
    if len(args) >= 2:
        name = None
        if '--def' in sys.argv:
            name = sys.argv[sys.argv.index('--def') + 1]
        sys.exit(one(args[0], args[1], name))
    print(__doc__)
    sys.exit(2)
