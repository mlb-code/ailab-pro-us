"""Price book consistency test. Stdlib only.

Parses the tables and rules in docs/PRICEBOOK.md and diffs them against config/pricebook.json, validates
pricebook.json against config/pricebook.schema.json, and runs semantic checks (codes, integrations, niches).

usage: python3 tools/pricebook_test.py      exit 0 = all checks pass
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from schema_lite import validate  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MD = os.path.join(ROOT, 'docs', 'PRICEBOOK.md')
PB = os.path.join(ROOT, 'config', 'pricebook.json')
SCHEMA = os.path.join(ROOT, 'config', 'pricebook.schema.json')
BRAND = os.path.join(ROOT, 'config', 'brand.json')

# SPEC 2.3: the closed tool list (10) + Zapier + Other + niche-only tools. Law firms were removed (Addendum).
SPEC_TOOLS = ['Google Calendar', 'Outlook / Microsoft 365 Calendar', 'Calendly', 'Jobber', 'Housecall Pro',
              'ServiceTitan', 'GoHighLevel', 'HubSpot', 'QuickBooks', 'Google Business Profile', 'Zapier', 'Other',
              'Follow Up Boss', 'Dentrix', 'Open Dental']
NICHES = {'home_services', 'real_estate', 'dental'}  # = DB enum (A1), snake_case
REMOVED = re.compile(r'\b(law|lawyers?|law[- ]firms?|clio|legal practice)\b', re.I)

failures = []


def check(cond, msg):
    print(('ok    ' if cond else 'FAIL  ') + msg)
    if not cond:
        failures.append(msg)


def money(cell):
    """Return (kind, value): ('fixed', cents) | ('from', cents) | ('percent', pct) | ('none', 0) | ('custom', None)."""
    c = cell.strip().strip('`')
    if c in ('—', '-', ''):
        return 'none', 0
    if c.lower() == 'custom':
        return 'custom', None
    m = re.fullmatch(r'\+(\d+)% of setup', c)
    if m:
        return 'percent', int(m.group(1))
    m = re.fullmatch(r'(from )?\$([\d,]+)', c)
    if m:
        return ('from' if m.group(1) else 'fixed'), int(m.group(2).replace(',', '')) * 100
    raise ValueError(f'unparsed money cell: {cell!r}')


def md_tables(text):
    """Yield (header, rows) for every markdown table whose first header cell is 'Code'."""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].startswith('| Code |') and i + 1 < len(lines) and set(lines[i + 1].replace('|', '').strip()) <= set('-: '):
            header = [c.strip() for c in lines[i].strip('|').split('|')]
            rows, i = [], i + 2
            while i < len(lines) and lines[i].startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            yield header, rows
        else:
            i += 1


def num(rx, text, cast=int):
    m = re.search(rx, text, re.S)
    return cast(m.group(1).replace(',', '')) if m else None


def main():
    md = open(MD, encoding='utf-8').read()
    pb = json.load(open(PB, encoding='utf-8'))
    schema = json.load(open(SCHEMA, encoding='utf-8'))
    brand = json.load(open(BRAND, encoding='utf-8'))

    # 1. schema
    errs = validate(pb, schema)
    check(not errs, 'pricebook.json validates against pricebook.schema.json' + ('' if not errs else ': ' + '; '.join(errs[:5])))

    items = {it['code']: it for it in pb['items']}
    check(len(items) == len(pb['items']), 'item codes are unique')

    # 2. every PRICEBOOK.md row exists in JSON with equal numbers
    md_codes = []
    for header, rows in md_tables(md):
        col = {h: n for n, h in enumerate(header)}
        name_col = next(h for h in header if h in ('Offer', 'Add-on'))
        for r in rows:
            code = r[col['Code']].strip('`')
            md_codes.append(code)
            it = items.get(code)
            check(it is not None, f'{code}: present in pricebook.json')
            if not it:
                continue
            check(it['name'] == r[col[name_col]], f'{code}: name equals table ({r[col[name_col]]!r})')
            sk, sv = money(r[col['Setup']])
            mk, mv = money(r[col['Monthly']])
            if sk == 'percent':
                check(it['kind'] == 'percent' and it.get('setup_pct') == sv and it['setup_cents'] is None,
                      f'{code}: setup +{sv}% (kind percent)')
            else:
                check(it['setup_cents'] == sv, f'{code}: setup_cents {it["setup_cents"]} == {sv}')
                check(it['kind'] == ('from' if sk == 'from' else 'fixed'), f'{code}: kind {it["kind"]} matches table ({sk})')
            check(it['monthly_cents'] == mv, f'{code}: monthly_cents {it["monthly_cents"]} == {mv}')
            if 'Applies to' in col:
                check(it['applies_to'] == [r[col['Applies to']]], f'{code}: applies_to {it["applies_to"]}')
                check(it['group'] == 'addon', f'{code}: group addon')
            if 'Delivery' in col:
                days = num(r'(\d+) business days', r[col['Delivery']])
                check(it.get('delivery_business_days') == days, f'{code}: delivery {days} business days')
                check(it['group'] == 'core', f'{code}: group core')
    check(len(md_codes) >= 20, f'parsed {len(md_codes)} rows from PRICEBOOK.md tables')
    extra = sorted(set(items) - set(md_codes))
    check(not extra, 'no JSON item missing from PRICEBOOK.md' + (f': {extra}' if extra else ''))

    # 3. rules (section 1 text + section 4)
    R = pb['rules']
    check(R['core_codes'] == ['RCP', 'WEB', 'BNDL'], 'core codes RCP | WEB | BNDL')
    check(R['deposit_pct'] == num(r'Deposit = (\d+)% of setup', md), f'deposit {R["deposit_pct"]}%')
    check(R['rush_pct'] == num(r'Rush = (\d+)% of the setup subtotal', md) == items['ADD-RUSH'].get('setup_pct'), f'rush {R["rush_pct"]}%')
    check(R['manual_price_setup_over_cents'] == num(r'setup total > \$([\d,]+)', md) * 100, 'manual price threshold')
    check(R['discounts']['FOUNDING']['setup_pct'] == num(r'`FOUNDING`.*?= (\d+)% off setup', md), 'FOUNDING % off setup')
    check(R['discounts']['FOUNDING']['max_clients'] == num(r'first (\d+) clients', md), 'FOUNDING max clients')
    check(R['discounts']['FOUNDING']['monthly_pct'] == 0 and 'Monthly fees are never discounted' in md, 'monthly fees never discounted')
    check(R['quote_valid_days'] == num(r'Quote valid (\d+) days', md), 'quote valid days')
    RR = pb['refund_rules']
    check(RR['deposit']['refund_pct'] == 100 and 'fully refunded' in md, 'refund: deposit fully refunded')
    check(RR['deposit']['window_days'] == num(r'within (\d+) days of payment', md), 'refund: deposit window days')
    check('has not completed the access checklist' in md and 'access checklist' in RR['deposit']['condition'], 'refund: deposit condition (access checklist not completed)')
    check(RR['retainer']['refund_pct'] == num(r'Retainers: (\d+)% refund', md), 'refund: retainer % of first payment')
    check(RR['retainer']['window_days'] == num(r'first payment if cancelled within (\d+) days', md), 'refund: retainer window days')
    check(set(RR['retainer']['codes']) == {c for c in items if c.startswith('RET-')}, 'refund: retainer codes = RET-*')
    # satisfaction guarantee (owner decision 2026-10-11): RCP + BNDL only; every client text carries the same day count
    G, gd = RR['rcp_guarantee'], RR['rcp_guarantee_days']
    check(gd == num(r'not satisfied within (\d+) days after go-live', md), f'guarantee: {gd} days after go-live (MD rule 7)')
    check(G['codes'] == ['RCP', 'BNDL'] and 'on `RCP` and `BNDL`' in md, 'guarantee: codes RCP + BNDL only')
    check('WEB' not in G['codes'] and '`WEB` keeps only the 7-day deposit rule' in md, 'guarantee: WEB keeps the deposit rule only')
    check(G['refunds'] == 'setup_fee' and G['monthly_fees_refunded'] is False and 'Monthly fees for the period used are not refunded' in md,
          'guarantee: setup fee refunded, monthly fees not')
    for k in ('label', 'text', 'legal'):
        nums = {int(x) for x in re.findall(r'(\d+)[- ]day', G[k])}
        check(nums == {gd}, f'guarantee: {k} text uses {gd} days only ({sorted(nums)})')
    check('go-live' in G['text'] and 'go-live' in G['legal'], 'guarantee: window counted from go-live in client text')
    D = RR['deposit']
    check({int(x) for x in re.findall(r'(\d+)[- ]day', D['text'] + ' ' + D.get('label', ''))} == {D['window_days']}, 'refund: deposit text/label use window_days')
    check(R['discounts']['FOUNDING'].get('label') == 'Founding-client price' and '"Founding-client price"' in md, 'FOUNDING label = "Founding-client price"')
    check(bool(brand.get('quote_sla_text')) and 'Sunday–Thursday' in (brand.get('business_days_text') or ''), 'brand: quote_sla_text + business_days_text (Sunday–Thursday)')
    check(R['cancel_notice_days'] == num(r'(\d+) days notice', md), 'cancel notice days')
    check(R['included_usage']['voice_minutes'] == num(r'(\d+) voice minutes \+', md), 'included voice minutes')
    check(R['included_usage']['sms_segments'] == num(r'voice minutes \+ ([\d,]+) SMS', md), 'included SMS segments')
    check(R['overage_markup_pct'] == 0 and 'No automatic overage billing' in md and R.get('overage_policy','').startswith('no_auto_billing'), 'overage: no automatic billing (alerts at 80/100, add-on with approval)')
    check(R['custom_triggers']['max_auto_locations'] == num(r'more than (\d+) locations', md), 'custom: > N locations')
    check(R['custom_triggers']['max_auto_voice_minutes_per_month'] == num(r'call volume > ([\d,]+) min/month', md), 'custom: call volume')
    s_save, m_save = num(r'Saves \$([\d,]+) setup', md), num(r'setup / \$([\d,]+) monthly', md)
    check(items['RCP']['setup_cents'] + items['WEB']['setup_cents'] - items['BNDL']['setup_cents'] == s_save * 100, f'bundle saves ${s_save} setup')
    check(items['RCP']['monthly_cents'] + items['WEB']['monthly_cents'] - items['BNDL']['monthly_cents'] == m_save * 100, f'bundle saves ${m_save} monthly')
    check(items['BNDL'].get('contains') == ['RCP', 'WEB'], 'BNDL contains RCP + WEB')

    # 4. semantics
    for it in pb['items']:
        if it['kind'] == 'fixed':
            check(isinstance(it['setup_cents'], int) and isinstance(it['monthly_cents'], int), f'{it["code"]}: fixed item has setup and monthly')
        if it['group'] == 'core':
            check(len(it['includes']) > 0 and len(it['excludes']) > 0, f'{it["code"]}: core offer has includes and excludes')
        for a in it['applies_to']:
            check(a == 'any' or a in R['core_codes'], f'{it["code"]}: applies_to {a} is a core code or any')
    ints, meta = pb['integrations'], pb['integration_meta']
    check(set(ints) == set(meta), 'integrations and integration_meta have the same keys')
    for k, v in ints.items():
        if v.startswith('addon:'):
            check(v[6:] in items, f'integration {k}: {v} refers to an existing code')
    labels = [m['label'] for m in meta.values()]
    for t in SPEC_TOOLS:
        check(t in labels, f'tool list has {t!r}')
    check(ints.get('servicetitan') == 'custom', 'ServiceTitan maps to custom (needs_manual_price)')
    check(all(ints[k] == 'custom' for k in ('dentrix', 'open_dental')), 'Dentrix/Open Dental map to custom')

    # 5. law firms removed entirely (Addendum); dental hidden
    niches = {n['key'] for n in brand['niches']}
    check(niches == NICHES, f'brand niches = {sorted(NICHES)}')
    used = {n for m in meta.values() for n in m['niches'] if n != '*'}
    check(used <= NICHES, 'integration niches are known niches')
    dental = next(n for n in brand['niches'] if n['key'] == 'dental')
    check(dental['index'] is False and dental['cta'] == 'early_access', 'dental is noindex + early access')
    hits = [w for w in REMOVED.findall(json.dumps(pb)) if w]
    check(not hits, 'no law-firm niche, tool or copy in pricebook.json' + (f': {hits}' if hits else ''))
    check(not REMOVED.search(json.dumps(brand['niches'])), 'no law niche in brand.json')
    if re.search(r'Clio', md):
        print('note  PRICEBOOK.md still lists "Clio or other legal practice systems" under Custom; omitted from JSON per the Addendum')

    # 6. brand basics
    for k in ('name', 'domain', 'site_url', 'support_email', 'senders', 'claude'):
        check(bool(brand.get(k)), f'brand.json has {k}')
    check(brand['claude']['model'] == 'claude-opus-5-5', 'claude.model is claude-opus-5-5')
    check(brand['claude']['effort'] == {'voice': 'low', 'sms': 'low', 'quote': 'medium'}, 'claude efforts voice/sms low, quote medium')
    check('Not affiliated with Anthropic' in brand['disclaimers']['footer'], 'footer disclaimer present')
    check('Claude' not in brand['name'] + brand['domain'], 'no "Claude" in brand name or domain')

    print(f'\npricebook_test: {len(failures)} failure(s)')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
