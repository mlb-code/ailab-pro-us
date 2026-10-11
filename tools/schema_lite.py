"""Minimal JSON Schema validator (stdlib only) for our config schemas.

Supports the subset we use: type (incl. lists and "null"), required, properties, additionalProperties
(bool or schema), propertyNames, enum, const, pattern, minimum, maximum, minLength, minItems, items,
and local $ref ("#/$defs/..."). Unknown keywords are ignored, so keep config schemas within this subset.

usage (library): errors = validate(instance, schema) -> list[str]  (empty = valid)
usage (cli):     python3 tools/schema_lite.py <schema.json> <instance.json>
"""
import json
import re
import sys

_TYPES = {
    'object': lambda v: isinstance(v, dict),
    'array': lambda v: isinstance(v, list),
    'string': lambda v: isinstance(v, str),
    'integer': lambda v: isinstance(v, int) and not isinstance(v, bool),
    'number': lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    'boolean': lambda v: isinstance(v, bool),
    'null': lambda v: v is None,
}


def _resolve(ref, root):
    if not ref.startswith('#/'):
        raise ValueError(f'only local $ref supported: {ref}')
    node = root
    for part in ref[2:].split('/'):
        node = node[part]
    return node


def validate(inst, schema, root=None, path='$'):
    root = root if root is not None else schema
    errs = []
    if '$ref' in schema:
        return validate(inst, _resolve(schema['$ref'], root), root, path)
    t = schema.get('type')
    if t is not None:
        types = t if isinstance(t, list) else [t]
        if not any(_TYPES[x](inst) for x in types):
            return [f'{path}: expected {"|".join(types)}, got {type(inst).__name__}']
    if 'enum' in schema and inst not in schema['enum']:
        errs.append(f'{path}: {inst!r} not in {schema["enum"]}')
    if 'const' in schema and inst != schema['const']:
        errs.append(f'{path}: must be {schema["const"]!r}')
    if isinstance(inst, str):
        if 'pattern' in schema and not re.search(schema['pattern'], inst):
            errs.append(f'{path}: {inst!r} does not match {schema["pattern"]}')
        if len(inst) < schema.get('minLength', 0):
            errs.append(f'{path}: shorter than {schema["minLength"]}')
    if _TYPES['number'](inst):
        if 'minimum' in schema and inst < schema['minimum']:
            errs.append(f'{path}: {inst} < minimum {schema["minimum"]}')
        if 'maximum' in schema and inst > schema['maximum']:
            errs.append(f'{path}: {inst} > maximum {schema["maximum"]}')
    if isinstance(inst, list):
        if len(inst) < schema.get('minItems', 0):
            errs.append(f'{path}: fewer than {schema["minItems"]} items')
        if 'items' in schema:
            for i, v in enumerate(inst):
                errs += validate(v, schema['items'], root, f'{path}[{i}]')
    if isinstance(inst, dict):
        for k in schema.get('required', []):
            if k not in inst:
                errs.append(f'{path}: missing required "{k}"')
        props = schema.get('properties', {})
        extra = schema.get('additionalProperties', True)
        for k, v in inst.items():
            if 'propertyNames' in schema:
                errs += validate(k, schema['propertyNames'], root, f'{path}.<key {k}>')
            if k in props:
                errs += validate(v, props[k], root, f'{path}.{k}')
            elif extra is False:
                errs.append(f'{path}: unexpected property "{k}"')
            elif isinstance(extra, dict):
                errs += validate(v, extra, root, f'{path}.{k}')
    return errs


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding='utf-8') as a, open(sys.argv[2], encoding='utf-8') as b:
        errors = validate(json.load(b), json.load(a))
    print('\n'.join(errors) or 'valid')
    sys.exit(1 if errors else 0)
