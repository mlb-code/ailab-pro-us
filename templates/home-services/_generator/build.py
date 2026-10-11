#!/usr/bin/env python3
"""Home-services client website generator (US, English, LTR). Stdlib only.

usage:
  python3 build.py [--content FILE] [--brand FILE] [--og] [OUT_DIR]
  python3 build.py --template OUT_DIR          same site with {{PLACEHOLDER}} values (demo off, noindex on)

  --content  client content file (default: ../demo/content.json = fictional demo business)
  --brand    agency brand.json for the optional "Powered by" line (default: <repo>/config/brand.json)
  --og       also render assets/og.png (1200x630) with headless Chrome via <repo>/tools/cdp-shots.mjs and
             save it next to the content file as og.png (later builds copy it from there, no Chrome needed)
  OUT_DIR    default: <repo>/site/demo-site/home-services

Writes 5 pages (/, services/, about/, reviews/, contact/), assets/{style.css,main.js,favicon.svg,og.png},
sitemap.xml and robots.txt. Output is deterministic: same inputs → byte-identical files.
"""
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.dirname(HERE)                       # templates/home-services
REPO = os.path.dirname(os.path.dirname(TPL))      # repo root (when run inside the repo)
sys.path.insert(0, HERE)
import art  # noqa: E402

FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap'
DEFAULT_COLORS = {          # recolor: put any of these keys in content.json "colors"
    'paper': '#FBF5EA', 'paper2': '#F2E7D3', 'ink': '#1D1B18', 'ink2': '#4D463C',
    'hot': '#AE3A0B', 'hot_soft': '#FBD3B8', 'cool': '#0B5F80', 'cool_soft': '#CDE8F3',
}
PLACEHOLDERS = {            # --template: business field → placeholder (README §4 lists every one)
    'name': 'BUSINESS_NAME', 'short_name': 'SHORT_NAME', 'tagline': 'TAGLINE', 'owner': 'OWNER_NAME',
    'owner_title': 'OWNER_TITLE', 'founded': 'FOUNDED_YEAR', 'city': 'CITY', 'state': 'STATE',
    'phone': 'PHONE', 'phone_e164': 'PHONE_E164', 'sms_e164': 'SMS_E164', 'email': 'EMAIL',
    'site_url': 'SITE_URL', 'gbp_url': 'GBP_URL', 'reviews_url': 'REVIEWS_URL', 'ld_description': 'LD_DESCRIPTION',
    'insurance': 'INSURANCE_TEXT', 'leads_url': 'LEADS_URL', 'street': 'STREET', 'zip': 'ZIP',
}
DAY = {'Mo': 'Monday', 'Tu': 'Tuesday', 'We': 'Wednesday', 'Th': 'Thursday', 'Fr': 'Friday', 'Sa': 'Saturday', 'Su': 'Sunday'}
DAY3 = {'Mo': 'Mon', 'Tu': 'Tue', 'We': 'Wed', 'Th': 'Thu', 'Fr': 'Fri', 'Sa': 'Sat', 'Su': 'Sun'}
TRADES = {  # key in content.json "trades" → phrase used in default copy/meta
    'hvac': 'HVAC', 'plumbing': 'plumbing', 'electrical': 'electrical', 'roofing': 'roofing',
    'handyman': 'handyman', 'landscaping': 'landscaping', 'pest': 'pest control', 'garage': 'garage door',
    'appliance': 'appliance repair', 'cleaning': 'cleaning', 'painting': 'painting', 'pool': 'pool service',
}
STATE_NAMES = {'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado',
    'CT': 'Connecticut', 'DE': 'Delaware', 'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii',
    'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana',
    'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
    'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey',
    'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
    'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota',
    'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
    'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'}
NAV = [('', 'Home'), ('services/', 'Services'), ('about/', 'About'), ('reviews/', 'Reviews & FAQ'), ('contact/', 'Contact')]


def e(s):
    return html.escape(str(s), quote=True)


def em(s):
    """'Plain *highlight*' → escaped text with <em> for the starred part."""
    return re.sub(r'\*(.+?)\*', r'<em>\1</em>', e(s))


