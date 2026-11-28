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
              'Follow Up Boss']
NICHES = {'home_services', 'real_estate'}  # offered niches (the DB enum keeps one retired value for old rows only)
RETIRED = re.compile(r'\bdent\w*', re.I)
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
            if 'Plan B monthly' in col:
                bk, bv = money(r[col['Plan B monthly']])
                check(it.get('plan_b_monthly_cents') == (bv if bk == 'fixed' else None),
                      f'{code}: plan_b_monthly_cents {it.get("plan_b_monthly_cents")} == table ({r[col["Plan B monthly"]]})')
            if 'Status' in col:
                check(it.get('availability') == r[col['Status']].replace(' ', '_'), f'{code}: availability {it.get("availability")!r} == table ({r[col["Status"]]})')
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
    check(G.get('bundle_refunds') == 'rcp_setup_part' and '`BNDL` we refund only the AI Receptionist part' in md and 'AI Receptionist part' in G['legal'],
          'guarantee: on BNDL only the RCP part of the setup fee is refunded (decision 2026-10-12)')
    for k in ('label', 'text', 'legal'):
        nums = {int(x) for x in re.findall(r'(\d+)[- ]day', G[k])}
        check(nums == {gd}, f'guarantee: {k} text uses {gd} days only ({sorted(nums)})')
    check('go-live' in G['text'] and 'go-live' in G['legal'], 'guarantee: window counted from go-live in client text')
    D = RR['deposit']
    check({int(x) for x in re.findall(r'(\d+)[- ]day', D['text'] + ' ' + D.get('label', ''))} == {D['window_days']}, 'refund: deposit text/label use window_days')
    check(R['discounts']['FOUNDING'].get('label') == 'Founding-client price' and '"Founding-client price"' in md, 'FOUNDING label = "Founding-client price"')
    check(bool(brand.get('quote_sla_text')) and 'Sunday–Thursday' in (brand.get('business_days_text') or ''), 'brand: quote_sla_text + business_days_text (Sunday–Thursday)')
    check(R['cancel_notice_days'] == num(r'(\d+) days notice', md), 'cancel notice days')
    check(R['liability_cap_months'] == num(r'fees paid in the (\d+) months before the event', md)
          and R['liability_cap_floor_usd'] == num(r'months before the event or \$([\d,]+)', md)
          and 'outside the cap' in md, 'liability cap: N months or $floor, refunds outside the cap (MD rule 9)')
    check(R['included_usage']['voice_minutes'] == num(r'(\d+) voice minutes \+', md), 'included voice minutes')
    check(R['included_usage']['sms_segments'] == num(r'voice minutes \+ ([\d,]+) SMS', md), 'included SMS segments')
    check(R['overage_markup_pct'] == 0 and 'No automatic overage billing' in md and R.get('overage_policy','').startswith('no_auto_billing'), 'overage: no automatic billing (alerts at 80/100, add-on with approval)')
    check(R['custom_triggers']['max_auto_locations'] == num(r'more than (\d+) locations', md), 'custom: > N locations')
    check(R['custom_triggers']['max_auto_voice_minutes_per_month'] == num(r'call volume > ([\d,]+) min/month', md), 'custom: call volume')
    s_save, m_save = num(r'Saves \$([\d,]+) setup', md), num(r'setup / \$([\d,]+) monthly', md)
    check(items['RCP']['setup_cents'] + items['WEB']['setup_cents'] - items['BNDL']['setup_cents'] == s_save * 100, f'bundle saves ${s_save} setup')
    check(items['RCP']['monthly_cents'] + items['WEB']['monthly_cents'] - items['BNDL']['monthly_cents'] == m_save * 100, f'bundle saves ${m_save} monthly')
    check(items['BNDL'].get('contains') == ['RCP', 'WEB'], 'BNDL contains RCP + WEB')

    # 3b. two ways to pay + availability (owner decision 2026-10-25)
    check(R.get('plan_b_enabled') is False, 'plan B is OFF (rules.plan_b_enabled = false) until the Tranzila USD terminal is confirmed')
    T = R.get('term_plan') or {}
    check(T.get('min_months') == 12 and T.get('setup_cents') == 0 and T.get('after_term') == 'monthly_a'
          and T.get('early_exit') == 'setup_remaining_share' and T.get('first_charge') == 'at_signing', 'term plan: 12 months, $0 setup, first charge at signing, drops to plan A, early exit = unpaid setup share')
    check(T.get('founding_applies') is False and T.get('channels') == ['site'] and R.get('upwork_plans') == ['A'], 'term plan: no FOUNDING, site only; Upwork = plan A only')
    prem = T.get('premium_pct')
    for it in pb['items']:
        b = it.get('plan_b_monthly_cents')
        recurring = it['group'] in ('core', 'addon') and it['kind'] == 'fixed' and (it['monthly_cents'] or 0) > 0
        check((b is not None) == recurring, f'{it["code"]}: plan B price present only on fixed items with a monthly fee')
        if b is not None:
            want = it['monthly_cents'] + round(it['setup_cents'] * (100 + prem) / 100 / 12 / 100) * 100
            check(b == want, f'{it["code"]}: plan B {b} == monthly + setup x {100 + prem}% / 12 = {want}')
    AP = R.get('annual_prepay') or {}
    check(AP.get('months_paid') == 10 and AP.get('months_covered') == 12 and AP.get('plan') == 'A'
          and '12 months of the monthly fee for the price of 10' in md, 'annual prepay: 12 months for the price of 10, plan A (Upwork)')
    AV = R.get('availability') or {}
    soon = {c for c, it in items.items() if it.get('availability') == 'coming_soon'}
    check(soon == {'ADD-LEAD', 'ADD-QUOTE', 'ADD-REV', 'BNDL-NM', 'BNDL-GROW'}, f'coming soon = the texting items and the bundles that contain them ({sorted(soon)})')
    check(not (soon & set(R['core_codes'])), 'no coming-soon item is a sellable core code')
    for c in soon:
        req = items[c].get('requires') or []
        check(bool(req) and all(k in AV.get('reasons', {}) for k in req), f'{c}: coming soon says why (requires -> rules.availability.reasons)')
    for it in pb['items']:
        if it['group'] in ('core', 'addon'):
            check(it.get('availability') in ('available', 'coming_soon'), f'{it["code"]}: availability set')
        for part in it.get('contains', []):
            check(part in items, f'{it["code"]}: contains existing code {part}')
            if items.get(part, {}).get('availability') == 'coming_soon':
                check(it.get('availability') == 'coming_soon', f'{it["code"]}: contains coming-soon {part} -> coming soon too')
    for code, parts in (('BNDL-NM', ['RCP', 'ADD-DISPATCH', 'ADD-LEAD']), ('BNDL-GROW', ['RCP', 'ADD-DISPATCH', 'ADD-LEAD', 'ADD-QUOTE', 'ADD-REV'])):
        it = items[code]
        check(it.get('contains') == parts, f'{code} contains {" + ".join(parts)}')
        check(it['setup_cents'] < sum(items[p]['setup_cents'] for p in parts) and it['monthly_cents'] < sum(items[p]['monthly_cents'] for p in parts),
              f'{code}: costs less than its parts')
    check('Appointment manager' in md and any(s.startswith('Appointment manager') for s in items['RCP']['includes']), 'appointment manager is part of RCP (no code, no fee)')

    # 3c. FirstRing monthly plans (owner decision 2026-11-25): 3 plans, no setup fee, 14-day trial (100 min), cancel anytime
    plans = {p['code']: p for p in pb.get('plans', [])}
    S = R.get('subscription') or {}
    check(list(plans) == ['FR_STARTER', 'FR_PRO', 'FR_BUSINESS'] == S.get('plan_codes'), 'plans: FR_STARTER, FR_PRO, FR_BUSINESS (rules.subscription.plan_codes)')
    rows = []
    lines = md.splitlines()
    for n, line in enumerate(lines):
        if line.startswith('| Plan code |'):
            k = n + 2
            while k < len(lines) and lines[k].startswith('|'):
                rows.append([x.strip() for x in lines[k].strip().strip('|').split('|')])
                k += 1
    check(len(rows) == len(plans), f'PRICEBOOK.md plan table has {len(rows)} rows')
    for r in rows:
        code = r[0].strip('`')
        p = plans.get(code)
        check(p is not None, f'{code}: plan present in pricebook.json')
        if not p:
            continue
        mk, mv = money(r[2])
        check(p['name'] == r[1] and p['monthly_cents'] == mv, f'{code}: name {r[1]!r} + monthly {r[2]} equal the table')
        check(p['included_usage']['voice_minutes'] == int(r[3].replace(',', '')), f'{code}: {r[3]} voice minutes')
        check(p['go_live_business_days'] == num(r'(\d+) business day', r[4]), f'{code}: go-live {r[4]}')
    want = {'FR_STARTER': 14900, 'FR_PRO': 24900, 'FR_BUSINESS': 39900}
    check({c: p['monthly_cents'] for c, p in plans.items()} == want, 'plans: $149 / $249 / $399 a month (approved 2026-11-25)')
    check([p['included_usage']['voice_minutes'] for p in plans.values()] == [200, 500, 1000], 'plans: 200 / 500 / 1,000 voice minutes')
    for c, p in plans.items():
        check(p['setup_cents'] == 0 and p['trial_days'] == S.get('trial_days') == 14 and p['trial_minutes'] == S.get('trial_minutes') == 100,
              f'{c}: no setup fee, 14-day trial capped at 100 minutes')
        check(all(f in pb.get('plan_features', {}) for f in p['features']), f'{c}: every feature key has a label in plan_features')
    pl = list(plans.values())
    for a, b in zip(pl, pl[1:]):
        check(set(a['features']) < set(b['features']) and a.get('upgrade_to') == b['code'], f'{b["code"]}: everything in {a["code"]} plus more; {a["code"]} upgrades to it')
    check(plans['FR_PRO'].get('badge') == 'Most popular' and not plans['FR_STARTER'].get('badge') and not plans['FR_BUSINESS'].get('badge'), 'plans: only Pro has the "Most popular" badge')
    check([p['go_live_business_days'] for p in pl] == [1, 1, 5], 'plans: live in 1 business day (Business: 5)')
    PF = pb.get('plan_features', {})
    check(PF.get('dispatch', {}).get('niches') == ['home_services'], 'plan feature dispatch: home services only (no on-call dispatch for real estate)')
    check(S.get('setup_cents') == 0 and S.get('first_charge') == 'trial_end' and S.get('trial_card_required') is True, 'subscription: card at sign-up, first charge when the trial ends')
    check(S.get('partial_month_refunds') is False and S.get('minutes_roll_over') is False and S.get('per_minute_billing') is False
          and S.get('usage_alert_pct') == [80, 100], 'subscription: no partial-month refunds, no roll-over, never per minute, alerts at 80/100')
    for f, meta in PF.items():
        if meta.get('replaces'):
            rc = meta['replaces']
            check(rc in items and bool((items[rc].get('retired') or {}).get('replaced_by')), f'plan feature {f}: replaces {rc}, which is marked retired')
    for code in ('RCP', 'BNDL', 'ADD-ES', 'ADD-CHAT', 'ADD-DISPATCH', 'ADD-LOC', 'ADD-CRM', 'ADD-USAGE'):
        check(code in items and bool(items[code].get('retired')) and code in S.get('retired_codes', []), f'{code}: kept for old quotes, retired for FirstRing')
    check(items['WEB'].get('retired') is None, 'WEB is not retired (website keeps setup + monthly)')
    RS = RR.get('subscription') or {}
    check(RS.get('codes') == list(plans) and RS.get('partial_months_refunded') is False, 'refund: subscription rule covers the three plans, no partial months')
    for k in ('label', 'text', 'legal'):
        nums = {int(x) for x in re.findall(r'(\d+)[- ]day', RS.get(k, ''))}
        check(nums <= {RS.get('money_back_days')}, f'refund: subscription {k} uses {RS.get("money_back_days")} days only ({sorted(nums)})')
    check(str(S.get('trial_days')) + '-day free trial' in S.get('texts', {}).get('trial', ''), 'subscription: trial text carries trial_days')
    check('Live in 1 business day' in md and '14-day free trial' in md, 'PRICEBOOK.md: trial + go-live rule written down')

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

    # 5. law firms removed entirely (Addendum); health-care practices not offered (owner decision 2026-10-12)
    niches = {n['key'] for n in brand['niches']}
    check(niches == NICHES, f'brand niches = {sorted(NICHES)}')
    used = {n for m in meta.values() for n in m['niches'] if n != '*'}
    check(used <= NICHES, 'integration niches are known niches')
    check(not RETIRED.search(json.dumps(pb) + json.dumps(brand)), 'no retired health-care niche or EHR tool in config')
    hits = [w for w in REMOVED.findall(json.dumps(pb)) if w]
    check(not hits, 'no law-firm niche, tool or copy in pricebook.json' + (f': {hits}' if hits else ''))
    check(not REMOVED.search(json.dumps(brand['niches'])), 'no law niche in brand.json')
    if re.search(r'Clio', md):
        print('note  PRICEBOOK.md still lists "Clio or other legal practice systems" under Custom; omitted from JSON per the Addendum')

    # 6. brand basics
    for k in ('name', 'domain', 'site_url', 'support_email', 'senders', 'claude'):
        check(bool(brand.get(k)), f'brand.json has {k}')
    check(brand['claude']['model'] == 'claude-opus-5-5', 'claude.model is claude-opus-5-5')
    check(brand['claude']['effort'] == {'voice': 'low', 'sms': 'low', 'quote': 'medium', 'setup': 'low'}, 'claude efforts voice/sms/setup low, quote medium')
    check(brand['claude'].get('setup_model') == 'claude-opus-5-5', 'claude.setup_model is claude-opus-5-5 (setup assistant, design 2026-11-27)')
    # owner decision 2026-11-28 (Meir): the switch may be on; the gate now only checks that it is an explicit true/false
    check(isinstance(brand.get('setup_agent', {}).get('enabled'), bool), 'setup_agent.enabled is an explicit true/false')
    check('Not affiliated with Anthropic' in brand['disclaimers']['footer'], 'footer disclaimer present')
    check('Claude' not in brand['name'] + brand['domain'], 'no "Claude" in brand name or domain')

    print(f'\npricebook_test: {len(failures)} failure(s)')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
