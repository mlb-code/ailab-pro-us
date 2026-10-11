"""Hard-coded brand / price guard. Stdlib only.

Brand, domain, senders, analytics IDs and the Claude model must come from config/brand.json; prices from
config/pricebook.json. This script flags literal copies of those values in source files.

usage:
  python3 tools/check_hardcoded.py [path ...]    default paths: site supabase runtime templates
  python3 tools/check_hardcoded.py --self-test

Rules
  * Source files (.html .js .mjs .ts .css .py .gs .json .sql .svg .xml .txt): any brand value or any
    pricebook price written as a dollar amount ("$3,500", "$3500", "$300/mo") is an ERROR.
  * Generated files (a line containing "generated-by: tools/" in the first 2 KB) and prose (.md) may
    contain these values (they are rendered from config and verified by their build --check); there,
    dollar amounts that are NOT in the price book are reported as WARN so drift is visible.
  * A line containing "hardcoded-ok" is skipped (use sparingly; the reviewer reads every one).
  * Comment-only lines (starting with #, //, /*, *, --, <!--) are skipped: the rule targets rendered strings.
  * Exact copies of config/*.json made by tools/sync_config.py are skipped.
Exit 1 on any ERROR. Missing config files: prints a notice and checks nothing (exit 0).
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, 'config')
DEFAULT_PATHS = ['site', 'supabase', 'runtime', 'templates']
SKIP_DIRS = {'.git', 'node_modules', 'qa-shots', '.venv', 'venv', '__pycache__', 'fixtures', 'replays', 'tests'}
SOURCE_EXT = {'.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.py', '.gs', '.json', '.sql',
              '.svg', '.xml', '.txt', '.toml', '.yaml', '.yml'}
PROSE_EXT = {'.md'}
GEN_MARK = 'generated-by: tools/'
PRAGMA = 'hardcoded-ok'
COMMENT_RX = re.compile(r'^\s*(#|//|/\*|\*|--|<!--)')
# brand.json keys whose string values are "brand strings". Anything under these keys counts.
BRAND_KEYS = ('name', 'domain', 'site_url', 'support_email', 'senders', 'legal_entity', 'analytics',
              'calendly_url', 'claude', 'physical_address')
MONEY_RX = re.compile(r'\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?')


def load_json(name):
    path = os.path.join(CONFIG, name)
    if not os.path.exists(path):
        return None, None
    with open(path, encoding='utf-8') as fh:
        raw = fh.read()
    return json.loads(raw), raw


def walk_strings(v):
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from walk_strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from walk_strings(x)


def brand_values(brand):
    vals = set()
    for k in BRAND_KEYS:
        for s in walk_strings(brand.get(k)):
            s = s.strip()
            # skip placeholders / tiny / effort words ("low", "medium") / generic words
            if len(s) < 6 or s.startswith('TODO') or s.startswith('__') or ' ' not in s and s.isalpha() and s.islower():
                continue
            vals.add(s)
    # e-mail domain parts and bare host of site_url are covered by "domain"
    return sorted(vals, key=len, reverse=True)


def price_values(pricebook):
    """Whole-dollar amounts that appear in the price book (setup and monthly), excluding 0."""
    out = set()
    for it in pricebook.get('items', []):
        for k in ('setup_cents', 'monthly_cents'):
            c = it.get(k)
            if isinstance(c, int) and c > 0:
                out.add(c / 100)
    return out


def known_amounts(pricebook):
    """Every amount that may legitimately appear in prose: prices, derived deposits, rule thresholds."""
    amounts = set(price_values(pricebook))
    for a in list(amounts):
        amounts.add(round(a / 2))       # 50% deposit / final
        amounts.add(round(a * 0.7))     # FOUNDING setup price
    rules = pricebook.get('rules', {})
    for k, v in rules.items():
        if k.endswith('_cents') and isinstance(v, int):
            amounts.add(v / 100)
    items = {i['code']: i for i in pricebook.get('items', [])}
    if {'RCP', 'WEB', 'BNDL'} <= items.keys():  # bundle savings
        for k in ('setup_cents', 'monthly_cents'):
            amounts.add((items['RCP'][k] + items['WEB'][k] - items['BNDL'][k]) / 100)
    return amounts


def amount_of(m):
    whole = int(m.group(1).replace(',', ''))
    cents = int(m.group(2)) if m.group(2) else 0
    return whole + cents / 100


def config_copies():
    """Raw text of config files: exact copies elsewhere are allowed (made by sync_config.py)."""
    texts = set()
    for name in ('brand.json', 'pricebook.json', 'pricebook.schema.json'):
        p = os.path.join(CONFIG, name)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as fh:
                texts.add(fh.read())
    return texts


def check_text(text, ext, brand_vals, prices, amounts):
    """Return list of (level, line_no, message)."""
    out = []
    generated = GEN_MARK in text[:2048]
    prose = ext in PROSE_EXT or generated
    for n, line in enumerate(text.splitlines(), 1):
        if PRAGMA in line or COMMENT_RX.match(line):
            continue
        if not prose:
            for v in brand_vals:
                if v in line:
                    out.append(('ERROR', n, f'brand value {v!r} (read it from brand.json)'))
                    break
        for m in MONEY_RX.finditer(line):
            a = amount_of(m)
            if not prose and a in prices:
                out.append(('ERROR', n, f'price {m.group(0)!r} (read it from pricebook.json)'))
            elif prose and a >= 100 and a not in amounts:
                out.append(('WARN', n, f'amount {m.group(0)!r} is not in the price book'))
    return out


def iter_files(paths):
    for p in paths:
        p = p if os.path.isabs(p) else os.path.join(ROOT, p)
        if os.path.isfile(p):
            yield p
            continue
        if not os.path.isdir(p):
            continue
        for root, dirs, files in os.walk(p):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            for f in sorted(files):
                if f.startswith('.env') or '.secrets' in f or f.endswith('.p8'):
                    continue
                yield os.path.join(root, f)


def run(paths):
    brand, _ = load_json('brand.json')
    pricebook, _ = load_json('pricebook.json')
    if brand is None or pricebook is None:
        print('check_hardcoded: config/brand.json or config/pricebook.json missing; nothing to check yet')
        return 0
    brand_vals, prices, amounts = brand_values(brand), price_values(pricebook), known_amounts(pricebook)
    copies = config_copies()
    errors = warns = scanned = 0
    for path in iter_files(paths):
        ext = os.path.splitext(path)[1].lower()
        if ext not in SOURCE_EXT | PROSE_EXT:
            continue
        if os.path.commonpath([os.path.abspath(path), CONFIG]) == CONFIG:
            continue
        try:
            with open(path, encoding='utf-8') as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        if text in copies:
            continue
        scanned += 1
        for level, n, msg in check_text(text, ext, brand_vals, prices, amounts):
            print(f'{level:5} {os.path.relpath(path, ROOT)}:{n}  {msg}')
            errors += level == 'ERROR'
            warns += level == 'WARN'
    print(f'check_hardcoded: {scanned} files, {errors} error(s), {warns} warning(s)')
    return 1 if errors else 0


def self_test():
    brand = {'name': 'Acme Widget Co', 'domain': 'acme-widgets.test', 'claude': {'model': 'model-x-1', 'effort': 'low'}}
    pricebook = {'items': [{'code': 'RCP', 'setup_cents': 350000, 'monthly_cents': 30000}], 'rules': {}}
    bv, pr, am = brand_values(brand), price_values(pricebook), known_amounts(pricebook)
    cases = [
        ('<h1>Acme Widget Co</h1>', '.html', 'ERROR'),
        ('fetch("https://acme-widgets.test/x")', '.js', 'ERROR'),
        ('model: "model-x-1"', '.ts', 'ERROR'),
        ('<b>$3,500</b> setup', '.html', 'ERROR'),
        ('price = "$300/mo"', '.js', 'ERROR'),
        ('<b>$3,500</b> hardcoded-ok', '.html', None),
        ('<!-- generated-by: tools/build_landing.py -->\n<b>$3,500</b> Acme Widget Co', '.html', None),
        ('Setup is $3,500, deposit $1,750.', '.md', None),
        ('Setup is $3,900.', '.md', 'WARN'),
        ('effort low; $5 budget', '.py', None),
        ('# Acme Widget Co runtime, $3,500 example', '.py', None),
        ('/* Acme Widget Co styles */', '.css', None),
    ]
    bad = 0
    for text, ext, expect in cases:
        levels = {lvl for lvl, _, _ in check_text(text, ext, bv, pr, am)}
        got = 'ERROR' if 'ERROR' in levels else 'WARN' if 'WARN' in levels else None
        ok = got == expect
        bad += not ok
        print(f"{'ok  ' if ok else 'BAD '} {ext:5} {text[:46]!r:50} -> {got}")
    print('self-test ' + ('FAILED' if bad else 'passed'))
    return 1 if bad else 0


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--self-test' in args:
        sys.exit(self_test())
    sys.exit(run([a for a in args if not a.startswith('-')] or DEFAULT_PATHS))