def arg(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 >= len(sys.argv):
            sys.exit(f'{flag} needs a value')
        return sys.argv[i + 1]
    return default


def positional():
    skip, out = False, []
    for a in sys.argv[1:]:
        if skip:
            skip = False
            continue
        if a in ('--content', '--brand', '--template'):
            skip = True
            continue
        if a.startswith('--'):
            continue
        out.append(a)
    return out


# ------------------------------------------------------------------ inputs
TEMPLATE_OUT = arg('--template')
CONTENT_PATH = os.path.abspath(arg('--content', os.path.join(TPL, 'demo', 'content.json')))
BRAND_PATH = arg('--brand', os.path.join(REPO, 'config', 'brand.json'))
pos = positional()
OUT = os.path.abspath(TEMPLATE_OUT or (pos[0] if pos else os.path.join(REPO, 'site', 'demo-site', 'home-services')))

C = json.load(open(CONTENT_PATH, encoding='utf-8'))
F = C['flags']
B = C['business']
BRAND = json.load(open(BRAND_PATH, encoding='utf-8')) if BRAND_PATH and os.path.exists(BRAND_PATH) else None
COL = dict(DEFAULT_COLORS, **C.get('colors', {}))

if TEMPLATE_OUT:
    F = dict(F, demo=False, noindex=True)
    # 1) free text: demo names/places inside any string become placeholders
    swap = [(B['name'], '{{BUSINESS_NAME}}'), (B.get('owner', ''), '{{OWNER_NAME}}'),
            (STATE_NAMES.get(B['state'], '#'), '{{STATE_NAME}}'), (', ' + B['state'], ', {{STATE}}'),
            (' (Sample terms for this demo.)', ''), (' (sample terms)', '')]
    for i, c in enumerate(B.get('service_area', {}).get('cities', [])):
        swap.append((c, '{{CITY}}' if c == B['city'] else '{{AREA_CITY_%d}}' % (i + 1)))
    if B.get('short_name'):
        swap.append((B['short_name'], '{{SHORT_NAME}}'))
    swap = sorted([x for x in swap if x[0]], key=lambda x: -len(x[0]))

    def deep(v):
        if isinstance(v, str):
            for a, b in swap:
                v = v.replace(a, b)
            return v
        if isinstance(v, list):
            return [deep(x) for x in v]
        if isinstance(v, dict):
            return {k: deep(x) for k, x in v.items()}
        return v
    C = deep({k: v for k, v in C.items() if k != 'flags'})
    B = C['business']
    # 2) lists that are always client-specific → numbered placeholders; copy/seo fall back to defaults
    C['copy'], C['seo'] = {}, {}
    B['service_area'] = {'cities': ['{{CITY}}'] + ['{{AREA_CITY_%d}}' % n for n in (2, 3, 4)],
                         'zips': ['{{ZIP_%d}}' % n for n in (1, 2, 3, 4)]}
    C['reviews'] = [{'text': '{{REVIEW_%d_TEXT}}' % n, 'name': '{{REVIEW_%d_NAME}}' % n,
                     'place': '{{REVIEW_%d_PLACE}}' % n, 'stars': 5} for n in (1, 2, 3)]
    C['about']['story'] = ['{{ABOUT_STORY_%d}}' % n for n in (1, 2, 3)]
    C['about']['team'] = [['{{TEAM_%d_NAME}}' % n, '{{TEAM_%d_ROLE}}' % n] for n in (1, 2, 3)]
    for svc in C['services']:
        svc['note'] = ''
    for k, ph in PLACEHOLDERS.items():
        if k in B:
            B[k] = '{{' + ph + '}}'
    for i, lic in enumerate(B['licenses']):
        lic['number'], lic['label'], lic['sample'] = '{{LICENSE_%d}}' % (i + 1), '{{LICENSE_%d_LABEL}}' % (i + 1), False

DEMO = bool(F.get('demo'))
NOINDEX = bool(F.get('noindex'))
site = B['site_url']
if site.startswith('@brand'):
    if not BRAND:
        sys.exit('site_url uses @brand but no brand.json was found (pass --brand)')
    site = BRAND['site_url'].rstrip('/') + site[len('@brand'):]
BASE = site if site.endswith('/') or site.endswith('}}') else site + '/'
POWERED = None
if F.get('powered_by') and BRAND:
    POWERED = (BRAND['name'], BRAND['site_url'].rstrip('/') + '/website/')
elif F.get('powered_by'):
    print('note: powered_by is on but brand.json was not found; footer line skipped')

NAME, SHORT, CITY, ST = B['name'], B.get('short_name') or B['name'], B['city'], B['state']
PHONE, TEL, SMS = B['phone'], B['phone_e164'], B.get('sms_e164') or B['phone_e164']
SMS_HREF = f'sms:{SMS}?&amp;body=' + e(B.get('sms_body', '').replace(' ', '%20'))
INITIALS = ''.join(w[0] for w in re.findall(r'[A-Za-z]+', NAME)[:2]) or 'HS'
if TEMPLATE_OUT:
    INITIALS = 'HS'
SERV = C['services']
if not DEMO and not TEMPLATE_OUT and not B.get('leads_url') and '--allow-no-leads' not in sys.argv:
    sys.exit('ERROR: demo=false but business.leads_url is empty: the contact form would lose every lead.\n'
             '       Deploy leads/Code.gs (README section 8) and set leads_url, or pass --allow-no-leads for a draft\n'
             '       (the form then shows the "call or text us" failure message instead of a fake success).')
STATE_NAME = '{{STATE_NAME}}' if TEMPLATE_OUT else STATE_NAMES.get(ST, ST)
_tr = [TRADES.get(t, t) for t in C.get('trades', ['hvac', 'plumbing'])]
TRADE = ' and '.join([', '.join(_tr[:-1]), _tr[-1]] if len(_tr) > 1 else _tr)
TOK = {'name': NAME, 'city': CITY, 'state': ST, 'state_name': STATE_NAME, 'phone': PHONE, 'trade': TRADE,
       'founded': B.get('founded', ''), 'tagline': B['tagline']}


def fill(t):
    """Replace {city}-style tokens (lowercase only, so {{PLACEHOLDERS}} stay untouched)."""
    return re.sub(r'(?<!\{)\{([a-z_]+)\}(?!\})', lambda m: str(TOK.get(m.group(1), m.group(0))), t)


COPY_DEFAULTS = {   # every trade/state-specific sentence; override any key in content.json "copy"
    'trade_phrase': '{trade}',
    'services_h2': '{trade} for your home, one call.',
    'services_lead': 'Licensed {trade} for homes in {city} and nearby. Every job starts with a diagnosis and a written price.',
    'license_badge': '',   # empty → first license label with the state name shortened to its code
    'license_lookup': 'You can verify our licenses with the {state_name} licensing board.',
    'form_placeholder': "Tell us what's going on and when you'd like us there",
}
SEO_DEFAULTS = {
    'home_title': '{name} | {tagline} in {city}, {state}',
    'home_desc': '{name}: {trade} in {city}, {state}. Licensed and insured, upfront pricing. Call or text {phone}.',
    'services_desc': '{trade} services in {city}, {state}: what we fix, what is included, and when to call. Call or text {phone}.',
    'about_desc': 'Family-owned {trade} company in {city}, {state} since {founded}. Licensed, insured, upfront pricing.',
    'reviews_desc': 'Customer reviews and answers about pricing, emergency service, licenses, service area and financing for {name} in {city}, {state}.',
    'contact_desc': 'Request {trade} service in {city}, {state}. Call or text {phone}, or send the form. Service area ZIP codes and hours.',
}
CP = {k: fill(v) for k, v in dict(COPY_DEFAULTS, **C.get('copy', {})).items()}
SEO = {k: fill(v) for k, v in dict(SEO_DEFAULTS, **C.get('seo', {})).items()}
if not CP['license_badge'] and B['licenses']:
    CP['license_badge'] = B['licenses'][0]['label'].replace(STATE_NAME + ' ', ST + ' ')
CP['services_h2'] = CP['services_h2'][:1].upper() + CP['services_h2'][1:]
EMER = B.get('emergency', {})
FIN = B.get('financing', {})
AREA = B.get('service_area', {'cities': [CITY], 'zips': []})
LOGO = art.emblem(INITIALS)
AC = ' aria-current="page"'
SAMPLE_EM = ' <em class="demo-tag">sample</em>'
SAMPLE_REV = ' · <span class="demo-tag">sample review</span>'


def hours_rows():
    rows, open_days = [], set()
    for h in B['hours']:
        d = h['days']
        open_days.update(d)
        label = DAY3[d[0]] + ('–' + DAY3[d[-1]] if len(d) > 1 else '')
        rows.append((label, f"{fmt12(h['opens'])}–{fmt12(h['closes'])}"))
    closed = [d for d in DAY3 if d not in open_days]
    if closed:
        rows.append((', '.join(DAY3[d] for d in closed), 'Closed' + (' (emergency line open)' if EMER.get('enabled') else '')))
    return rows


def fmt12(t):
    h, m = map(int, t.split(':'))
    return f"{(h - 1) % 12 + 1}{':%02d' % m if m else ''} {'am' if h < 12 else 'pm'}"


def hours_html(cls='hours'):
    return f'<ul class="{cls}">' + ''.join(f'<li><span>{e(a)}</span><span>{e(b)}</span></li>' for a, b in hours_rows()) + '</ul>'


# ------------------------------------------------------------------ JSON-LD
def ld_business():
    addr = {'@type': 'PostalAddress', 'addressLocality': CITY, 'addressRegion': ST, 'addressCountry': 'US'}
    if F.get('show_street') and B.get('street'):
        addr['streetAddress'] = B['street']
    if F.get('show_street') and B.get('zip'):
        addr['postalCode'] = B['zip']
    ld = {
        '@context': 'https://schema.org',
        '@type': B.get('schema_types') or ['HVACBusiness', 'Plumber'],
        '@id': BASE + '#business',
        'name': NAME + (' (demo business)' if DEMO else ''),
        'description': ('Fictional business on a demo website. Name, phone, licenses and reviews are samples. '
                        if DEMO else '') + B['ld_description'],
        'url': BASE, 'telephone': TEL, 'image': BASE + 'assets/og.png', 'logo': BASE + 'assets/favicon.svg',
        'priceRange': B.get('price_range', '$$'), 'address': addr,
        'areaServed': [{'@type': 'City', 'name': c} for c in AREA.get('cities', [])],
        'openingHoursSpecification': [{'@type': 'OpeningHoursSpecification', 'dayOfWeek': [DAY[d] for d in h['days']],
                                       'opens': h['opens'], 'closes': h['closes']} for h in B['hours']],
        'hasOfferCatalog': {'@type': 'OfferCatalog', 'name': 'Services', 'itemListElement': [
            {'@type': 'Offer', 'itemOffered': {'@type': 'Service', 'name': s['name']}} for s in SERV]},
    }
    if B.get('email'):
        ld['email'] = B['email']
    if B.get('gbp_url'):
        ld['sameAs'] = [B['gbp_url']]
    return ld


# ------------------------------------------------------------------ page chrome
def head(title, desc, path, extra_ld=None):
    canon = BASE + path
    robots = 'noindex, nofollow' if NOINDEX else 'index, follow, max-image-preview:large'
    color_css = ':root{' + ''.join(f'--{k.replace("_", "-")}:{v};' for k, v in COL.items()) + '}'
    ga = ''
    if B.get('ga4_id') and not TEMPLATE_OUT:
        g = e(B['ga4_id'])
        ga = (f'<script async src="https://www.googletagmanager.com/gtag/js?id={g}"></script>'
              f"<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}gtag('js',new Date());gtag('config','{g}');</script>\n")
    lds = [ld_business()] + ([extra_ld] if extra_ld else [])
    ld = ''.join(f'<script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>\n' for x in lds)
    p = rel(path)
    return f'''<!doctype html>
<html lang="en" dir="ltr">
<head>
<!-- generated-by: tools/ convention · source: templates/home-services/_generator/build.py + content.json. Do not edit by hand. -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta name="robots" content="{robots}">
<link rel="canonical" href="{e(canon)}">
<meta name="theme-color" content="{COL['ink']}">
<meta property="og:type" content="website">
<meta property="og:locale" content="en_US">
<meta property="og:site_name" content="{e(NAME)}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{e(canon)}">
<meta property="og:image" content="{e(BASE)}assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="{e(NAME)}: {e(B['tagline'])} in {e(CITY)}, {e(ST)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{p}assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="{FONTS_CSS}">
<link rel="stylesheet" href="{FONTS_CSS}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="{FONTS_CSS}"></noscript>
<link rel="stylesheet" href="{p}assets/style.css">
<style>{color_css}</style>
{ga}{ld}</head>
'''


def rel(path):
    return '../' * path.count('/') or './'


def phone_btn(cls='btn btn-call', label=None):
    return f'<a class="{cls}" href="tel:{TEL}" data-act="call">{art.icon("phone")}<span>{e(label or PHONE)}</span></a>'


def text_btn(cls='btn btn-text', label='Text us'):
    return f'<a class="{cls}" href="{SMS_HREF}" data-act="text">{art.icon("text")}<span>{e(label)}</span></a>'


def header(path):
    p = rel(path)
    links = ''.join(f'<a href="{p}{h}"{AC if h == path else ""}>{t}</a>' for h, t in NAV)
    strip = ''
    if F.get('emergency_banner') and EMER.get('enabled'):
        strip = (f'<div class="emer-strip"><div class="wrap emer-in"><span class="pulse" aria-hidden="true"></span>'
                 f'<b>{e(EMER["short"])}</b><span class="emer-sep" aria-hidden="true">·</span>'
                 f'<a href="tel:{TEL}" data-act="call">Call {e(PHONE)}</a></div></div>')
    return f'''<body data-demo="{1 if DEMO else 0}" data-leads="{e(B.get('leads_url', ''))}">
<a class="skip" href="#main">Skip to content</a>
{strip}<header class="site-head">
  <div class="wrap head-in">
    <a class="brand" href="{p}">{LOGO}<span><b>{e(NAME)}</b><small>{e(B['tagline'])}</small></span></a>
    <nav class="nav" aria-label="Main">{links}</nav>
    <div class="head-cta">
      <span class="head-lbl">Call or text</span>
      <a class="head-phone" href="tel:{TEL}" data-act="call">{art.icon("phone")}<span>{e(PHONE)}</span></a>
    </div>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="mnav"><span class="sr-only">Menu</span><i aria-hidden="true"></i></button>
  </div>
  <nav class="mnav" id="mnav" aria-label="Mobile">
    <div class="wrap">{links}
      <div class="mnav-cta">{phone_btn()}{text_btn()}</div>
    </div>
  </nav>
</header>
'''


def badges_row(cls=''):
    items = [(art.icon('badge'), 'Licensed', CP['license_badge'] or 'Licensed techs'),
             (art.icon('shield'), 'Insured', B.get('insurance', 'Fully insured')),
             (art.icon('tag'), 'Upfront pricing', 'Written price before work'),
             (art.icon('clock'), EMER.get('short', 'On-time arrival') if EMER.get('enabled') else 'On-time arrival',
              'Real person answers' if EMER.get('enabled') else '2-hour arrival window')]
    return f'<ul class="badges {cls}">' + ''.join(f'<li>{i}<span><b>{e(t)}</b><small>{e(s)}</small></span></li>' for i, t, s in items) + '</ul>'


def license_list():
    return '<ul class="lic">' + ''.join(
        f'<li><span>{e(l["label"])}</span><b>#{e(l["number"])}</b>{SAMPLE_EM if l.get("sample") and DEMO else ""}</li>'
        for l in B['licenses']) + f'<li><span>Insurance</span><b>{e(B.get("insurance", ""))}</b></li></ul>'


def cta_band(p):
    return f'''<section class="cta-band">
  <div class="wrap cta-in">
    <div>
      <p class="eyebrow eyebrow-lt">Ready when you are</p>
      <h2 class="h2">Talk to a real person<br>in {e(CITY)} today.</h2>
      <p class="cta-lead">Call, text, or send the form. We answer during business hours{', and our emergency line is open 24/7' if EMER.get('enabled') else ''}.</p>
      <div class="btns">{phone_btn('btn btn-call btn-xl')}{text_btn('btn btn-ghost-lt')}<a class="btn btn-ghost-lt" href="{p}contact/">Request service</a></div>
    </div>
    <div class="cta-hours"><h3>Office hours</h3>{hours_html('hours hours-lt')}</div>
  </div>
</section>
'''


def footer(p):
    navl = ''.join(f'<li><a href="{p}{h}">{t}</a></li>' for h, t in NAV)
    lic = ''.join(f'<li>{e(l["label"])} #{e(l["number"])}{" (sample)" if l.get("sample") and DEMO else ""}</li>' for l in B['licenses'])
    demo_note = (' This is a demo website: the business, phone numbers, licenses and reviews are fictional samples.' if DEMO else '')
    powered = f' · <a href="{e(POWERED[1])}">Website by {e(POWERED[0])}</a>' if POWERED else ''
    badge = ''
    if DEMO and POWERED:
        badge = f'<a class="demo-badge" href="{e(POWERED[1])}"><span>Demo site by {e(POWERED[0])}</span><b>Get one for your business →</b></a>'
    bar = f'''<div class="actbar" role="group" aria-label="Quick contact">
  <a href="tel:{TEL}" data-act="call">{art.icon("phone")}<span>Call</span></a>
  <a href="{SMS_HREF}" data-act="text">{art.icon("text")}<span>Text</span></a>
  <a href="{p}contact/" class="hot">{art.icon("arrow")}<span>Get service</span></a>
</div>'''
    return f'''<footer class="site-foot">
  <div class="wrap foot-grid">
    <div class="foot-brand">
      <a class="brand brand-lt" href="{p}">{LOGO}<span><b>{e(NAME)}</b><small>{e(B['tagline'])}</small></span></a>
      <p>Serving {e(', '.join(AREA.get('cities', [CITY])[:5]))} and nearby areas.</p>
      <ul class="foot-lic">{lic}</ul>
    </div>
    <div><h2>Pages</h2><ul>{navl}</ul></div>
    <div><h2>Contact</h2><ul>
      <li><a href="tel:{TEL}" data-act="call">{e(PHONE)}</a></li>
      <li><a href="{SMS_HREF}" data-act="text">Text us</a></li>
      {f'<li><a href="mailto:{e(B["email"])}">{e(B["email"])}</a></li>' if B.get('email') else ''}
      <li>{e(B['street'] + ', ') if F.get('show_street') and B.get('street') else ''}{e(CITY)}, {e(ST)}</li></ul></div>
    <div><h2>Hours</h2>{hours_html('hours hours-foot')}</div>
  </div>
  <div class="wrap foot-legal">
    <span>© <span class="yr">2026</span> {e(NAME)}.{demo_note}</span>
    <span>Text messages: msg &amp; data rates may apply. Reply STOP to opt out.{powered}</span>
  </div>
</footer>
{bar}
{badge}
<script src="{p}assets/main.js" defer></script>
</body>
</html>
'''


PAGES = []


def page(path, title, desc, body, extra_ld=None):
    p = rel(path)
    doc = head(title, desc, path, extra_ld) + header(path) + '<main id="main">\n' + body.replace('{P}', p) + '</main>\n' + footer(p)
    fp = os.path.join(OUT, path, 'index.html')
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, 'w', encoding='utf-8') as fh:
        fh.write(doc)
    PAGES.append(path)
    print('wrote', os.path.relpath(fp, OUT))


