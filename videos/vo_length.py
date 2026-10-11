#!/usr/bin/env python3
"""Narration length check + narration export for videos/*/script.md (stdlib only).

Script conventions (see videos/README.md):
  * front matter line   `target_seconds: 120`   (max length of every cut of this video)
  * narration lines     `VO: text ...`           (spoken in every cut)
  * variant lines       `VO[att]: text ...`      (spoken only in the "att" cut, at the place where they stand;
                                                  a cut = base VO + its variant VO, in file order)
  * tokens              {{brand.name}}, {{brand.support_email}}, {{price.RCP.setup}}, {{price.RCP.monthly}},
                        {{rules.included_usage.voice_minutes}}, {{brand.quote_sla_text}} ... resolved from
                        config/brand.json and config/pricebook.json (never hard-code brand strings or prices).
Pacing rule: <= 120 words per minute, so seconds = words / 2. A cut fails if it is longer than target_seconds
or longer than 150 s (TASKS B11).

usage:
  python3 videos/vo_length.py                 # check every videos/*/script.md
  python3 videos/vo_length.py videos/02-call-forwarding
  python3 videos/vo_length.py --export videos/02-call-forwarding [--variant att]   # print narration text for TTS
Exit 1 on any failure (unknown token, over length, no VO lines).
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WPM = 120
HARD_MAX = 150
VO_RX = re.compile(r'^\s*(?:[-*]\s*)?VO(?:\[([a-z0-9_-]+)\])?:\s*(.+?)\s*$')
TOKEN_RX = re.compile(r'\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}')
TARGET_RX = re.compile(r'^\s*target_seconds:\s*(\d+)\s*$', re.M)


def load_config():
    with open(os.path.join(ROOT, 'config', 'brand.json'), encoding='utf-8') as f:
        brand = json.load(f)
    with open(os.path.join(ROOT, 'config', 'pricebook.json'), encoding='utf-8') as f:
        pb = json.load(f)
    return brand, pb


def money(cents):
    d = cents / 100
    return f'${d:,.0f}' if d == int(d) else f'${d:,.2f}'


def resolve(token, brand, pb):
    head, _, rest = token.partition('.')
    if head == 'brand':
        v = brand
        for k in rest.split('.'):
            if not isinstance(v, dict) or k not in v:
                raise KeyError(token)
            v = v[k]
        return str(v)
    if head == 'price':
        code, _, field = rest.rpartition('.')
        item = next((i for i in pb['items'] if i['code'] == code), None)
        if item is None or field not in ('setup', 'monthly'):
            raise KeyError(token)
        return money(item[field + '_cents'])
    if head == 'rules':
        v = pb['rules']
        for k in rest.split('.'):
            if not isinstance(v, dict) or k not in v:
                raise KeyError(token)
            v = v[k]
        return f'{v:,}' if isinstance(v, int) else str(v)
    raise KeyError(token)


def render(text, brand, pb):
    return TOKEN_RX.sub(lambda m: resolve(m.group(1), brand, pb), text)


def words(text):
    return len([w for w in re.split(r'\s+', text) if re.search(r'[A-Za-z0-9]', w)])


def parse(path):
    """-> (target, base lines, {variant: lines}, ordered [(variant or None, line)] in file order)."""
    with open(path, encoding='utf-8') as f:
        src = f.read()
    m = TARGET_RX.search(src)
    target = int(m.group(1)) if m else HARD_MAX
    base, variants, ordered = [], {}, []
    for line in src.splitlines():
        v = VO_RX.match(line)
        if not v:
            continue
        (variants.setdefault(v.group(1), []) if v.group(1) else base).append(v.group(2))
        ordered.append((v.group(1), v.group(2)))
    return target, base, variants, ordered


def cut_lines(ordered, variant):
    """Narration of one cut in file order: base lines + this variant's lines where they stand."""
    return [t for k, t in ordered if k is None or k == variant]


def script_paths(args):
    if not args:
        args = sorted(os.path.join(HERE, d) for d in os.listdir(HERE)
                      if os.path.isfile(os.path.join(HERE, d, 'script.md')))
    out = []
    for a in args:
        p = a if a.endswith('.md') else os.path.join(a, 'script.md')
        out.append(os.path.abspath(p))
    return out


def check(paths):
    brand, pb = load_config()
    failed = 0
    for p in paths:
        name = os.path.basename(os.path.dirname(p))
        try:
            target, base, variants, ordered = parse(p)
            cuts = {'main': render(' '.join(base), brand, pb)}
            cuts.update({k: render(' '.join(cut_lines(ordered, k)), brand, pb) for k in variants})
        except KeyError as e:
            print(f'FAIL {name}: unknown token {e}')
            failed += 1
            continue
        if not base:
            print(f'FAIL {name}: no VO lines')
            failed += 1
            continue
        limit = min(target, HARD_MAX)
        for cut, txt in cuts.items():
            n = words(txt)
            secs = round(n * 60 / WPM)
            ok = secs <= limit
            failed += 0 if ok else 1
            print(f'{"ok  " if ok else "FAIL"} {name} [{cut}]: {n} words = {secs}s at {WPM} wpm (target <= {limit}s)')
    print(f'vo_length: {len(paths)} script(s), {failed} failure(s)')
    return 1 if failed else 0


def export(path, variant):
    brand, pb = load_config()
    _, _, variants, ordered = parse(path)
    lines = cut_lines(ordered, variant)
    if variant and variant not in variants:
        print(f'unknown variant {variant}; have: {", ".join(sorted(variants))}', file=sys.stderr)
        return 1
    print('\n'.join(render(x, brand, pb) for x in lines))
    return 0


def main(argv):
    if argv and argv[0] == '--export':
        if len(argv) < 2:
            print(__doc__)
            return 2
        variant = argv[argv.index('--variant') + 1] if '--variant' in argv else None
        return export(script_paths([argv[1]])[0], variant)
    return check(script_paths(argv))


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
