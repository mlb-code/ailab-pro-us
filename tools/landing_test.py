"""Landing reviews rule test. Stdlib only.

The "What clients say" section renders only with >= 2 approved reviews (consent: true) in site/_content/reviews.json;
the "What a call sounds like" sample strip always renders; no empty "your review here" placeholders, ever.

usage: python3 tools/landing_test.py      exit 0 = all checks pass
"""
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_landing as bl  # noqa: E402

REVIEW = {'name': 'Pat Doe', 'business': 'Doe Heating', 'city': 'Austin, TX', 'text': 'Answers every call.',
          'source_url': 'https://example.com/review/1', 'date': '2026-11-01', 'consent': True, 'rating': 5}
failures = []


def page_with(reviews):
    c = bl.Ctx()
    orig = bl.load
    def patched(p):
        data = orig(p)
        if os.path.basename(p) == 'reviews.json':
            data = copy.deepcopy(data)
            data['reviews'] = reviews
        return data
    bl.load = patched
    try:
        pages, _ = bl.build(c)
    finally:
        bl.load = orig
    return pages


def check(name, cond):
    print(('ok    ' if cond else 'FAIL  ') + name)
    if not cond:
        failures.append(name)


r2 = [REVIEW, dict(REVIEW, name='Lee Roe', source_url='https://example.com/review/2')]
cases = [
    ('0 reviews', [], False),
    ('1 approved review', [REVIEW], False),
    ('2 reviews, one without consent', [REVIEW, dict(r2[1], consent=False)], False),
    ('2 approved reviews', r2, True),
]
for label, reviews, shown in cases:
    pages = page_with(reviews)
    # The home page (/) is the lighter version since 2026-10-29; the full page with reviews is /home-services/.
    for rel in ('home-services/index.html', 'real-estate/index.html'):
        h = pages[rel]
        check(f'{label}: {rel} sample strip present', 'id="sample-calls"' in h and 'rv--sample' in h)
        check(f'{label}: {rel} reviews section {"present" if shown else "absent"}', ('id="reviews"' in h) == shown)
        check(f'{label}: {rel} no review placeholders', 'Your review here' not in h and 'rv--open' not in h)
        if shown:
            check(f'{label}: {rel} both reviews rendered', 'Pat Doe' in h and 'Lee Roe' in h)

try:
    page_with([dict(REVIEW, text='')])
    check('consented review with a missing field stops the build', False)
except SystemExit:
    check('consented review with a missing field stops the build', True)

# Pricing v1.1 (owner decision 2026-10-25): plan B never renders while rules.plan_b_enabled is false, and every
# coming-soon item appears only inside a labelled coming-soon block, never with a buy/quote button.
import json, re  # noqa: E402
pb = json.load(open(os.path.join(bl.ROOT, 'config', 'pricebook.json'), encoding='utf-8'))
pages = page_with([])
check('plan B is off in the price book', pb['rules']['plan_b_enabled'] is False)
b_amounts = {bl.money(i['plan_b_monthly_cents']) for i in pb['items'] if i.get('plan_b_monthly_cents') and i['plan_b_monthly_cents'] != i['monthly_cents']}
a_amounts = {bl.money(i[k]) for i in pb['items'] for k in ('setup_cents', 'monthly_cents') if isinstance(i.get(k), int)}
b_only = sorted(b_amounts - a_amounts)
soon = [i for i in pb['items'] if i.get('availability') == 'coming_soon']
for rel, h in pages.items():
    if not rel.endswith('.html'):
        continue
    vis = re.sub(r'<(script|style)\b.*?</\1>', '', h, flags=re.S)
    hits = [x for x in b_only if re.search(re.escape(x) + r'(?![\d,])', vis)]
    check(f'{rel}: no plan B price on the page {hits if hits else ""}', not hits)
    check(f'{rel}: no "no setup fee" plan wording', not re.search(r'\$0 setup|no setup fee|12-month (plan|minimum)', vis, re.I))
    blocks = ''.join(re.findall(r'<(?:table|div) class="[^"]*"[^>]*data-coming-soon.*?</(?:table|div)>', vis, flags=re.S))
    outside = vis
    for blk in re.findall(r'<(?:table|div) class="[^"]*"[^>]*data-coming-soon.*?</(?:table|div)>', vis, flags=re.S):
        outside = outside.replace(blk, '')
    for i in soon:
        name = bl.esc(i['name'])
        if name in vis:
            check(f'{rel}: {i["code"]} shown only inside a coming-soon block', name in blocks and name not in outside)
    check(f'{rel}: no quote link for a coming-soon code', not any(f'offer={i["code"]}' in vis for i in soon))
home = pages['home-services/index.html']
check('home: SMS-free add-on ADD-DISPATCH is listed with its price', bl.esc(next(i['name'] for i in pb['items'] if i['code'] == 'ADD-DISPATCH')) in home
      and f'{bl.money(70000)} + {bl.money(7500)}/mo' in home)
check('home: coming-soon block present with the label', 'data-coming-soon' in home and pb['rules']['availability']['coming_soon_label'] in home)

print(f'landing_test: {len(failures)} failed')
sys.exit(1 if failures else 0)