def faq_html(items):
    return '<div class="faq">' + ''.join(
        f'<details><summary>{e(q)}</summary><div class="a"><p>{e(a)}</p></div></details>' for q, a in items) + '</div>'


def review_cards(items):
    out = ''
    for r in items:
        out += (f'<figure class="review">{art.STARS}<span class="sr-only">{r.get("stars", 5)} out of 5 stars</span>'
                f'<blockquote><p>{e(r["text"])}</p></blockquote>'
                f'<figcaption><b>{e(r["name"])}</b>, {e(r["place"])}{SAMPLE_REV if DEMO else ""}</figcaption></figure>')
    return out


def reviews_link():
    if B.get('reviews_url'):
        return f'<a class="link-arrow" href="{e(B["reviews_url"])}" rel="noopener" target="_blank">Read all reviews on Google</a>'
    return ''


def zip_chips():
    return '<ul class="chips">' + ''.join(f'<li>{e(z)}</li>' for z in AREA.get('zips', [])) + '</ul>'


def area_section(p):
    cities = AREA.get('cities', [CITY])
    return f'''<section class="sec" id="area">
  <div class="wrap area">
    <div>
      <p class="eyebrow">Service area</p>
      <h2 class="h2">Where we work</h2>
      <p class="lead">Based in {e(CITY)}, {e(ST)}. Our trucks cover {e(', '.join(cities[:-1]) + (' and ' + cities[-1] if len(cities) > 1 else cities[0]))}.</p>
      <h3 class="h-sm">ZIP codes we serve</h3>
      {zip_chips()}
      <p class="muted">Don't see your ZIP? <a href="{SMS_HREF}" data-act="text">Text it to us</a> and we'll tell you right away.</p>
    </div>
    <figure class="map-fig">{art.area_map(cities, CITY)}</figure>
  </div>
</section>
'''


