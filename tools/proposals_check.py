#!/usr/bin/env python3
"""Upwork proposal kit checker. Stdlib only.

Checks docs/kits/upwork-proposals.md and videos/11-upwork-loom.md against config/brand.json and
config/pricebook.json:
  * every `<!-- template: ID -->` block: <= 180 words, contains the demo URL (brand.site_url), has a question
  * every template and `<!-- snippet: ID -->` block: no forbidden claims or client names; every $ figure is a
    price-book price (setup, monthly, 50% deposit, founding setup, or core + add-on sum); every URL is under
    brand.site_url; no phone number, email or calendar link (Upwork: no contact info before a contract);
    every {placeholder} is in the legend table
  * website templates (b-*) never mention a guarantee (WEB has none)
  * `<!-- loom: ID -->` blocks: spoken prices / business days match the price book; word count printed

usage: python3 tools/proposals_check.py [--self-test]      exit 1 on any failure
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(ROOT, 'docs', 'kits', 'upwork-proposals.md')
LOOM = os.path.join(ROOT, 'videos', '11-upwork-loom.md')
MAX_WORDS = 180

BLOCK_RX = re.compile(r'<!--\s*(template|snippet|loom):\s*([a-z0-9-]+)\s*-->\s*\n```[a-z]*\n(.*?)\n```', re.S)
MONEY_RX = re.compile(r'\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?')
URL_RX = re.compile(r'https?://[^\s)<>]+')
PLACEHOLDER_RX = re.compile(r'\{([a-z_]+)\}')
CONTACT_RX = [
    ('phone number', re.compile(r'(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b')),
    ('email', re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')),
    ('calendar link', re.compile(r'calendar\.app\.google|calendly\.com|cal\.com/|calendar\.google\.com', re.I)),
]
FORBIDDEN = [
    r'guarantee[sd]?\s+(your\s+)?results?', r'results?\s+guaranteed', r'\bguaranteed\b',
    r'hipaa[\s-]+compliant', r'tcpa[\s-]+compliant', r'\bcompliant\b', r'double your', r'#1\b',
    r'\d+\s?%\s+more', r'\bsamsung\b', r'\bhaier\b', r'\bnewpan\b',
]
GUARANTEE_OK = '30-day satisfaction guarantee'
# Spoken price / day words used in the Loom script -> value they must match.
SPOKEN = {
    'thirty-five hundred dollars': ('setup', 'RCP'), 'three hundred a month': ('monthly', 'RCP'),
    'nineteen hundred dollars': ('setup', 'WEB'), 'one twenty-nine a month': ('monthly', 'WEB'),
}
SPOKEN_VALUES = {'thirty-five hundred dollars': 3500, 'three hundred a month': 300,
                 'nineteen hundred dollars': 1900, 'one twenty-nine a month': 129}
DAY_WORDS = {'seven': 7, 'ten': 10, 'fourteen': 14}


def load(name):
    with open(os.path.join(ROOT, 'config', name), encoding='utf-8') as fh:
        return json.load(fh)


def allowed_dollars(pb):
    """Whole-dollar amounts a proposal may quote."""
    items = {i['code']: i for i in pb['items']}
    out = set()
    for i in items.values():
        for k in ('setup_cents', 'monthly_cents'):
            if i.get(k):
                out.add(i[k] / 100)
    dep = pb['rules']['deposit_pct'] / 100
    for code in pb['rules']['core_codes']:
        s = items[code]['setup_cents'] / 100
        out.add(round(s * dep))
        for d in pb['rules']['discounts'].values():
            out.add(round(s * (1 - d['setup_pct'] / 100)))
    for a in items.values():
        if a['group'] == 'addon' and a['kind'] == 'fixed':
            for core in a['applies_to']:
                if core in items:
                    out.add((items[core]['setup_cents'] + a['setup_cents']) / 100)
                    out.add((items[core]['monthly_cents'] + a['monthly_cents']) / 100)
    return out


def check_text(bid, kind, text, ctx, errs):
    low = text.lower()
    for rx in FORBIDDEN:
        m = re.search(rx, low)
        if m:
            errs.append(f'{bid}: forbidden claim/name "{m.group(0)}"')
    if 'guarantee' in low:
        if bid.startswith('b-'):
            errs.append(f'{bid}: website templates must not mention a guarantee')
        elif low.count('guarantee') != low.count(GUARANTEE_OK):
            errs.append(f'{bid}: "guarantee" only as "{GUARANTEE_OK}"')
    for m in MONEY_RX.finditer(text):
        v = float(m.group(1).replace(',', '') + ('.' + m.group(2) if m.group(2) else ''))
        if v not in ctx['dollars']:
            errs.append(f'{bid}: ${m.group(1)} is not a price-book amount')
    for label, rx in CONTACT_RX:
        m = rx.search(text)
        if m:
            errs.append(f'{bid}: contact info before a contract ({label}): {m.group(0)}')
    if ctx['cal'] and ctx['cal'] in text:
        errs.append(f'{bid}: booking link not allowed before a contract')
    for u in URL_RX.findall(text):
        u = u.rstrip('.,')
        if not u.startswith(ctx['site']):
            errs.append(f'{bid}: only {ctx["site"]} links are allowed: {u}')
    for p in PLACEHOLDER_RX.findall(text):
        if p not in ctx['legend']:
            errs.append(f'{bid}: placeholder {{{p}}} missing from the legend')
    if kind == 'template':
        n = len(text.split())
        ctx['report'].append(f'  {bid:9s} {n:3d} words')
        if n > MAX_WORDS:
            errs.append(f'{bid}: {n} words (max {MAX_WORDS})')
        if ctx['site'] not in text:
            errs.append(f'{bid}: missing demo URL {ctx["site"]}')
        if '?' not in text:
            errs.append(f'{bid}: no question back to the client')


def check_loom(bid, text, pb, ctx, errs):
    items = {i['code']: i for i in pb['items']}
    low = text.lower()
    for phrase, (field, code) in SPOKEN.items():
        if phrase in low and items[code][field + '_cents'] / 100 != SPOKEN_VALUES[phrase]:
            errs.append(f'loom {bid}: "{phrase}" no longer matches {code} {field}')
    for m in re.finditer(r'\b(seven|ten|fourteen) business days', low):
        if DAY_WORDS[m.group(1)] not in {i.get('delivery_business_days') for i in items.values()}:
            errs.append(f'loom {bid}: "{m.group(0)}" is not a price-book delivery time')
    if '$' in text:
        errs.append(f'loom {bid}: speak prices in words, not "$"')
    ctx['report'].append(f'  loom {bid:4s} {len(text.split()):3d} spoken words')


def run(kit_text, loom_text, brand, pb):
    errs, report = [], []
    legend = set(PLACEHOLDER_RX.findall(kit_text.split('## 2.')[0])) | {'tool_line'}
    ctx = {'dollars': allowed_dollars(pb), 'site': brand['site_url'].rstrip('/'), 'cal': brand['calendly_url'],
           'legend': legend, 'report': report}
    blocks = BLOCK_RX.findall(kit_text)
    templates = [b for b in blocks if b[0] == 'template']
    if len(templates) < 6:
        errs.append(f'expected 6 templates (3 x short/full), found {len(templates)}')
    for kind, bid, text in blocks:
        check_text(bid, kind, text, ctx, errs)
    for kind, bid, text in BLOCK_RX.findall(loom_text or ''):
        if kind == 'loom':
            check_loom(bid, text, pb, ctx, errs)
    return errs, report, len(blocks)


def self_test(brand, pb):
    site, cal = brand['site_url'], brand['calendly_url']
    legend = '| `{first_name}` |\n## 2.\n'
    good = legend + f'<!-- template: a-x -->\n```text\nHi {{first_name}}, $3,500 + $300/month. {site}/demo/ ok?\n```\n'
    assert run(good + good + good + good + good + good, '', brand, pb)[0] == [], 'good kit must pass'
    bad = legend + ('<!-- template: b-x -->\n```text\nHIPAA compliant, guaranteed, Samsung, $999, '
                    'https://evil.example {x} 30-day satisfaction guarantee\n```\n')
    e = ' '.join(run(bad, '', brand, pb)[0])
    for needle in ('hipaa', 'guaranteed', 'samsung', '$999', 'evil.example', '{x}', 'demo URL', 'question',
                   'website templates'):
        assert needle in e, f'self-test: expected failure about {needle}'
    contact = legend + (f'<!-- template: a-z -->\n```text\n{site} ok? {cal} call +1 (832) 555-0147 '
                        'or 832.555.0147, mail me@example.com, calendly.com/meir\n```\n')
    e = ' '.join(run(contact, '', brand, pb)[0])
    for needle in ('phone number', 'email', 'calendar link', 'booking link'):
        assert needle in e, f'self-test: expected contact failure about {needle}'
    long = legend + '<!-- template: a-y -->\n```text\n' + 'word ' * 200 + f'{site} ?\n```\n'
    assert 'words (max' in ' '.join(run(long, '', brand, pb)[0])
    loom = '<!-- loom: z -->\n```text\nTwelve hundred dollars. $5. ten business days.\n```\n'
    assert any('speak prices' in x for x in run(good, loom, brand, pb)[0])
    print('proposals_check self-test: OK')


def main():
    brand, pb = load('brand.json'), load('pricebook.json')
    if '--self-test' in sys.argv:
        self_test(brand, pb)
        return 0
    with open(KIT, encoding='utf-8') as fh:
        kit = fh.read()
    loom = open(LOOM, encoding='utf-8').read() if os.path.exists(LOOM) else ''
    errs, report, n = run(kit, loom, brand, pb)
    print('\n'.join(report))
    if errs:
        print('proposals_check: FAIL')
        print('\n'.join('  - ' + e for e in errs))
        return 1
    print(f'proposals_check: OK ({n} blocks checked)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
