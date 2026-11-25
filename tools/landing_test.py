"""Landing reviews rule test. Stdlib only.

The "What clients say" section renders only with >= 2 approved reviews (consent: true) in site/_content/reviews.json;
no empty "your review here" placeholders, ever. The "What a call sounds like" Sample strip was removed on 2026-11-25
(owner: too much text; it repeated the interactive demo), so it must not come back by accident.

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
    # The home page (/) is the AI Lab Pro house page since 2026-11-23 (no reviews); the full page with reviews is /home-services/.
    for rel in ('home-services/index.html', 'real-estate/index.html'):
        h = pages[rel]
        check(f'{label}: {rel} no Sample-call strip (removed 2026-11-25)', 'id="sample-calls"' not in h and 'rv--sample' not in h)
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
    check(f'{rel}: no plan B wording ($0 setup, 12-month minimum)', not re.search(r'\$0 setup|12-month (plan|minimum)', vis, re.I))
    blocks = ''.join(re.findall(r'<(?:table|div) class="[^"]*"[^>]*data-coming-soon.*?</(?:table|div)>', vis, flags=re.S))
    outside = vis
    for blk in re.findall(r'<(?:table|div) class="[^"]*"[^>]*data-coming-soon.*?</(?:table|div)>', vis, flags=re.S):
        outside = outside.replace(blk, '')
    for i in soon:
        name = bl.esc(i['name'])
        if name in vis:
            check(f'{rel}: {i["code"]} shown only inside a coming-soon block', name in blocks and name not in outside)
    check(f'{rel}: no quote link for a coming-soon code', not any(f'offer={i["code"]}' in vis for i in soon))

# House brand (2026-11-23): / is the AI Lab Pro home, /firstring/ the FirstRing product page with the purchase path.
house, fr = pages['index.html'], pages['firstring/index.html']
vis = lambda h: re.sub(r'<[^>]+>', ' ', re.sub(r'<(script|style)\b.*?</\1>', '', h, flags=re.S))
ctx = bl.Ctx()
check('/firstring/ title carries "AI Receptionist for Small Businesses"', 'AI Receptionist for Small Businesses' in re.search(r'<title>(.*?)</title>', fr).group(1))
check('/ still says "AI receptionist for small businesses"', 'ai receptionist for small businesses' in vis(house).lower())
check('/ hero button leads to /firstring/', re.search(r'<section class="hero hero--house">.*?class="btn btn--primary" href="/firstring/"', house, re.S) is not None)
check('/firstring/ plan buttons keep the home-services niche', 'href="/start/?plan=FR_PRO&amp;niche=home_services" data-ev="trial_start" data-plan="FR_PRO"' in fr)
check('/firstring/ keeps the demo widget', 'data-demo-data' in fr)
_hero = re.search(r'<section class="hero hero--house">.*?</section>', house, re.S).group(0)
check('/ yellow FirstRing tile: "From $149/mo" + "Start free trial" to the plans on the page',
      re.search(r'<article class="t t--sun feat.*?From <b class="num">' + re.escape(ctx.tokens['from_price']) + r'</b>/mo.*?href="#pricing">Start free trial</a>', _hero, re.S) is not None)
check('/ above the fold: "Meet FirstRing" button only once', _hero.count('>Meet FirstRing</a>') == 1)
check('/ and /firstring/ in the sitemap', all(f'{ctx.site_url}{p}</loc>' in pages['sitemap.xml'] for p in ('/', '/firstring/')))
for rel, h in (('index.html', house), ('firstring/index.html', fr)):
    v = vis(h)
    check(f'{rel}: no client names', not re.search(r'Samsung|Haier', v))
    check(f'{rel}: no live-texting claim', not re.search(r'text-back|texts? (you|the caller) back|SMS', v, re.I))
    check(f'{rel}: no em dash in page copy outside the demo disclaimer', '—' not in v.replace(ctx.brand['disclaimers']['demo'], ''))

# Shorter pages (2026-11-25, owner: "too much text"): details live in closed folds, never deleted. Each fold is a native
# <details> (closed in the HTML) with a heading and a gist; the ids that links point to still exist; FAQ markup intact.
for rel, ids in (('home-services/index.html', ('how-it-answers', 'after-you-pay', 'included', 'tools', 'trust', 'demo', 'pricing', 'faq', 'how')),
                 ('real-estate/index.html', ('how-it-answers', 'after-you-pay', 'included', 'tools', 'trust', 'demo', 'pricing', 'faq', 'how')),
                 ('website/index.html', ('included', 'extras', 'trust', 'pages', 'pricing', 'bundle', 'faq', 'how'))):
    h = pages[rel]
    for i in ids:
        check(f'{rel}: id="{i}" exists', f'id="{i}"' in h)
    folds = re.findall(r'<details class="fold[^"]*"[^>]*>', h)
    check(f'{rel}: folds present and closed in the HTML ({len(folds)})', len(folds) >= 2 and not any(' open' in f for f in folds))
    check(f'{rel}: every fold has a heading and a gist', h.count('<details class="fold') == h.count('class="fold__t"') == h.count('class="fold__gist"'))
    v = vis(h)
    check(f'{rel}: Built with Claude / not affiliated disclosure on the page', 'not affiliated with Anthropic' in v)
    check(f'{rel}: no em dash in page copy outside the demo disclaimer', '—' not in v.replace(ctx.brand['disclaimers']['demo'], ''))
    ld = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', h, re.S).group(1))
    faq = next(x for x in ld['@graph'] if x['@type'] == 'FAQPage')
    check(f'{rel}: FAQPage JSON-LD matches the visible FAQ ({len(faq["mainEntity"])})', all(bl.esc(q['name']) in h for q in faq['mainEntity']))
for rel in ('home-services/index.html', 'real-estate/index.html'):
    h = pages[rel]
    check(f'{rel}: texting mentioned with the coming-soon note', 'coming soon, after US carrier registration' in h)
check('/real-estate/: never says "receptionist"', 'receptionist' not in vis(pages['real-estate/index.html']).lower())

# FirstRing monthly plans (owner decision 2026-11-25): three packages from the price book on every FirstRing page, Pro
# highlighted, one "Start free trial" button per package to /start/?plan=<CODE> with the trial_start event, the trial/cancel
# line and the refund-policy link under them; no setup-fee, deposit, quote or founding wording; JSON-LD offers = plans.
plans = pb['plans']
sub_ = pb['rules']['subscription']
check('brand.json analytics declares the trial_start event', 'trial_start' in ctx.brand['analytics']['events'])
NICHE_OF = {'index.html': None, 'firstring/index.html': 'home_services', 'home-services/index.html': 'home_services', 'real-estate/index.html': 'real_estate'}
for rel, niche in NICHE_OF.items():
    h = pages[rel]
    blk = re.search(r'<section class="section" id="pricing">.*?</section>', h, re.S)
    check(f'{rel}: pricing block present', blk is not None)
    if not blk:
        continue
    b = blk.group(0)
    cards = re.findall(r'<li class="plan( plan--pop)?" id="plan-[a-z-]+">(.*?</a>)\n</li>', b, re.S)
    check(f'{rel}: exactly three plan cards ({len(cards)})', len(cards) == len(plans) == 3)
    for (pop, body), p in zip(cards, plans):
        check(f'{rel}: {p["code"]} card shows {p["name"]} at {bl.money(p["monthly_cents"])}/mo with {p["included_usage"]["voice_minutes"]:,} minutes',
              f'>{p["name"]}</h3>' in body and f'<b class="num">{bl.money(p["monthly_cents"])}</b><span>/mo</span>' in body
              and f'<b class="num">{p["included_usage"]["voice_minutes"]:,}</b> voice minutes a month' in body)
        href = '/start/?plan=' + p['code'] + ('&amp;niche=' + niche if niche and rel != 'index.html' else '')
        check(f'{rel}: {p["code"]} button "Start free trial" -> {href} (trial_start)',
              f'href="{href}" data-ev="trial_start" data-plan="{p["code"]}">Start free trial</a>' in body)
        check(f'{rel}: {p["code"]} highlighted only if it has the badge', bool(pop) == bool(p.get('badge')) and (p.get('badge', '') in body))
        days = p['go_live_business_days']
        check(f'{rel}: {p["code"]} go-live line', f'Live in {days} business day' in body)
    check(f'{rel}: Pro is the highlighted plan', re.search(r'<li class="plan plan--pop" id="plan-fr-pro">', b) is not None)
    check(f'{rel}: trial + cancel line under the plans', bl.esc(sub_['texts']['trial']) in b and bl.esc(sub_['texts']['cancel']) in b
          and f'{sub_["trial_days"]}-day free trial</li><li>Cancel anytime</li>' in b)
    check(f'{rel}: refund policy linked next to the pricing', 'href="/legal/refund/">Refund policy</a>' in b)
    pf = pb['plan_features']
    if niche == 'real_estate':
        check(f'{rel}: no on-call dispatch on the real-estate plans', bl.esc(pf['dispatch']['label']) not in b
              and bl.esc(pf['second_line']['label_by_niche']['real_estate']) in b and 'Follow Up Boss' in b)
    else:
        check(f'{rel}: Business plan lists on-call dispatch', bl.esc(pf['dispatch']['label']) in b)
    ld = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', h, re.S).group(1))
    offers = [o for x in ld['@graph'] if x.get('@type') == 'Service' for o in x.get('offers', [])]
    check(f'{rel}: JSON-LD offers = the three monthly plans', sorted(float(o['price']) for o in offers) == sorted(p['monthly_cents'] / 100 for p in plans)
          and all(o['priceSpecification']['referenceQuantity']['unitCode'] == 'MON' for o in offers))
for rel in ('index.html', 'firstring/index.html', 'home-services/index.html', 'real-estate/index.html', 'demo/index.html'):
    v = vis(pages[rel])
    bad = re.findall(r'(?i)deposit|fixed quote|written quote|custom quote|see my price|founding|10 business days|\$[\d,]+ setup|setup fee(?<!no setup fee)'
                     r'|receptionist \+ website|bundle', re.sub(r'(?i)no setup fee', '', v))
    check(f'{rel}: no setup-fee / deposit / quote / bundle / founding wording {sorted(set(bad)) if bad else ""}', not bad)
    check(f'{rel}: no retired setup price on the page', not any(bl.money(i['setup_cents']) in v for i in pb['items'] if i['code'] in ('RCP', 'BNDL')))
    check(f'{rel}: no add-on prices for FirstRing', not any(f'{bl.money(i["setup_cents"])} + {bl.money(i["monthly_cents"])}/mo' in v
                                                          for i in pb['items'] if i.get('retired') and i.get('setup_cents')))
    check(f'{rel}: "From {ctx.tokens["from_price"]}/mo" price line', f'From {ctx.tokens["from_price"]} /mo' in re.sub(r'\s+', ' ', v) or
          f'From {ctx.tokens["from_price"]}/mo' in re.sub(r'\s+', ' ', v))
    check(f'{rel}: footer links the Refund Policy', 'href="/legal/refund/">Refund Policy</a>' in pages[rel])
check('/real-estate/: product name "FirstRing AI Lead Assistant" on the pricing block', 'Pricing · FirstRing AI Lead Assistant' in pages['real-estate/index.html'])
check('/demo/ buttons lead to the plans (no offer=RCP link)', 'offer=RCP' not in pages['demo/index.html'] and '/firstring/#pricing' in pages['demo/index.html'])
web = pages['website/index.html']
check('/website/: WEB price card kept, bundle card replaced by "Add FirstRing from ..."', 'offer=WEB' in web and 'offer=BNDL' not in web
      and f'Add FirstRing from {ctx.tokens["from_price"]}/mo' in web and 'href="/firstring/#pricing"' in web)
check('/ home page has a contact email (mailto) for the payment provider review', f'href="mailto:{ctx.brand["support_email"]}"' in house)

# Refund Policy page (2026-11-25): exists, stamped from the price book, linked from the other legal pages
rp = os.path.join(bl.SITE, 'legal', 'refund', 'index.html')
check('legal/refund/index.html exists', os.path.exists(rp))
if os.path.exists(rp):
    r = open(rp, encoding='utf-8').read()
    check('refund page: money-back guarantee text from the price book', bl.esc(pb['refund_rules']['subscription']['legal']) in r)
    check('refund page: free trial days from the price book', f'data-cfg="pricebook:rules.subscription.trial_days">{sub_["trial_days"]}<' in r)
    check('refund page: contact email', ctx.brand['support_email'] in r)
    for lp in ('terms', 'privacy', 'service-agreement'):
        check(f'legal/{lp}: links the Refund Policy', 'href="../refund/">Refund Policy</a>' in open(os.path.join(bl.SITE, 'legal', lp, 'index.html'), encoding='utf-8').read())
check('build_landing stamps the refund page', 'legal/refund/index.html' in bl.LEGAL_PAGES)

print(f'landing_test: {len(failures)} failed')
sys.exit(1 if failures else 0)