def banner(kind, p):
    if kind == 'emer' and F.get('emergency_banner') and EMER.get('enabled'):
        return f'''<section class="banner banner-emer"><div class="wrap banner-in">
  <div class="banner-ic">{art.icon("clock")}</div>
  <div><h2 class="h3">{e(EMER['short'])}</h2><p>{e(EMER['text'])}</p></div>
  {phone_btn('btn btn-call')}
</div></section>
'''
    if kind == 'fin' and F.get('financing_banner') and FIN.get('enabled'):
        link = f'<a class="btn btn-outline" href="{e(FIN["link"])}" rel="noopener">See payment options</a>' if FIN.get('link') else f'<a class="btn btn-outline" href="{p}contact/">Ask about financing</a>'
        return f'''<section class="banner banner-fin"><div class="wrap banner-in">
  <div class="banner-ic">{art.icon("card")}</div>
  <div><h2 class="h3">{e(FIN['short'])}</h2><p>{e(FIN['text'])}</p></div>
  {link}
</div></section>
'''
    return ''


# ------------------------------------------------------------------ HOME
H = C['hero']
facts = ''.join(f'<li><b>{e(a)}</b><span>{e(b)}</span></li>' for a, b in H['facts'])
svc_cards = ''.join(f'''<li class="svc-card tone-{s['tone']}"><a href="{{P}}services/#{s['id']}">
  <span class="svc-ic">{art.icon(s['icon'])}</span><h3>{e(s['name'])}</h3><p>{e(s['short'])}</p><span class="more">Details {art.icon('arrow', 'ic ic-sm')}</span></a></li>''' for s in SERV)
steps = ''.join(f'<li><span class="step-n">{i + 1}</span><h3>{e(a)}</h3><p>{e(b)}</p></li>' for i, (a, b) in enumerate(C['steps']))

home = f'''<section class="hero">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <p class="eyebrow">{e(H['eyebrow'])}</p>
      <h1 class="h1">{em(H['h1'])}</h1>
      <p class="lead">{e(H['lead'])}</p>
      <div class="btns">{phone_btn('btn btn-call btn-xl', 'Call ' + PHONE)}{text_btn()}</div>
      <p class="hero-alt"><a href="{{P}}contact/">Or request service online</a> · we reply within business hours</p>
      <ul class="facts">{facts}</ul>
    </div>
    <figure class="hero-art">{art.hero_house()}</figure>
  </div>
</section>
<section class="trust"><div class="wrap">{badges_row()}</div></section>
<section class="sec">
  <div class="wrap">
    <div class="sec-head"><p class="eyebrow">What we fix</p><h2 class="h2">{e(CP["services_h2"])}</h2></div>
    <ul class="svc-grid">{svc_cards}</ul>
  </div>
</section>
{banner('emer', '{P}')}<section class="sec sec-tint">
  <div class="wrap">
    <div class="sec-head"><p class="eyebrow">How it works</p><h2 class="h2">No surprises on the invoice.</h2></div>
    <ol class="steps">{steps}</ol>
  </div>
</section>
<section class="sec">
  <div class="wrap">
    <div class="sec-head sec-head-row"><div><p class="eyebrow">Reviews</p><h2 class="h2">What neighbors say</h2></div>{reviews_link()}</div>
    <div class="reviews">{review_cards(C['reviews'][:3])}</div>
  </div>
</section>
{area_section('{P}')}{banner('fin', '{P}')}<section class="sec">
  <div class="wrap narrow">
    <div class="sec-head"><p class="eyebrow">Questions</p><h2 class="h2">Before you call</h2></div>
    {faq_html(C['faq'][:3])}
    <p class="after"><a class="link-arrow" href="{{P}}reviews/#faq">All questions</a></p>
  </div>
</section>
''' + cta_band('{P}')

page('', SEO['home_title'], SEO['home_desc'], home)

# ------------------------------------------------------------------ SERVICES
det = ''
for i, s in enumerate(SERV):
    signs = ''.join(f'<li>{e(x)}</li>' for x in s['signs'])
    det += f'''<article class="svc-detail tone-{s['tone']}" id="{s['id']}">
  <div class="svc-side"><span class="svc-ic svc-ic-lg">{art.icon(s['icon'])}</span><span class="svc-n">{i + 1:02d}</span></div>
  <div>
    <h2 class="h3">{e(s['name'])}</h2>
    <p class="lead">{e(s['short'])}</p>
    <div class="two">
      <div><h3 class="h-sm">Call us when</h3><ul class="ticks">{signs}</ul></div>
      <div><h3 class="h-sm">What's included</h3><p>{e(s['includes'])}</p>{f'<p class="note">{e(s["note"])}</p>' if s.get('note') else ''}</div>
    </div>
    <div class="btns btns-sm">{phone_btn('btn btn-call btn-sm', 'Call')}{text_btn('btn btn-text btn-sm', 'Text')}</div>
  </div>
</article>
'''
services = f'''<section class="page-hero">
  <div class="wrap">
    <p class="crumbs"><a href="{{P}}">Home</a> / Services</p>
    <h1 class="h1">Services</h1>
    <p class="lead">{e(CP["services_lead"])}</p>
    <nav class="jump" aria-label="Services on this page">{''.join(f'<a href="#{s["id"]}">{e(s["name"])}</a>' for s in SERV)}</nav>
  </div>
</section>
<section class="sec sec-top0"><div class="wrap">{det}</div></section>
{banner('fin', '{P}')}''' + cta_band('{P}')
page('services/', f'Services | {NAME}, {CITY} {ST}',
     SEO['services_desc'],
     services)

# ------------------------------------------------------------------ ABOUT
A = C['about']
story = ''.join(f'<p>{e(x)}</p>' for x in A['story'])
team = ''.join(f'<li><span class="avatar" aria-hidden="true">{e("".join(w[0] for w in n.split()[:2]))}</span><span><b>{e(n)}</b><small>{e(r)}</small></span></li>' for n, r in A['team'])
values = ''.join(f'<li><h3>{e(a)}</h3><p>{e(b)}</p></li>' for a, b in A['values'])
about = f'''<section class="page-hero">
  <div class="wrap">
    <p class="crumbs"><a href="{{P}}">Home</a> / About</p>
    <h1 class="h1">{em(A['h1'])}</h1>
    <p class="lead">{e(NAME)} has served {e(CITY)}-area homes since {e(B['founded'])}.</p>
  </div>
</section>
<section class="sec sec-top0">
  <div class="wrap split">
    <div class="prose">{story}</div>
    <aside class="panel">
      <h2 class="h-sm">Licenses &amp; insurance</h2>
      {license_list()}
      <p class="muted small">{e(CP['license_lookup'])}{' The numbers on this demo are samples.' if DEMO else ''}</p>
    </aside>
  </div>
</section>
<section class="sec sec-tint">
  <div class="wrap">
    <div class="sec-head"><p class="eyebrow">The team</p><h2 class="h2">Who you'll talk to</h2></div>
    <ul class="team">{team}</ul>
  </div>
</section>
<section class="sec">
  <div class="wrap">
    <div class="sec-head"><p class="eyebrow">How we work</p><h2 class="h2">Three rules on every job</h2></div>
    <ul class="values">{values}</ul>
  </div>
</section>
<section class="trust"><div class="wrap">{badges_row()}</div></section>
''' + cta_band('{P}')
page('about/', f'About | {NAME}, {CITY} {ST}',
     SEO['about_desc'],
     about)

# ------------------------------------------------------------------ REVIEWS & FAQ
faq_ld = {'@context': 'https://schema.org', '@type': 'FAQPage',
          'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in C['faq']]}
gbp = f'<a class="btn btn-outline" href="{e(B["gbp_url"])}" rel="noopener" target="_blank">Leave us a Google review</a>' if B.get('gbp_url') else ''
revp = f'''<section class="page-hero">
  <div class="wrap">
    <p class="crumbs"><a href="{{P}}">Home</a> / Reviews &amp; FAQ</p>
    <h1 class="h1">Reviews &amp; <em>answers</em></h1>
    <p class="lead">What customers say, and answers to the questions we hear most.{' Reviews on this demo are samples written for illustration.' if DEMO else ''}</p>
  </div>
</section>
<section class="sec sec-top0">
  <div class="wrap">
    <div class="reviews reviews-all">{review_cards(C['reviews'])}</div>
    <p class="after">{reviews_link()} {gbp}</p>
  </div>
</section>
<section class="sec sec-tint" id="faq">
  <div class="wrap narrow">
    <div class="sec-head"><p class="eyebrow">FAQ</p><h2 class="h2">Frequently asked questions</h2></div>
    {faq_html(C['faq'])}
  </div>
</section>
''' + cta_band('{P}')
page('reviews/', f'Reviews & FAQ | {NAME}, {CITY} {ST}',
     SEO['reviews_desc'],
     revp, faq_ld)

# ------------------------------------------------------------------ CONTACT
FM = C['form']
opt = lambda xs: ''.join(f'<option>{e(x)}</option>' for x in xs)  # noqa: E731
radios = ''.join(f'<label class="pill"><input type="radio" name="contact_pref" value="{e(x)}"{" checked" if i == 0 else ""}><span>{e(x)}</span></label>' for i, x in enumerate(FM['contact_pref']))
contact = f'''<section class="page-hero">
  <div class="wrap">
    <p class="crumbs"><a href="{{P}}">Home</a> / Contact</p>
    <h1 class="h1">Get service</h1>
    <p class="lead">Fastest: call or text. Or send the form and we'll get back to you within business hours.</p>
    <div class="btns">{phone_btn('btn btn-call btn-xl')}{text_btn()}</div>
  </div>
</section>
<section class="sec sec-top0">
  <div class="wrap contact-grid">
    <form class="form" id="lead-form" novalidate>
      <h2 class="h3">Request service</h2>
      <div class="row2">
        <div class="field"><label for="f-name">Full name</label><input id="f-name" name="name" autocomplete="name" required data-err="Please enter your name" aria-describedby="f-name-err"><span class="err" id="f-name-err"></span></div>
        <div class="field"><label for="f-phone">Mobile phone</label><input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required data-err="Please enter a 10-digit phone number" aria-describedby="f-phone-err"><span class="err" id="f-phone-err"></span></div>
      </div>
      <div class="row2">
        <div class="field"><label for="f-zip">ZIP code</label><input id="f-zip" name="zip" inputmode="numeric" autocomplete="postal-code" maxlength="10" required data-err="Please enter a 5-digit ZIP code" aria-describedby="f-zip-err"><span class="err" id="f-zip-err"></span></div>
        <div class="field"><label for="f-email">Email <span class="opt">(optional)</span></label><input id="f-email" name="email" type="email" autocomplete="email"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="f-svc">What do you need?</label><select id="f-svc" name="service"><option value="">Choose a service</option>{opt([s['name'] for s in SERV] + FM['services_extra'])}</select></div>
        <div class="field"><label for="f-urg">How soon?</label><select id="f-urg" name="urgency">{opt(FM['urgency'])}</select></div>
      </div>
      <div class="field"><label for="f-msg">What's going on? <span class="opt">(optional)</span></label><textarea id="f-msg" name="message" rows="4" placeholder="{e(CP['form_placeholder'])}"></textarea></div>
      <fieldset class="field"><legend>Best way to reach you</legend><div class="pills">{radios}</div></fieldset>
      <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="field"><label class="check"><input id="f-ok" type="checkbox" name="consent" value="yes" required data-err="Please confirm so we can contact you" aria-describedby="f-ok-err"><span>I agree that {e(NAME)} may call or text me at this number about this request. Msg &amp; data rates may apply. Reply STOP to opt out.</span></label><span class="err" id="f-ok-err"></span></div>
      <button class="btn btn-call btn-block" type="submit">Send request</button>
      <div class="form-msg" id="form-msg" tabindex="-1" role="status"><b>Thanks, we got your request.</b> <span class="demo-only">This is a demo site, so nothing was sent. On a real site the request goes to the owner's email and Google Sheet.</span><span class="real-only">We'll be in touch within business hours. For emergencies, call {e(PHONE)}.</span></div>
      <div class="form-msg form-fail" id="form-fail" tabindex="-1" role="alert"><b>Sorry, that didn't go through.</b> Please call <a href="tel:{TEL}">{e(PHONE)}</a> or <a href="{SMS_HREF}">text us</a>.</div>
    </form>
    <aside>
      <div class="panel">
        <h2 class="h-sm">Contact</h2>
        <ul class="lines">
          <li><span>Phone</span><a href="tel:{TEL}" data-act="call">{e(PHONE)}</a></li>
          <li><span>Text</span><a href="{SMS_HREF}" data-act="text">{e(PHONE) if SMS == TEL else 'Text us'}</a></li>
          {f'<li><span>Email</span><a href="mailto:{e(B["email"])}">{e(B["email"])}</a></li>' if B.get('email') else ''}
          <li><span>Based in</span><span>{e(B['street'] + ', ') if F.get('show_street') and B.get('street') else ''}{e(CITY)}, {e(ST)}</span></li>
        </ul>
      </div>
      <div class="panel"><h2 class="h-sm">Office hours</h2>{hours_html()}{f'<p class="note">{e(EMER["short"])}: call {e(PHONE)}.</p>' if EMER.get('enabled') else ''}</div>
    </aside>
  </div>
</section>
{area_section('{P}')}'''
page('contact/', f'Contact | {NAME}, {CITY} {ST}',
     SEO['contact_desc'],
     contact)

# ------------------------------------------------------------------ assets, sitemap, robots
ad = os.path.join(OUT, 'assets')
os.makedirs(ad, exist_ok=True)
for f in ('style.css', 'main.js'):
    shutil.copyfile(os.path.join(TPL, 'assets', f), os.path.join(ad, f))
with open(os.path.join(ad, 'favicon.svg'), 'w', encoding='utf-8') as fh:
    fh.write(art.favicon(INITIALS, COL['hot'], COL['cool'], COL['ink']))

with open(os.path.join(OUT, 'sitemap.xml'), 'w', encoding='utf-8') as fh:
    fh.write('<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated-by: tools/ convention · templates/home-services/_generator/build.py -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
             + ''.join(f'  <url><loc>{e(BASE + pth)}</loc></url>\n' for pth in PAGES) + '</urlset>\n')
with open(os.path.join(OUT, 'robots.txt'), 'w', encoding='utf-8') as fh:
    if NOINDEX:
        fh.write('# Draft / demo: pages carry <meta name="robots" content="noindex">. Crawling stays allowed so the tag is seen.\nUser-agent: *\nAllow: /\n')
    else:
        fh.write(f'# generated-by: tools/ convention · templates/home-services/_generator/build.py\nUser-agent: *\nAllow: /\n\nSitemap: {BASE}sitemap.xml\n')

og_src = os.path.join(os.path.dirname(CONTENT_PATH), 'og.png')
if '--og' in sys.argv and not TEMPLATE_OUT:
    shots = os.path.join(REPO, 'tools', 'cdp-shots.mjs')
    line = ' · '.join(['Licensed & insured'] + ([EMER['short']] if EMER.get('enabled') else []))
    tmp = tempfile.mkdtemp()
    card = os.path.join(tmp, 'og.html')
    with open(card, 'w', encoding='utf-8') as fh:
        fh.write(art.og_html(NAME, B['tagline'], PHONE, line, f'{CITY}, {ST}', FONTS_CSS, COL, DEMO))
    subprocess.run(['node', shots, 'file://' + card, os.path.join(tmp, 'og'), '1200', '630', '0', os.environ.get('OG_PORT', '8977'), '[0]'], check=True)
    shutil.copyfile(os.path.join(tmp, 'og-00000.png'), og_src)
    shutil.rmtree(tmp)
    print('rendered', og_src)
if os.path.exists(og_src) and not TEMPLATE_OUT:
    shutil.copyfile(og_src, os.path.join(ad, 'og.png'))
else:
    print('note: no og.png next to the content file; run with --og once')
print('done:', OUT, '(demo)' if DEMO else '', '(noindex)' if NOINDEX else '(indexable)')
