"""Build the public landing pages from config + content. Stdlib only. Never edit the generated HTML by hand.

Inputs : config/brand.json, config/pricebook.json, site/_content/{_shared,home,firstring,home-services,real-estate,website,reviews}.json
Outputs: site/index.html (AI Lab Pro house-brand home, home.json), site/firstring/ (FirstRing product page, firstring.json),
         site/home-services/, site/real-estate/, site/website/, site/demo/, site/sitemap.xml, site/robots.txt,
         site/assets/og/*.png (only with --og or when missing)

usage:
  python3 tools/build_landing.py            build (renders missing OG images with Playwright)
  python3 tools/build_landing.py --check    rebuild in memory; exit 1 if any generated text file differs (no writes)
  python3 tools/build_landing.py --og       force re-render of the OG images (needs `npm install`)
  python3 tools/build_landing.py --list     print the URLs of every generated page (used by tools/urls-landing.txt)

Every local <script src> / <link rel=stylesheet> gets ?v=<content hash> (tools/asset_version.py; a build also re-stamps
the hand-written pages). Legal pages (site/legal/*/index.html) are hand-written; their <span data-cfg="pricebook:path"> / "brand:path" values are
re-stamped from config on every build and verified by --check.

Content tokens ({brand}, {price:RCP.setup}, ...) are documented in site/_content/_shared.json. An unknown token
fails the build. Law firms are out of scope (owner decision 2026-10-11): there is no law page.
"""
import html
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asset_version  # noqa: E402  (?v=<content hash> on every local script / stylesheet)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
CONTENT = os.path.join(SITE, '_content')
MARK = 'generated-by: tools/build_landing.py (edit site/_content/*.json or config/*.json, then rebuild)'
NICHE_FILES = {'home_services': 'home-services.json', 'real_estate': 'real-estate.json'}
PUBLIC_DEMO_NICHES = ['home_services', 'real_estate']


def load(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


# ---------------------------------------------------------------- config + tokens
class Ctx:
    def __init__(self):
        self.brand = load(os.path.join(ROOT, 'config', 'brand.json'))
        self.pb = load(os.path.join(ROOT, 'config', 'pricebook.json'))
        self.shared = load(os.path.join(CONTENT, '_shared.json'))
        self.items = {i['code']: i for i in self.pb['items']}
        self.site_url = self.brand['site_url'].rstrip('/')
        rules = self.pb['rules']
        rr = self.pb.get('refund_rules', {})
        it = self.items
        fnd = rules.get('discounts', {}).get('FOUNDING', {})
        self.tokens = {
            'brand': self.brand['name'],
            'refund': rr.get('deposit', {}).get('text', ''),
            'usage_voice': f"{rules['included_usage']['voice_minutes']:,}",
            'usage_sms': f"{rules['included_usage']['sms_segments']:,}",
            'overage_pct': str(rules.get('overage_markup_pct', '')),
            'cancel_days': str(rules.get('cancel_notice_days', '')),
            'bundle_save_setup': money(it['RCP']['setup_cents'] + it['WEB']['setup_cents'] - it['BNDL']['setup_cents']),
            'bundle_save_monthly': money(it['RCP']['monthly_cents'] + it['WEB']['monthly_cents'] - it['BNDL']['monthly_cents']),
            'founding_max': str(fnd.get('max_clients', '')),
            'worked_with': '',
            'disclaimer': self.brand['disclaimers']['footer'],
            'country': self.brand.get('legal_entity', {}).get('country', ''),
        }
        dp = self.brand.get('demo') or {}  # demo phone line (answered by the runtime's demo tenant)
        self.tokens.update({'demo_phone': dp.get('phone_number', ''), 'demo_phone_business': dp.get('phone_business', ''),
                            'demo_phone_city': dp.get('phone_city', '')})
        for code, i in it.items():
            if i.get('delivery_business_days'):
                self.tokens[f'days:{code}'] = str(i['delivery_business_days'])
            for k in ('setup', 'monthly'):
                c = i.get(f'{k}_cents')
                if isinstance(c, int):
                    self.tokens[f'price:{code}.{k}'] = money(c)
            if isinstance(i.get('setup_cents'), int):
                self.tokens[f'price:{code}.deposit'] = money(deposit_cents(i['setup_cents'], rules))
                if fnd.get('setup_pct'):
                    self.tokens[f'price:{code}.founding'] = money(round(i['setup_cents'] * (100 - fnd['setup_pct']) / 100 / 100) * 100)
        g = rr.get('rcp_guarantee', {})
        glabel, gtext = g.get('label', ''), g.get('text', '')
        if gtext and not gtext.startswith(glabel + ': '):
            raise SystemExit('build_landing: refund_rules.rcp_guarantee.text must start with "<label>: "')
        gbody = gtext[len(glabel) + 2:] if gtext else ''
        self.tokens.update({
            'refund_label': rr.get('deposit', {}).get('label', ''),
            'guarantee': gtext,
            'guarantee_label': glabel,
            'guarantee_body': gbody[:1].upper() + gbody[1:],
            'guarantee_days': str(rr.get('rcp_guarantee_days', '')),
            'founding_label': fnd.get('label', ''),
            'business_days': self.brand.get('business_days_text', ''),
        })
        self.tokens['worked_with'] = self.t((self.brand.get('proof') or {}).get('worked_with') or self.shared['worked_with_fallback']).rstrip('.')
        sla = self.brand.get('quote_sla_text') or 'within 1 business day'
        self.tokens['quote_sla'] = sla
        self.tokens['quote_sla_cap'] = sla[:1].upper() + sla[1:]
        self.tokens['quote_sla_short'] = re.sub(r'^within\s+', '', sla)
        # FirstRing monthly plans (owner decision 2026-11-25): {price:FR_PRO.monthly}, {minutes:FR_PRO}, {days:FR_BUSINESS},
        # {from_price}, {trial_days}, {trial_minutes}, the trial / cancel / minutes / go-live lines and the money-back guarantee
        self.plans = self.pb.get('plans', [])
        sub = rules.get('subscription') or {}
        st = sub.get('texts') or {}
        for p in self.plans:
            self.tokens[f'price:{p["code"]}.monthly'] = money(p['monthly_cents'])
            self.tokens[f'minutes:{p["code"]}'] = f'{p["included_usage"]["voice_minutes"]:,}'
            self.tokens[f'days:{p["code"]}'] = str(p['go_live_business_days'])
        ms = rr.get('subscription') or {}
        mtext, mlabel = ms.get('text', ''), ms.get('label', '')
        if mtext and not mtext.startswith(mlabel + ': '):
            raise SystemExit('build_landing: refund_rules.subscription.text must start with "<label>: "')
        self.tokens.update({
            'from_price': money(min(p['monthly_cents'] for p in self.plans)) if self.plans else '',
            'trial_days': str(sub.get('trial_days', '')),
            'trial_minutes': str(sub.get('trial_minutes', '')),
            'trial_text': st.get('trial', ''), 'cancel_text': st.get('cancel', ''), 'minutes_text': st.get('minutes', ''),
            'go_live_text': st.get('go_live', ''), 'no_setup_text': st.get('no_setup', ''),
            'money_back': mtext, 'money_back_label': mlabel, 'money_back_days': str(ms.get('money_back_days', '')),
        })
        # usage text: the plans' minutes line (v2.0), else config rules.usage_policy.text, else content fallback
        usage = st.get('minutes') or (rules.get('usage_policy') or {}).get('text') or self.shared['usage_text_fallback']
        self.page = {}
        self.tokens['usage_text'] = self.t(usage)

    def t(self, s):
        """Fill {tokens}. Unknown token = build error."""
        def sub(m):
            k = m.group(1)
            if k in self.page:
                return self.page[k]
            if k not in self.tokens:
                raise SystemExit(f'build_landing: unknown token {{{k}}} in content')
            return self.tokens[k]
        return re.sub(r'\{([a-z][a-z0-9_]*(?::[A-Z0-9_-]+(?:\.[a-z]+)?)?)\}', sub, s)

    def h(self, s):
        """Token-fill + HTML-escape + **bold** + *accent word* (italic serif on a brush stroke, base.css .em)."""
        out = html.escape(self.t(s), quote=False)
        out = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', out)
        return EM_RX.sub(r'<em class="em">\1</em>', out)

    def plain(self, s):
        """Token-fill, markup stripped (for attributes and meta text)."""
        return EM_RX.sub(r'\1', re.sub(r'\*\*(.+?)\*\*', r'\1', self.t(s)))


EM_RX = re.compile(r'(?<![*\w])\*([^*\n]+?)\*(?![*\w])')
THEME_VARS = {'ink': '--ink', 'ink_2': '--ink-2', 'ink_3': '--ink-3', 'screen': '--screen', 'paper': '--paper',
              'violet': '--violet', 'violet_2': '--violet-2', 'violet_deep': '--violet-deep', 'amber': '--amber', 'amber_2': '--amber-2'}


LANDING_VARS = {k: '--wd-' + k.replace('_', '-') for k in
                ('bg', 'card', 'ink', 'ink_2', 'muted', 'line', 'blue', 'blue_soft', 'sun', 'sun_soft')}


def theme_drift(c):
    """config/brand.json theme must equal the :root values in site/assets/base.css, and brand.json landing_theme (design
    'Workday', marketing pages only) the --wd-* values in site/assets/landing.css (one palette per pair of files)."""
    out = []
    for fname, key, vars_ in (('base.css', 'theme', THEME_VARS), ('landing.css', 'landing_theme', LANDING_VARS)):
        with open(os.path.join(SITE, 'assets', fname), encoding='utf-8') as fh:
            css = fh.read()
        for k, var in vars_.items():
            want = (c.brand.get(key) or {}).get(k, '')
            m = re.search(re.escape(var) + r':(#[0-9A-Fa-f]{6})\b', css)
            if not m or m.group(1).upper() != want.upper():
                out.append(f'{var} = {m.group(1) if m else "missing"} in {fname}, brand.json {key}.{k} = {want or "missing"}')
    return out


def money(cents):
    d = cents / 100
    return f'${d:,.0f}' if d == int(d) else f'${d:,.2f}'


def deposit_cents(setup_cents, rules):
    pct = rules.get('deposit_pct', 50)
    return round(setup_cents * pct / 100 / 100) * 100


def esc(s):
    return html.escape(str(s), quote=True)


# ---------------------------------------------------------------- shared blocks
ICONS = {
    'phone': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="14" y="4" width="20" height="40" rx="4"/><path d="M21 38h6"/><path d="M38 12l6-6M44 12l-6-6" stroke-linecap="round"/></svg>',
    'chat': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 10h28a4 4 0 014 4v14a4 4 0 01-4 4H18l-8 7v-7H6a4 4 0 01-4-4V14a4 4 0 014-4z"/><path d="M11 19h18M11 25h11" stroke-linecap="round"/></svg>',
    'calendar': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="9" width="38" height="34" rx="4"/><path d="M5 18h38M15 4v9M33 4v9" stroke-linecap="round"/><path d="M17 31l5 5 10-11" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    # FirstRing page (2026-11-23): the three kinds of calls + what the owner gets
    'wrench': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M30 6a10 10 0 00-9.4 13.4L7 33a4.2 4.2 0 006 6l13.6-13.6A10 10 0 0040 15l-6 2-4-4 2-6a10 10 0 00-2-1z"/></svg>',
    'quote': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4h17l9 9v31H12z"/><path d="M29 4v9h9M18 24h14M18 31h14M18 38h8"/></svg>',
    'repeat': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="24" cy="16" r="8"/><path d="M8 42c2-8 8-12 16-12s14 4 16 12"/><path d="M33 9l4-4 4 4M37 5v9" /></svg>',
    'mail': '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="38" height="28" rx="4"/><path d="M7 13l17 13 17-13"/></svg>',
}


def analytics(c):
    """Measurement (2026-10-25): /assets/measure.js + its config. Empty IDs in brand.json analytics = no third-party
    tag is ever loaded (measure.js still keeps first-touch UTM in localStorage). measure.js also skips loading when the
    browser sends Global Privacy Control / Do Not Track, and on localhost. Clarity masks every form (typed values).
    Meta Pixel (optional, 2026-10-29): same rules; page views + the funnel events, autoConfig off, no advanced matching."""
    a = c.brand.get('analytics', {})
    cfg = {'ga4_id': a.get('ga4_id', ''), 'clarity_id': a.get('clarity_id', ''), 'meta_pixel_id': a.get('meta_pixel_id', ''),
           'events': a.get('events', [])}
    js = json.dumps(cfg, ensure_ascii=False, separators=(',', ':'))
    return f'<script src="/assets/measure.js" defer data-measure="{esc(js)}"></script>'


def inline_css():
    """base.css + landing.css inlined (no render-blocking requests; Lighthouse mobile). Rebuild after editing either."""
    out = []
    for name in ('base.css', 'landing.css'):
        with open(os.path.join(SITE, 'assets', name), encoding='utf-8') as fh:
            css = fh.read()
        css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
        css = re.sub(r'\s*\n\s*', '', css)
        out.append(css)
    return ''.join(out).replace('</', '<\\/')


def landing_fonts(c):
    """Google Fonts stylesheet for the marketing pages (design 'Workday': Bricolage Grotesque + Inter). The sign-up,
    quote page, portal and admin keep fonts.google_css (Noto + Space Mono) with base.css."""
    f = c.brand['fonts']
    return f.get('landing_css') or f['google_css']


def head(c, *, title, desc, path, canonical=None, index=True, og_image, og_title, jsonld=None):
    canon = c.site_url + (canonical or path)
    robots = 'index, follow, max-image-preview:large' if index else 'noindex, nofollow'
    ld = ''
    if jsonld:
        ld = '<script type="application/ld+json">' + json.dumps(jsonld, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/') + '</script>'
    return f'''<!doctype html>
<html lang="en" dir="ltr">
<head>
<!-- {MARK} -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="{esc(c.brand['landing_theme']['bg'])}">
<meta name="robots" content="{robots}">
<script>document.documentElement.classList.add('js');if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('motion')</script>
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{esc(canon)}">
<meta property="og:type" content="website"><meta property="og:locale" content="en_US"><meta property="og:site_name" content="{esc(c.brand['name'])}">
<meta property="og:title" content="{esc(og_title)}"><meta property="og:description" content="{esc(desc)}"><meta property="og:url" content="{esc(canon)}">
<meta property="og:image" content="{esc(c.site_url + og_image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="/assets/gem-64.png"><link rel="apple-touch-icon" href="/assets/gem-128.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{esc(landing_fonts(c))}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="{esc(landing_fonts(c))}"></noscript>
<style>{inline_css()}</style>
{analytics(c)}
{ld}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>'''


def brandmark(c):
    """Diamond gem (from the Israeli site) + wordmark. Decorative image: the link text is the name."""
    return (f'<a class="brandmark" href="/"><img src="/assets/gem-64.png" alt="" width="28" height="28" decoding="async">'
            f'{esc(c.brand["name"])}<small>US</small></a>')


def nav(c, active, cta=None):
    cta = cta or {'label': TRIAL_CTA, 'href': '#pricing'}
    links = ''.join(
        f'<a href="{esc(n["href"])}"' + (' aria-current="page"' if n['href'] == active else '') + f'>{esc(n["label"])}</a>'
        for n in c.shared['nav'])
    return f'''<header class="nav"><div class="wrap nav__in">
{brandmark(c)}
<nav class="nav__links" aria-label="Main">{links}<a class="btn btn--primary btn--sm" href="{esc(cta['href'])}"{f' data-ev="{cta["ev"]}"' if cta.get('ev') else ''}{' data-niche-cta' if cta.get('niche_cta') else ''}>{esc(cta['label'])}</a></nav>
</div></header>'''


SOCIAL_ICONS = {
    'linkedin': ('LinkedIn', '<path d="M6.5 9.5v8M6.5 6.5v.01M10.5 17.5v-4.5a2.5 2.5 0 015 0v4.5M10.5 9.5v8"/>'),
    'facebook': ('Facebook', '<path d="M14 8h2V5h-2a3 3 0 00-3 3v2H9v3h2v6h3v-6h2l.5-3H14V8.5a.5.5 0 01.5-.5z"/>'),
    'instagram': ('Instagram', '<rect x="5" y="5" width="14" height="14" rx="4"/><circle cx="12" cy="12" r="3.2"/><path d="M16.2 7.8v.01"/>'),
    'youtube': ('YouTube', '<rect x="4" y="7" width="16" height="10" rx="3"/><path d="M11 10v4l3.5-2z"/>'),
    'x': ('X', '<path d="M6 6l12 12M18 6L6 18"/>'),
}


def footer(c, year):
    """Big footer, same on every generated page: brand + social, 3 link columns, legal column, contact row, legal bar.
    Copy from _shared.json footer; social URLs, address, email and disclaimer from brand.json."""
    b = c.brand
    f = c.shared['footer']
    mail = b.get('support_email', '')
    page, c.page = c.page, {}

    def href(h):
        return h.replace('{support_email}', mail).replace('{video_call}', video_call_href(c))

    def links(ls):
        return '<ul>' + ''.join(f'<li><a href="{esc(href(x["href"]))}">{c.h(x["label"])}</a></li>' for x in ls) + '</ul>'

    socials = ''.join(
        f'<a class="footer__social" href="{esc(u)}" rel="noopener" aria-label="{esc(SOCIAL_ICONS[k][0])}">'
        f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{SOCIAL_ICONS[k][1]}</svg></a>'
        for k, u in (b.get('social') or {}).items() if k in SOCIAL_ICONS and isinstance(u, str) and u.startswith('https://'))
    social = f'<div class="footer__socials">{socials}</div>' if socials else f'<p class="small">{c.h(f["social_empty"])}</p>'
    cols = []
    for n, col in enumerate(f['columns'], start=2):
        sub = ''
        if col.get('sub_links'):
            sub = f'<p class="footer__sub">{c.h(col["sub_title"])}</p>{links(col["sub_links"])}'
        cols.append(f'<div class="footer__col"><p class="footer__k">0{n} / {esc(col["title"])}</p><h3 class="footer__h"><em class="em">{c.h(col["title"])}</em></h3>{links(col["links"])}{sub}</div>')
    contact = []
    if mail:
        contact.append(f'<a class="footer__contact" href="mailto:{esc(mail)}"><span class="footer__ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M4 7l8 6 8-6"/></svg></span><span><small>Email us</small><b>{esc(mail)}</b></span></a>')
    # site shows the short address (street + city); the full postal address stays in brand.physical_address for email footers
    shown_address = b.get('display_address') or b.get('physical_address')
    if shown_address:
        contact.append(f'<p class="footer__contact"><span class="footer__ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg></span><span><small>Studio address</small><b>{esc(shown_address)}</b></span></p>')
    out = f'''<footer class="footer"><div class="wrap">
<div class="footer__grid">
<div class="footer__col footer__brand"><p class="footer__k">01 / Social</p><h3 class="footer__h">{c.h(f["social_title"])}</h3>{social}
{brandmark(c)}
<p class="footer__note small">{esc(page.get('tagline') or b.get('tagline', ''))}. {c.h(f["note"])}</p>
<p class="footer__studio small">{c.h(f["studio"])}</p></div>
{''.join(cols)}
</div>
<div class="footer__row">{''.join(contact)}</div>
<div class="footer__legal"><span>&copy; {year} {esc(b['name'])}</span><span>{esc(b['disclaimers']['footer'])}</span><span>Claude is a trademark of Anthropic, PBC.</span></div>
</div></footer>
<script src="/assets/landing.js" defer></script>'''
    c.page = page
    return out


def price_line(c, code, tag):
    i = c.items[code]
    return (f'<p class="hero__price"><b class="num">{money(i["setup_cents"])}</b> setup <span class="plus">+</span> '
            f'<b class="num">{money(i["monthly_cents"])}</b>/mo<span class="tag">{esc(tag)}</span></p>')


def mobile_bar(c, code, href, label):
    """Sticky bottom CTA on phones (<= 760px). landing.js shows it only between the hero and the next CTA-bearing
    section (demo, pricing, band), so it never covers another call to action."""
    i = c.items[code]
    return (f'<div class="mbar" data-mbar><p class="mbar__price"><b class="num">{money(i["setup_cents"])}</b> setup + '
            f'<b class="num">{money(i["monthly_cents"])}</b>/mo</p>'
            f'<a class="btn btn--primary btn--sm" href="{esc(href)}" data-ev="quote_start">{esc(label)}</a></div>')


def clock(c, data, label, demo=None):
    """Hero signature: the owner's business line, live. A missed call becomes a text-back thread and a booked slot.
    Every row stays in the DOM as text (no-JS, SEO, screen readers); landing.js plays it once in view and on CTA hover."""
    rows = []
    for n, r in enumerate(data['rows']):
        kind = 'call' if n == 0 else 'booked' if r.get('booked') else 'ai' if n == 1 else 'lead'
        cls = f'k-{kind}' + (' is-booked' if r.get('booked') else '')
        typing = '<span class="live__typing" aria-hidden="true"><i></i><i></i><i></i></span>' if kind in ('ai', 'lead') else ''
        rows.append(f'<li class="{cls}" style="--i:{n}" data-t="{esc(r["t"])}"><time>{esc(r["t"])}</time><b>{c.h(r["a"])}</b><span>{c.h(r["b"])}</span>{typing}</li>')
    first = data['rows'][0]['t'].split(' ')[0]
    who = ''
    if demo:
        who = (f'<div class="live__who" aria-hidden="true"><span class="live__av">{esc(demo["business"][:1])}</span>'
               f'<span><b>{esc(demo["business"])}</b><small>{esc(demo["business_line"])} · AI assistant</small></span></div>')
    return f'''<figure class="clock live" data-live aria-label="{esc(label)}">
<div class="live__phone">
<div class="live__status" aria-hidden="true"><span data-live-clock>{esc(first)}</span><span class="live__sig"><i></i><i></i><i></i><i></i></span></div>
{who}
<div class="clock__head"><span><i>&#9679;</i> Missed call</span><span data-live-elapsed>2 minutes later</span></div>
<ol>{''.join(rows)}</ol>
</div>
<figcaption>{c.h(data['caption'])}</figcaption>
</figure>'''


def fold(fid, title, gist, body, *, tag='h3', cls=''):
    """Closed, tappable section (2026-11-25, owner: "too much text"): a real heading, a few-word gist of what is inside,
    and a "Show" control. Native <details>: works without JS, keyboard-operable, the content stays in the HTML (SEO);
    landing.js opens it for printing and when a link points at it (#id). Same pattern as the quote page (.q-fold)."""
    idattr = f' id="{esc(fid)}"' if fid else ''
    gist_html = f'<span class="fold__gist">{gist}</span>' if gist else ''
    return (f'<details class="fold{(" " + cls) if cls else ""}"{idattr}><summary><span class="fold__head"><{tag} class="fold__t">{title}</{tag}>{gist_html}</span>'
            f'<span class="fold__more" aria-hidden="true">Show</span></summary><div class="fold__body">{body}</div></details>')


def count_label(n, one, many=None):
    return f'{n} {one if n == 1 else (many or one + "s")}'


def missed_fold(c, steps, gist=None):
    """"What happens to a missed call" (was a full section): three short steps, folded under the demo, which already
    plays the same call. The gist (content missed_gist, else the step titles) names the three steps."""
    m = c.shared['missed']
    lis = ''.join(f'<li><span class="num">{n + 1}</span><h4>{c.h(s["title"])}</h4><p>{c.h(s["text"])}</p></li>'
                  for n, s in enumerate(steps))
    gist = c.h(gist) if gist else esc(' · '.join(c.plain(s['title']) for s in steps))
    return fold('how-it-answers', c.h(m['eyebrow']), gist, f'<ol class="rail rail--3">{lis}</ol>')


def section_why(c):
    """Compact dark "why" strip (2026-11-25): heading plus three cited stats (number, one line, source). Numbers count
    up once in view (landing.js, motion only); the final value is always the DOM text. 2026-11-27: an entry without
    "num" is a plain product statement (title + text, no digits, no source)."""
    w = c.shared['why']
    cards = []
    for s_ in w['stats']:
        if not s_.get('num'):
            # plain product statement (2026-11-27): no number, so no source; it must not smuggle a number in
            if not s_.get('title') or not s_.get('text') or any(ch.isdigit() for ch in s_['title'] + s_['text']):
                raise SystemExit('build_landing: a why.stats statement needs title + text and no numbers (numbers need num + source)')
            cards.append(f'<li class="stat stat--plain"><div class="stat__txt"><p class="stat__head">{c.h(s_["title"])}</p>'
                         f'<p>{c.h(s_["text"])}</p></div></li>')
            continue
        if not (s_.get('source') and s_.get('source_url', '').startswith('https://')):
            raise SystemExit('build_landing: every why.stats entry needs source + https source_url (no uncited numbers)')
        cards.append(f'<li class="stat"><p class="stat__num num" data-count>{esc(s_["num"])}</p><div class="stat__txt">'
                     f'<p>{c.h(s_["text"])}</p><p class="stat__src">Source: <a href="{esc(s_["source_url"])}" rel="noopener nofollow">{esc(s_["source"])}</a></p></div></li>')
    return f'''<section class="section why why--compact" id="why"><div class="wrap">
<h2>{c.h(w['title'])}</h2>
<ul class="stats">{''.join(cards)}</ul>
</div></section>'''


def stars(n):
    n = max(0, min(5, int(n)))
    return f'<span class="rv__stars" role="img" aria-label="{n} out of 5 stars">' + '★' * n + f'<i>{"★" * (5 - n)}</i></span>'


REVIEWS_MIN = 2  # the "What clients say" section renders only with at least this many approved reviews


def approved_reviews(rv):
    """Real reviews from reviews.json that may be shown: consent is true and every required field is filled.
    A consented review with a missing field stops the build (a half-entered real review is a mistake, not a skip)."""
    out = []
    for r in rv.get('reviews') or []:
        if r.get('consent') is not True:
            continue
        miss = [k for k in ('name', 'business', 'city', 'text', 'source_url', 'date') if not r.get(k)]
        if miss:
            raise SystemExit(f'build_landing: review by {r.get("name", "?")} is missing {", ".join(miss)}')
        out.append(r)
    return out


def review_cards(c, rv):
    """Real reviews pasted by the owner into reviews.json (approved only); each links to its source."""
    out = []
    for r in approved_reviews(rv):
        st = stars(r['rating']) if r.get('rating') else ''
        out.append(f'<figure class="rv rv--real"><div class="rv__head"><span class="rv__av" aria-hidden="true">{esc(r["name"][:1])}</span>'
                   f'<span class="rv__who"><b>{esc(r["name"])}</b><small>{esc(r["business"])} · {esc(r["city"])}</small></span>{st}</div>'
                   f'<blockquote class="rv__body"><p>{esc(r["text"])}</p></blockquote>'
                   f'<p class="rv__src"><a href="{esc(r["source_url"])}" rel="noopener nofollow">Original review</a> · <time datetime="{esc(r["date"])}">{esc(r["date"])}</time></p></figure>')
    return out


def marquee_row(cards, reverse=False):
    """One marquee row. Set 1 holds every card once (plus aria-hidden repeats up to 6, so it is wider than the screen);
    set 2 is an inert copy for the seamless loop. No motion / no JS: a plain horizontal scroller, copies hidden."""
    if not cards:
        return ''
    reps = []
    while len(cards) + len(reps) < 6:
        reps.append(cards[len(reps) % len(cards)])
    hidden = lambda h: h.replace('<figure class="rv', '<figure aria-hidden="true" inert class="rv is-copy', 1).replace('<a href=', '<a tabindex="-1" href=')
    set1 = ''.join(cards) + ''.join(hidden(x) for x in reps)
    set2 = ''.join(hidden(x) for x in cards + reps)
    n = len(cards) + len(reps)
    return (f'<div class="rvrow{" rvrow--rev" if reverse else ""}" style="--n:{n}"><div class="rvrow__track">'
            f'<div class="rvrow__set">{set1}</div><div class="rvrow__set rvrow__set--copy" aria-hidden="true">{set2}</div></div></div>')


def section_reviews(c):
    """"What clients say": real reviews, only with >= REVIEWS_MIN approved ones; otherwise omitted entirely (no empty
    "your review here" placeholders). The "What a call sounds like" strip of Sample cards was removed on 2026-11-25
    (owner: too much text; it repeated the interactive demo on the same page)."""
    rv = c.reviews
    real = review_cards(c, rv)
    if len(real) < REVIEWS_MIN:
        return ''
    return f'''<section class="section reviews" id="reviews"><div class="wrap">
<div class="shead shead--c"><p class="eyebrow">{c.h(rv['eyebrow'])}</p><h2>{c.h(rv['title'])}</h2><p class="lead">{c.h(rv['lead'])}</p></div>
</div>
<div class="rvrows">{marquee_row(real)}</div>
</section>'''


# ---------------------------------------------------------------- demo
def demo_paths(scn):
    """Every root-to-leaf path of one scenario as a list of chip texts (used for the static transcript + tests)."""
    out = []

    def walk(nid, acc, seen):
        node = scn['nodes'][nid]
        if node.get('booked'):
            out.append(acc)
            return
        if nid in seen:
            raise SystemExit(f'demo loop in {scn["key"]} at {nid}')
        for ch in node['chips']:
            walk(ch['next'], acc + [ch], seen | {nid})
    walk(scn['start'], [], set())
    return out


def validate_demo(niche_key, demo):
    if len(demo['scenarios']) != 3:
        raise SystemExit(f'{niche_key}: demo needs exactly 3 scenarios')
    for scn in demo['scenarios']:
        for nid, node in scn['nodes'].items():
            if not node.get('booked'):
                n = len(node.get('chips', []))
                if not 2 <= n <= 3:
                    raise SystemExit(f'{niche_key}/{scn["key"]}/{nid}: needs 2-3 reply chips, has {n}')
                for ch in node['chips']:
                    if ch['next'] not in scn['nodes']:
                        raise SystemExit(f'{niche_key}/{scn["key"]}/{nid}: unknown next {ch["next"]}')
        demo_paths(scn)


def fill_vars(s, vars_):
    return re.sub(r'\{(\w+)\}', lambda m: vars_.get(m.group(1), m.group(0)), s)


def transcript(c, demo):
    """Static text transcript of the first path of the first scenario (also the no-JS view)."""
    scn = demo['scenarios'][0]
    path = demo_paths(scn)[0]
    tr = c.shared['transcript']
    vars_, lines, nid = {}, [], scn['start']
    node = scn['nodes'][nid]
    if node.get('system'):
        lines.append(f'<p class="small muted">{esc(node["system"])}</p>')
    for ch in path + [None]:
        for b in node.get('bot', []):
            lines.append(f'<p><b>{esc(tr["assistant"])}:</b> {esc(fill_vars(b, vars_))}</p>')
        if ch is None:
            break
        lines.append(f'<p><b>{esc(tr["caller"])}:</b> {esc(ch["say"])}</p>')
        vars_.update(ch.get('set', {}))
        node = scn['nodes'][ch['next']]
    return f'<details class="more transcript"><summary>{esc(tr["title"])}</summary><div class="stack" style="--stack:10px;margin-top:14px">{"".join(lines)}</div></details>'


PLANS_PAGE = {'home_services': '/firstring/#pricing', 'real_estate': '/real-estate/#pricing'}  # where each niche's plans are


def demo_payload(c, keys, contents, cta_href=None):
    """cta: where the demo's "Start free trial" buttons (data-niche-cta) lead for this niche: the plans on this page
    (one niche) or, on /demo/ with the niche switcher, the plans page of the chosen niche."""
    data = {}
    for k in keys:
        d = contents[k]['demo']
        n = contents[k]
        data[k] = {'label': c.brand_niche_label(k), 'business': d['business'], 'line': d['business_line'],
                   'product': n.get('product_name') or 'FirstRing',
                   'cta': cta_href if len(keys) == 1 and cta_href else PLANS_PAGE[k], 'scenarios': d['scenarios']}
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')


def demo_widget(c, keys, contents, *, cta_href, cta_label, switcher=False, transcript_=True, head=''):
    first = contents[keys[0]]['demo']
    sw = ''
    if switcher:
        sw = '<div class="demo__niche" role="group" aria-label="Business type">' + ''.join(
            f'<button type="button" data-niche="{k}" aria-pressed="{"true" if i == 0 else "false"}">{esc(c.brand_niche_label(k))}</button>'
            for i, k in enumerate(keys)) + '</div>'
    picks = ''.join(
        f'<button type="button" class="demo__pick" data-scenario="{esc(s["key"])}" aria-pressed="false">{esc(s["label"])}</button>'
        for s in first['scenarios'])
    note = c.brand['disclaimers']['demo']
    av = esc(first['business'][:1])
    ev = esc(c.brand.get('analytics', {}).get('events', ['demo_start'])[0])
    live_url = str((c.brand.get('demo') or {}).get('runtime_url') or '').rstrip('/')  # B8: live demo runtime ('' = scripted only)
    live = f' data-live="{esc(live_url)}"' if live_url.startswith('https://') else ''
    return f'''<div class="demo" data-demo data-niche="{keys[0]}" data-ev-start="{ev}"{live}>
<div class="demo__side">
{head}{sw}
<p class="small muted">Pick a situation:</p>
<div class="demo__picks" role="group" aria-label="Demo scenarios">{picks}</div>
{transcript(c, first) if transcript_ else ''}
</div>
<div class="phone phone--call">
<div class="phone__bar"><span class="phone__av" aria-hidden="true">{av}</span><span class="phone__who"><b data-demo-biz>{esc(first['business'])}</b><span data-demo-line>{esc(first['business_line'])} · AI assistant</span></span><span class="phone__call"><i aria-hidden="true"></i><span data-demo-status>Demo call</span><span data-demo-timer>0:00</span></span></div>
<p class="phone__demo">{esc(note)}</p>
<div class="chat" data-demo-chat aria-live="polite" aria-label="Demo call">
<p class="bubble bubble--system">Pick a situation to start. You play the caller.</p>
</div>
<div class="demo__end" data-demo-end hidden><button type="button" class="btn btn--ghost btn--sm" data-demo-restart>Try another situation</button><a class="btn btn--primary btn--sm" href="{esc(cta_href)}" data-niche-cta>{esc(cta_label)}</a></div>
</div>
<script type="application/json" data-demo-data>{demo_payload(c, keys, contents, cta_href)}</script>
<p class="sr-only" data-demo-note>{esc(note)}</p>
</div>'''


# ---------------------------------------------------------------- sections
def section_demo(c, key, contents, cta_href, cta_label, extra=''):
    d = contents[key]['demo']
    return f'''<section class="section" id="demo"><div class="wrap">
{demo_widget(c, [key], contents, cta_href=cta_href, cta_label=cta_label,
             head=f'<div class="shead demo__head"><p class="eyebrow">{c.h(d["eyebrow"])}</p><h2>{c.h(d["title"])}</h2><p class="lead">{c.h(d["lead"])}</p></div>')}
<script src="/assets/demo.js" defer></script>
{f'<div class="folds">{extra}</div>' if extra else ''}
</div></section>'''


def includes_list(c, code):
    out = []
    for s in c.items[code]['includes']:
        if s.lower().startswith('included usage'):
            s = c.tokens['usage_text']
        out.append(f'<li>{esc(s)}</li>')
    return ''.join(out)


ADDON_SUFFIX = re.compile(r' \(add-on ([A-Z0-9-]+)\)$')  # price-book code suffix: machine-readable, shown as plain words


def soon(c, code):
    """Coming soon in the price book (needs US texting registration): listed with a label, never sold (PRICEBOOK §4.10)."""
    return (c.items.get(code) or {}).get('availability') == 'coming_soon'


def soon_label(c):
    return c.pb['rules'].get('availability', {}).get('coming_soon_label', 'Coming soon')


def excludes_list(c, code):
    def plain(s):
        return ADDON_SUFFIX.sub(lambda m: f' ({soon_label(c).lower()})' if soon(c, m.group(1)) else ' (extra, fixed price)', s)
    return ''.join(f'<li>{esc(plain(s))}</li>' for s in c.items[code]['excludes'] if not s.lower().startswith('usage above'))


def tool_status(c, key):
    v = c.pb['integrations'].get(key, 'custom')
    if v == 'native':
        return 'is-native', 'Included'
    if v == 'zapier':
        return 'is-zap', 'Via Zapier · included'
    if v.startswith('addon:'):
        it = c.items[v.split(':', 1)[1]]
        if it.get('retired'):  # v2.0: the add-on is now part of a plan ("Business plan"), never sold separately
            feat = next((k for k, f in c.pb.get('plan_features', {}).items() if f.get('replaces') == it['code']), None)
            first = next((p for p in c.plans if feat in p['features']), None)
            return ('is-addon', f'{first["name"]} plan · set up for you on request') if first else ('is-custom', 'Ask us')
        if soon(c, it['code']):
            return 'is-custom', soon_label(c)
        return 'is-addon', f'Extra {money(it["setup_cents"])} + {money(it["monthly_cents"])}/mo'
    return 'is-custom', 'Custom work · ask us'


def niche_includes(c, n):
    """Niche override list (content) or the price-book list for the core offer."""
    if n.get('included_items'):
        return [c.t(x) for x in n['included_items']]
    out = []
    for s_ in c.items[n['offer']]['includes']:
        out.append(c.tokens['usage_text'] if s_.lower().startswith('included usage') else s_)
    return out


def included_folds(c, niche_key, inc, n):
    """"What's included" and "Works with your tools" (was a full section, 2026-11-25): two folds beside the price card,
    which already shows the first five included items. Nothing removed: every item and every tool row is inside."""
    incl = niche_includes(c, n)
    excl = [c.t(x) for x in c.shared['plan_not_included']]
    body = (f'<ul class="ticks">{"".join(f"<li>{esc(x)}</li>" for x in incl)}</ul>'
            f'<p class="small muted" style="margin-top:14px">{c.h(c.shared["sms_note"])}</p>'
            f'<h4 class="fold__sub">Not included</h4><ul class="ticks ticks--no">{"".join(f"<li>{esc(x)}</li>" for x in excl)}</ul>')
    a = fold('included', c.h(inc['eyebrow']), f'Every plan: {count_label(len(incl), "item")} · Not included: {count_label(len(excl), "item")}', body)
    tools, names = [], []
    allow = n.get('tools')
    for k, meta in c.pb.get('integration_meta', {}).items():
        if k == 'other' or not ('*' in meta['niches'] or niche_key in meta['niches']):
            continue
        if allow is not None and k not in allow:
            continue
        cls, label = tool_status(c, k)
        if k in inc.get('tools_status', {}):  # content override (Calendly needs the client's own paid plan; HCP/GHL via Zapier)
            label = inc['tools_status'][k]
            cls = 'is-zap' if label.startswith('Via Zapier') else cls
        tools.append(f'<li class="{cls}"><span>{esc(meta["label"])}</span><span>{esc(label)}</span></li>')
        if cls == 'is-native':
            names.append(({'calendar': 0, 'automation': 1}.get(meta.get('category'), 2), meta['label']))
        for x in inc.get('tools_extra', []):
            if x['after'] == k:
                tools.append(f'<li class="is-native"><span>{esc(x["label"])}</span><span>{esc(x["status"])}</span></li>')
    names = [x[1] for x in sorted(names, key=lambda x: x[0])]  # calendars, then Zapier, first
    gist = f'{", ".join(names[:3])} included · {count_label(len(tools), "tool")} listed'
    b = fold('tools', c.h(inc['tools_title']), esc(gist), f'<ul class="tools">{"".join(tools)}</ul>')
    return a + b


def rail(c, steps, cls='rail', tag='h3'):
    return f'<ol class="{cls}">' + ''.join(
        f'<li><span class="num">{c.h(s["num"])}</span><{tag}>{c.h(s["title"])}</{tag}><p>{c.h(s["text"])}</p></li>' for s in steps) + '</ol>'


def video_call_href(c):
    url = c.brand.get('calendly_url')
    if url:
        return url
    mail = c.brand.get('support_email') or c.brand.get('senders', {}).get('reply_to', '')
    from urllib.parse import quote
    return f'mailto:{mail}?subject=' + quote('15-minute video call') + '&body=' + quote('Hi, I would like a 15-minute video call before choosing. Business name: ')


def video_call_box(c):
    v = c.shared['video_call_box']
    return (f'<p class="notice small"><span><b>{c.h(v["title"])}</b> {c.h(v["text"])} '
            f'<a href="{esc(video_call_href(c))}" rel="noopener">{c.h(v["link"])}</a></span></p>')


def section_how(c, how=None, after_pay=False):
    """One step rail (2026-11-25). On the AI pages it replaces three overlapping sections ("What happens to a missed
    call", "From first click to live", "Five steps, with dates"): the four steps stay visible and the dated plan after
    you pay is one fold under them (#after-you-pay)."""
    how = how or c.shared['how']
    extra = ''
    if after_pay:
        a = c.shared['after_pay']
        body = f'<p class="small muted">{c.h(a["lead"])}</p>' + rail(c, a['steps'], 'rail rail--5', 'h4')
        extra = '<div class="folds">' + fold('after-you-pay', c.h(a['eyebrow']), c.h(a['gist']), body) + '</div>'
    return f'''<section class="section" id="how"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(how['eyebrow'])}</p><h2>{c.h(how['title'])}</h2>{f'<p class="lead">{c.h(how["lead"])}</p>' if how.get('lead') else ''}</div>
{rail(c, how['steps'])}
{extra}
</div></section>'''


def trust_side(c, items):
    """The three trust points as a compact stack in the price column (AI pages, 2026-11-25): the column had empty
    space beside the tall price card, so trust costs no extra height on desktop."""
    p = c.shared['proof']
    lis = ''.join(f'<li><b>{c.h(x["title"])}</b><span>{c.h(x["text"])}</span></li>' for x in items)
    return f'<div class="trust-side" id="trust"><h3 class="fold__sub">{c.h(p["eyebrow"])}</h3><ul class="trust3 trust3--stack">{lis}</ul></div>'


def item_price(i):
    if i['kind'] == 'percent':
        return f'+{i["setup_pct"]}% of setup'
    parts = []
    if i['setup_cents']:
        parts.append(money(i['setup_cents']))
    if i['monthly_cents']:
        parts.append(f'{money(i["monthly_cents"])}/mo')
    return ' + '.join(parts)


def addons_table(c, core, hide=()):
    """Extras you can buy now, then (separately, labelled) the coming-soon ones: name and price only, no feature
    promises, never a button. Plan B prices never render here (rules.plan_b_enabled is false)."""
    rows, later = [], []
    for i in c.pb['items']:
        if i['group'] != 'addon' or core not in i['applies_to'] and 'any' not in i['applies_to']:
            continue
        if i['code'] in hide:
            continue
        (later if soon(c, i['code']) else rows).append(f'<tr><td>{esc(i["name"])}</td><td>{esc(item_price(i))}</td></tr>')
    out = f'<table class="addons"><caption>Extras, fixed prices</caption><tbody>{"".join(rows)}</tbody></table>'
    if later:
        av = c.pb['rules'].get('availability', {})
        out += (f'<table class="addons addons--soon" data-coming-soon><caption>{esc(soon_label(c))}</caption><tbody>{"".join(later)}</tbody></table>'
                f'<p class="small muted">{esc(av.get("coming_soon_text", ""))}</p>')
    return out


def bundles_soon(c, n):
    """Trade bundles that are not sold yet (they contain a texting add-on): a labelled card, no button (PRICEBOOK §1)."""
    b = (n or {}).get('bundles')
    if not b:
        return ''
    cards = []
    for code in b['codes']:
        i = c.items[code]
        if not soon(c, code):
            raise SystemExit(f'build_landing: {code} is sellable now; give it a real price card and a quote path first')
        parts = ' + '.join(esc(c.items[x]['name']) for x in i['contains'])
        cards.append(f'<li><span><b>{esc(i["name"])}</b><br><span class="small muted">{parts}</span></span><b>{esc(item_price(i))}</b></li>')
    return (f'<div class="bundle bundle--soon" data-coming-soon><span class="badge">{esc(soon_label(c))}</span><h3>{c.h(b["title"])}</h3>'
            f'<ul class="split">{"".join(cards)}</ul><p class="small">{c.h(b["today"])}</p></div>')


def price_card(c, code, cta_href, cta_label, *, featured=True, early=False, n=None):
    i = c.items[code]
    name = (n or {}).get('product_name') or i['name']
    incl = niche_includes(c, n) if n else i['includes']
    dep = deposit_cents(i['setup_cents'], c.pb['rules'])
    days = i.get('delivery_business_days')
    lis = ''.join(f'<li>{esc(s)}</li>' for s in incl[:5])
    btn = (f'<a class="btn btn--primary btn--block" href="#early-access">Join early access</a>' if early else
           f'<a class="btn btn--primary btn--block" href="{esc(cta_href)}" data-ev="quote_start">{esc(cta_label)}</a>')
    return f'''<div class="price-card{' price-card--featured' if featured else ''}">
<span class="badge badge--acc">Fixed price</span>
<div class="price-card__name">{esc(name)}</div>
<div class="price-card__amount"><b>{money(i['setup_cents'])}</b><span>setup</span><b>{money(i['monthly_cents'])}</b><span>/ month from go-live</span></div>
<ul class="split"><li><span>Deposit to start</span><b>{money(dep)}</b></li><li><span>Before go-live</span><b>{money(i['setup_cents'] - dep)}</b></li><li><span>Delivery</span><b>{days} business days</b></li></ul>
<ul class="price-card__list">{lis}</ul>
{btn}
{refund_fine(c, code)}
</div>'''


# ---------------------------------------------------------------- FirstRing monthly plans (owner decision 2026-11-25)
# Three packages from pricebook.json plans[] (no setup fee, 14-day free trial, cancel anytime). Every "Start free trial"
# button goes to /start/?plan=<CODE> (plus &niche= on a niche page) and fires TRIAL_EV (brand.json analytics.events).
TRIAL_EV = 'trial_start'
TRIAL_CTA = 'Start free trial'
REFUND_HREF = '/legal/refund/'


def plan_href(code, niche=None):
    return f'/start/?plan={code}' + (f'&niche={niche}' if niche else '')


def plan_feature_keys(c, plan, niche):
    """The plan's feature keys that apply to this niche (no on-call dispatch for real estate)."""
    pf = c.pb['plan_features']
    return [k for k in plan['features'] if '*' in pf[k]['niches'] or niche in pf[k]['niches']]


def plan_feature_label(c, key, niche):
    f = c.pb['plan_features'][key]
    return (f.get('label_by_niche') or {}).get(niche) or f['label']


def go_live_label(days):
    return f'Live in {days} business day' + ('' if days == 1 else 's') + ' after you finish setup'


def plan_cards(c, niche, link_niche, *, cta_href=None, cta_label=TRIAL_CTA):
    """One card per plan: name (+ badge), monthly price, included minutes, feature checklist ("Everything in <previous>,
    plus:" from the second plan on), go-live line and one button. The plan with a badge (Pro) is highlighted."""
    cards, prev, prev_keys = [], None, []
    for p in c.plans:
        keys = plan_feature_keys(c, p, niche)
        new = [k for k in keys if k not in prev_keys]
        lis = (f'<li class="plan__plus">Everything in {esc(prev["name"])}, plus:</li>' if prev else '') + ''.join(
            f'<li>{esc(plan_feature_label(c, k, niche))}</li>' for k in new)
        pop = bool(p.get('badge'))
        badge = f'<span class="badge plan__badge">{esc(p["badge"])}</span>' if pop else ''
        href = cta_href or plan_href(p['code'], link_niche)
        ev = f' data-ev="{TRIAL_EV}" data-plan="{esc(p["code"])}"' if not cta_href else ''
        cards.append(f'''<li class="plan{' plan--pop' if pop else ''}" id="plan-{esc(p['code'].lower().replace('_', '-'))}">
<div class="plan__top"><h3 class="plan__name">{esc(p['name'])}</h3>{badge}</div>
<p class="plan__price"><b class="num">{money(p['monthly_cents'])}</b><span>/mo</span></p>
<p class="plan__min"><b class="num">{p['included_usage']['voice_minutes']:,}</b> voice minutes a month</p>
<ul class="plan__list">{lis}</ul>
<p class="plan__go">{esc(go_live_label(p['go_live_business_days']))}</p>
<a class="btn{' btn--primary' if pop else ''} btn--block" href="{esc(href)}"{ev}>{esc(cta_label)}</a>
</li>''')
        prev, prev_keys = p, keys
    return '<ul class="plans" aria-label="Monthly plans">' + ''.join(cards) + '</ul>'


def plans_terms(c):
    """The trial / cancel line under the plans, then the minutes rule and the money-back guarantee with the refund link."""
    t = c.tokens
    chips = [f'{t["trial_days"]}-day free trial', 'Cancel anytime', t['no_setup_text'].rstrip('.'), t['go_live_text'].rstrip('.')]
    return (f'<ul class="plans__terms" aria-label="Every plan">{"".join(f"<li>{esc(x)}</li>" for x in chips)}</ul>'
            f'<p class="plans__fine">{esc(t["trial_text"])} {esc(t["cancel_text"])} {esc(t["minutes_text"])} '
            f'<b>{esc(t["money_back_label"])}</b> on your first paid month. <a href="{REFUND_HREF}">Refund policy</a></p>')


def section_plans(c, pr, *, niche, link_niche, cta_href=None, cta_label=TRIAL_CTA, after='', product=''):
    """The pricing block (design 'Workday'): heading, three plan cards (Pro highlighted), the trial/cancel line, then
    `after` (folds, trust, FAQ). `product` = the product name shown in the eyebrow (FirstRing AI Lead Assistant on
    the real-estate page)."""
    eyebrow = c.h(pr['eyebrow']) + (f' · {esc(product)}' if product else '')
    lead = f'<p class="lead">{c.h(pr["lead"])}</p>' if pr.get('lead') else ''
    return f'''<section class="section" id="pricing"><div class="wrap">
<div class="shead"><p class="eyebrow">{eyebrow}</p><h2>{c.h(pr['title'])}</h2>{lead}</div>
{plan_cards(c, niche, link_niche, cta_href=cta_href, cta_label=cta_label)}
{plans_terms(c)}
{after}
</div></section>'''


def plans_line(c, tag=None):
    """Hero price line: 'From $149/mo' + a short tag (trial, no setup fee, cancel anytime)."""
    tag = tag or f'{c.tokens["trial_days"]}-day free trial · no setup fee · cancel anytime'
    return (f'<p class="hero__price"><span class="from">From</span> <b class="num">{esc(c.tokens["from_price"])}</b>/mo'
            f'<span class="tag">{esc(tag)}</span></p>')


def plans_mbar(c, href, label=TRIAL_CTA, niche_cta=False):
    """Sticky bottom CTA on phones (<= 760px), plans version: 'From $149/mo · 14-day free trial' + a button to the plans."""
    nc = ' data-niche-cta' if niche_cta else ''
    return (f'<div class="mbar" data-mbar><p class="mbar__price">From <b class="num">{esc(c.tokens["from_price"])}</b>/mo<br>'
            f'{esc(c.tokens["trial_days"])}-day free trial</p>'
            f'<a class="btn btn--primary btn--sm" href="{esc(href)}"{nc}>{esc(label)}</a></div>')


def plans_ld(c, name, desc, url, service_type, audience):
    """Service JSON-LD with one monthly Offer per plan (no setup fee)."""
    offers = []
    for p in c.plans:
        price = f'{p["monthly_cents"] / 100:.2f}'
        offers.append({'@type': 'Offer', 'name': f'{p["product"]} {p["name"]}', 'url': url.split('#')[0] + '#pricing',
                       'price': price, 'priceCurrency': 'USD', 'availability': 'https://schema.org/InStock',
                       'priceSpecification': {'@type': 'UnitPriceSpecification', 'name': 'Monthly plan', 'price': price,
                                              'priceCurrency': 'USD',
                                              'referenceQuantity': {'@type': 'QuantitativeValue', 'value': 1, 'unitCode': 'MON'}}})
    return {'@type': 'Service', 'name': name, 'serviceType': service_type, 'description': desc,
            'provider': {'@id': c.site_url + '/#org'}, 'areaServed': {'@type': 'Country', 'name': 'United States'},
            'audience': {'@type': 'BusinessAudience', 'name': audience}, 'offers': offers}


def plans_after(c, niche_key, n):
    """Under the plans on a niche page: the "What's included" and "Works with your tools" folds, then the trust points
    and the optional video call."""
    return (f'<div class="pricing pricing--after"><div class="pricing__side"><div class="folds">{included_folds(c, niche_key, n["included"], n)}</div>'
            f'{video_call_box(c)}</div><div class="pricing__side">{trust_side(c, c.shared["trust"])}</div></div>')


def refund_fine(c, code):
    """Price-card fine print from refund_rules: the satisfaction guarantee for its codes (RCP, BNDL), then the deposit rule."""
    rr = c.pb.get('refund_rules', {})
    g = rr.get('rcp_guarantee', {})
    lines = ([g['text']] if code in g.get('codes', []) and g.get('text') else []) + [rr.get('deposit', {}).get('text', '')]
    return ''.join(f'<p class="price-card__fine">{esc(s)}</p>' for s in lines if s)


def extras_fold(c, code, n=None, fid='extras', after=''):
    """Extras (fixed prices), the coming-soon ones and the coming-soon trade bundles, folded (2026-11-25)."""
    hide = (n or {}).get('addons_hide', ())
    later_ok = lambda i: i['group'] == 'addon' and (code in i['applies_to'] or 'any' in i['applies_to']) and i['code'] not in hide
    now = [i for i in c.pb['items'] if later_ok(i) and not soon(c, i['code'])]
    later = [i for i in c.pb['items'] if later_ok(i) and soon(c, i['code'])]
    gist = count_label(len(now), 'extra') + (f' · {len(later)} {soon_label(c).lower()}' if later else '')
    if (n or {}).get('bundles'):
        gist += ' · trade bundles'
    return fold(fid, 'Extras, fixed prices', esc(gist), addons_table(c, code, hide) + bundles_soon(c, n) + after)


def faq_items(c, faq, sizes=(8, 9)):
    out = []
    for f in faq:
        if 'ref' in f:
            f = c.shared['faq'][f['ref']]
        out.append((c.t(f['q']), c.t(f['a'])))
    if len(out) not in sizes:
        raise SystemExit(f'FAQ must have {" or ".join(map(str, sizes))} entries, has {len(out)}')
    return out


def section_faq(faqs):
    items = ''.join(f'<details><summary>{esc(q)}</summary><div><p>{esc(a)}</p></div></details>' for q, a in faqs)
    return f'''<section class="section" id="faq"><div class="wrap">
<div class="faq-wrap"><div class="shead"><p class="eyebrow">FAQ</p><h2>Straight <em class="em">answers</em>.</h2></div>
<div class="faq">{items}</div></div>
</div></section>'''


def section_band(c, cta_href, cta_label, demo_href='#demo', band=None, niche_cta=False, ev=None):
    """Closing band: the main button (the plans, or WEB's package with ev='quote_start'), plus a demo button unless
    demo_href is None (the /firstring/ page drops it: its demo is on the page)."""
    b = band or c.shared['cta_band']
    nc = ' data-niche-cta' if niche_cta else ''
    eva = f' data-ev="{ev}"' if ev else ''
    demo = f'<a class="btn" href="{esc(demo_href)}" data-ev="demo_start">Try the demo</a>' if demo_href else ''
    return f'''<section class="section section--amber band"><div class="wrap">
<h2>{c.h(b['title'])}</h2><p style="margin-top:12px">{c.h(b['text'])}</p>
<div class="btn-row"><a class="btn btn--primary" href="{esc(cta_href)}"{eva}{nc}>{esc(cta_label)}</a>{demo}</div>
</div></section>'''


def section_early(c, e, niche):
    mail = c.brand.get('support_email', '')
    endpoint = (c.brand.get('endpoints') or {}).get('lead', '')
    return f'''<section class="section" id="early-access"><div class="wrap ea">
<div class="shead" style="margin:0"><p class="eyebrow">{c.h(e['eyebrow'])}</p><h2>{c.h(e['title'])}</h2><p class="lead">{c.h(e['text'])}</p></div>
<form data-lead data-niche="{esc(niche)}" data-endpoint="{esc(endpoint)}" data-mailto="{esc(mail)}" data-ok="{esc(e['ok'])}" data-fallback="{esc(e['fallback'])}" novalidate>
<div class="field"><label for="ea-email">Work email</label><input class="input" id="ea-email" name="email" type="email" autocomplete="email" required></div>
<div class="field"><label for="ea-company">Practice name</label><input class="input" id="ea-company" name="company" autocomplete="organization"></div>
<div class="field"><label for="ea-city">City and state</label><input class="input" id="ea-city" name="city" autocomplete="address-level2"></div>
<div class="hp" aria-hidden="true"><label for="ea-website">Website</label><input id="ea-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<button class="btn btn--primary" type="submit">{esc(e['button'])}</button>
<p class="ea__msg" data-lead-msg role="status"></p>
</form>
</div></section>'''


# ---------------------------------------------------------------- JSON-LD
def org_ld(c):
    o = {'@type': 'Organization', '@id': c.site_url + '/#org', 'name': c.brand['name'], 'url': c.site_url + '/'}
    if c.brand.get('support_email'):
        o['email'] = c.brand['support_email']
    return o


def service_ld(c, code, name, desc, url, service_type, audience):
    i = c.items[code]
    return {
        '@type': 'Service', 'name': name, 'serviceType': service_type, 'description': desc,
        'provider': {'@id': c.site_url + '/#org'}, 'areaServed': {'@type': 'Country', 'name': 'United States'},
        'audience': {'@type': 'BusinessAudience', 'name': audience},
        'offers': {'@type': 'Offer', 'url': url, 'price': f'{i["setup_cents"] / 100:.2f}', 'priceCurrency': 'USD',
                   'availability': 'https://schema.org/InStock',
                   'priceSpecification': [
                       {'@type': 'UnitPriceSpecification', 'name': 'Setup (one-time)', 'price': f'{i["setup_cents"] / 100:.2f}', 'priceCurrency': 'USD'},
                       {'@type': 'UnitPriceSpecification', 'name': 'Monthly', 'price': f'{i["monthly_cents"] / 100:.2f}', 'priceCurrency': 'USD',
                        'referenceQuantity': {'@type': 'QuantitativeValue', 'value': 1, 'unitCode': 'MON'}}]},
    }


def faq_ld(faqs):
    return {'@type': 'FAQPage', 'mainEntity': [
        {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in faqs]}


# ---------------------------------------------------------------- pages
def call_line(c, long=False):
    """'Hear it live' line with a tel: link to the demo number (brand.json demo.phone_*); '' when not configured."""
    d = c.brand.get('demo') or {}
    num, e164 = str(d.get('phone_number') or ''), str(d.get('phone_e164') or '')
    if not num or not re.fullmatch(r'\+1\d{10}', e164):
        return ''
    link = f'<a href="tel:{esc(e164)}" data-ev="demo_call" class="call__num">{esc(num)}</a>'
    biz, city = esc(d.get('phone_business') or ''), esc(d.get('phone_city') or '')
    where = f'our demo business, {biz} ({city})' if biz and city else 'our demo business'
    if long:
        return (f'<p class="call call--long"><b>Hear it live:</b> call {link}, {where}. US number, regular call charges apply. '
                f'An AI assistant answers, and the call may be recorded and written down as text.</p>')
    return f'<p class="call"><b>Hear it live:</b> call {link}. An AI answers for our demo business; calls may be recorded and written down as text.</p>'


def niche_page(c, key, contents, *, path, canonical=None, year):
    n = contents[key]
    c.page = {k: v for k, v in (n.get('page_tokens') or {}).items()}
    c.page.setdefault('assistant', 'receptionist')
    early = bool(n.get('early_access'))
    index = not early and next((x['index'] for x in c.brand['niches'] if x['key'] == key), True)
    seo = n['seo']
    title, desc = c.t(seo['title']), c.t(seo['description'])
    # v2.0 (2026-11-25): every main button leads to the plans on this page; each plan card has its own
    # "Start free trial" button to /start/?plan=<CODE>&niche=<key>
    cta_href = '#pricing'
    cta_label = TRIAL_CTA
    faqs = faq_items(c, n['faq'])
    canon_url = c.site_url + (canonical or path)
    product = n.get('product_name') or 'FirstRing'
    ld = None
    if index:
        ld = {'@context': 'https://schema.org', '@graph': [
            org_ld(c),
            plans_ld(c, n.get('service_name') or product, desc, canon_url, seo['service_type'], seo['audience']),
            faq_ld(faqs)]}
    hero = n['hero']
    if early:
        buttons = '<a class="btn btn--primary" href="#early-access">Join early access</a><a class="btn btn--ghost" href="#demo" data-ev="demo_start">Try the demo</a>'
        badge = '<span class="badge badge--acc badge-early">Early access · not yet available</span>'
        tag = 'Expected price'
    else:
        buttons = f'<a class="btn btn--primary" href="{esc(cta_href)}">{cta_label}</a><a class="btn btn--ghost" href="#demo" data-ev="demo_start">Try the demo</a>'
        badge = ''
        tag = None
    also = f'<p class="small muted">{c.h(hero["also"])}</p>' if hero.get('also') else ''
    body = [
        head(c, title=title, desc=desc, path=path, canonical=canonical, index=index,
             og_image=f'/assets/og/{n["slug"]}.png', og_title=c.t(seo['og_title']), jsonld=ld),
        nav(c, '/firstring/' if key == 'home_services' else path,
            {'label': 'Join early access', 'href': '#early-access'} if early else
            {'label': TRIAL_CTA, 'href': cta_href}),
        '<main id="main" class="m-compact">',
        f'''<section class="hero"><div class="wrap hero__grid">
<div class="hero__copy">{badge}
<p class="eyebrow">{c.h(hero['eyebrow'])}</p>
<h1>{c.h(hero['title'])}</h1>
<p class="lead">{c.h(hero['lead'])}</p>
{plans_line(c, tag)}
<div class="btn-row">{buttons}</div>
{call_line(c)}<p class="hero__fine">{c.h(hero['fine'])}</p>{also}
</div>
{clock(c, n['clock'], 'A missed call becomes a booking', n.get('demo'))}
</div></section>''',
        # 2026-11-25 (owner: "too much text"): one screen per idea. The missed-call steps fold under the demo; the
        # included list, the tools table and the extras fold beside the price card; the dated plan folds under "How
        # it works"; the proof table became three trust points; the Sample-call strip (a copy of the demo) is gone.
        section_why(c),
        section_demo(c, key, contents, '#early-access' if early else cta_href, 'Join early access' if early else cta_label,
                     extra=missed_fold(c, n['missed_steps'], n.get('missed_gist'))),
        section_how(c, after_pay=True),
        section_reviews(c),
        section_plans(c, n['pricing'], niche=key, link_niche=key, product=product,
                      cta_href='#early-access' if early else None, cta_label='Join early access' if early else TRIAL_CTA,
                      after=plans_after(c, key, n)),
    ]
    if early:
        body.append(section_early(c, n['early'], key))
    body += [section_faq(faqs)]
    if not early:
        body.append(section_band(c, cta_href, cta_label))
    body += ['</main>', '' if early else plans_mbar(c, cta_href), footer(c, year), '</body>\n</html>\n']
    return '\n'.join(body)


def website_page(c, w, year):
    path = '/website/'
    mode = 'online' if (c.brand.get('endpoints') or {}).get('payment') else 'link'
    c.page = {}
    for k, v in (w.get('variants') or {}).items():  # pay-online wording only once brand.endpoints.payment exists
        c.page[k] = c.t(v[mode])
    seo = w['seo']
    title, desc = c.t(seo['title']), c.t(seo['description'])
    faqs = faq_items(c, w['faq'])
    href_web = '/start/?offer=WEB'
    ld = {'@context': 'https://schema.org', '@graph': [
        org_ld(c), service_ld(c, 'WEB', c.items['WEB']['name'], desc, c.site_url + path, seo['service_type'], seo['audience']),
        faq_ld(faqs)]}
    sheets = ''.join(
        f'<div class="sheet" style="--i:{n}"><b>{esc(p["name"])}</b><i class="w60"></i><span class="blk"></span><span class="cta"></span></div>'
        for n, p in enumerate(w['pages']))
    pages = ''.join(f'<li><b>{esc(p["name"])}</b><span>{c.h(p["line"])}</span></li>' for p in w['pages'])
    hero = w['hero']
    fr = w['firstring']  # v2.0: the receptionist + website bundle is retired; a short "Add FirstRing" box replaces it
    # 2026-11-25: the "What's included" section is gone: the price card already lists all of WEB's included items, so
    # only "Not included" and the extras remain, as two folds under the price cards.
    n_exc = len(c.items['WEB']['excludes'])
    incl_web = fold('included', 'Not included', f'{count_label(n_exc, "item")}: extra pages, Spanish, logo, blog and more',
                    f'<ul class="ticks ticks--no">{excludes_list(c, "WEB")}</ul>')
    extras_web = extras_fold(c, 'WEB', after=f'<p class="small muted" style="margin-top:12px">{c.h(w["extras_note"])}</p>')
    body = [
        head(c, title=title, desc=desc, path=path, og_image='/assets/og/website.png', og_title=c.t(seo['og_title']), jsonld=ld),
        nav(c, path, {'label': 'Choose package', 'href': href_web, 'ev': 'quote_start'}), '<main id="main" class="m-compact">',
        f'''<section class="hero"><div class="wrap hero__grid">
<div class="hero__copy">
<p class="eyebrow">{c.h(hero['eyebrow'])}</p>
<h1>{c.h(hero['title'])}</h1>
<p class="lead">{c.h(hero['lead'])}</p>
{price_line(c, 'WEB', 'Fixed price · hosting and 1 edit a month included')}
<div class="btn-row"><a class="btn btn--primary" href="{href_web}" data-ev="quote_start">Choose this package</a><a class="btn btn--ghost" href="#pages">See the 5 pages</a></div>
<p class="hero__fine">{c.h(hero['fine'])}</p>
</div>
<figure class="sheets" aria-label="Five website pages: {esc(', '.join(p['name'] for p in w['pages']))}">{sheets}</figure>
</div></section>''',
        f'''<section class="section" id="pages"><div class="wrap">
<div class="shead"><p class="eyebrow">What you get</p><h2>{c.h(w['steps_title'])}</h2></div>
<ol class="pagelist">{pages}</ol>
</div></section>''',
        section_how(c, w['how']),
        f'''<section class="section" id="pricing"><div class="wrap">
<div class="shead"><p class="eyebrow">Pricing</p><h2>Pick one. The price is <em class="em">final</em>.</h2></div>
<div class="pricing">{price_card(c, 'WEB', href_web, 'Choose this package')}
<div class="pricing__side"><div class="bundle addfr" id="bundle"><span class="badge">FirstRing</span><h3>{c.h(fr['title'])}</h3><p>{c.h(fr['text'])}</p>
<a class="btn btn--ghost" href="{esc(fr['href'])}">{c.h(fr['link'])}</a>{video_call_box(c)}</div>{trust_side(c, w['trust'])}</div></div>
<div class="folds folds--row">{incl_web}{extras_web}</div>
</div></section>''',
        section_faq(faqs),
        section_band(c, href_web, 'Choose this package', '/demo/', band=w['band'], ev='quote_start'),
        '</main>', mobile_bar(c, 'WEB', href_web, 'Choose this package'), footer(c, year), '</body>\n</html>\n']
    return '\n'.join(body)


def demo_page(c, contents, year):
    path = '/demo/'
    c.page = {}
    k0 = PUBLIC_DEMO_NICHES[0]
    n0 = contents[k0]
    cta0 = PLANS_PAGE[k0]  # the niche switcher (demo.js, data-niche-cta) points every main button at that niche's plans
    title = f'Try the AI receptionist demo | {c.brand["name"]}'
    desc = 'A scripted demo of an AI receptionist answering a call to a small business: home services and real estate. Nothing is really booked.'
    ld = {'@context': 'https://schema.org', '@graph': [org_ld(c), {'@type': 'WebPage', 'name': title, 'url': c.site_url + path, 'description': desc}]}
    # 2026-11-25: the demo is a phone CALL (no texting wording here) and the intro is short, so on a 390x844 phone the
    # situations and the top of the phone fit on the first screen. Price + 'Hear it live' sit in the blue tile on wider
    # screens; on phones (<=560px, landing.css) that copy is hidden and the same lines show in a tile after the demo.
    price = (f'<p class="hero__price"><span class="from">From</span> <b class="num">{esc(c.tokens["from_price"])}</b>/mo'
             f'<span class="tag"><span data-demo-product>{esc(n0.get("product_name") or "FirstRing")}</span> · {esc(c.tokens["trial_days"])}-day free trial</span></p>')
    live = call_line(c, long=True)
    body = [
        head(c, title=title, desc=desc, path=path, og_image='/assets/og/home-services.png', og_title='Try the AI receptionist', jsonld=ld),
        nav(c, path, {'label': TRIAL_CTA, 'href': cta0, 'niche_cta': True}), '<main id="main">',
        f'''<section class="section section--first" id="demo"><div class="wrap">
<div class="t t--blue shead demo-intro"><p class="eyebrow">Demo</p><h1>Be the <em class="em">caller</em>.<br>Tap what you say.</h1>
<p class="lead">See how the AI answers a call to your business. It's a scripted demo: nothing is really booked.</p>
{price}
{live}</div>
{demo_widget(c, PUBLIC_DEMO_NICHES, contents, cta_href=cta0, cta_label=TRIAL_CTA, switcher=True)}
<div class="t t--blue demo-facts">{price}{live}</div>
<script src="/assets/demo.js" defer></script>
</div></section>''',
        section_band(c, cta0, TRIAL_CTA, '#demo', niche_cta=True),
        '</main>', footer(c, year), '</body>\n</html>\n']
    return '\n'.join(body)


def on_call_tile(c, data):
    """FirstRing hero (design 'Workday'): the dark 'on call' tile. From the clock rows: row 2 = what FirstRing says
    (kicker = its label + time), row 3 = the details it takes (chips; an 'urgent' chip is highlighted), then the demo
    line (tap to call) and the 'Illustration' caption."""
    rows = data['rows']
    say, got = rows[1], rows[2]
    chips = ''.join(('<li class="is-hot">' if re.search(r'urgent', x, re.I) else '<li>') + esc(x) + '</li>'
                    for x in c.plain(got['b']).split(' · '))
    return f'''<figure class="t t--ink oncall" aria-label="{esc(c.plain(data['caption']))}">
<p class="oncall__k"><span class="oncall__dot" aria-hidden="true"></span>{c.h(say['a'])} · <time>{esc(say['t'])}</time></p>
<blockquote class="oncall__q">{c.h(say['b'])}</blockquote>
<ul class="oncall__chips" aria-label="{esc(c.plain(got['a']))}">{chips}</ul>
{call_line(c)}
<figcaption class="oncall__cap">{c.h(data['caption'])}</figcaption>
</figure>'''


def calendar_tile(c, data):
    """FirstRing hero: the 'on your calendar' tile = the booked clock row as a calendar slot ('when · what · note')."""
    r = next(x for x in data['rows'] if x.get('booked'))
    parts = c.plain(r['b']).split(' · ')
    when, what, note = (parts + ['', ''])[:3]
    slot = f'<b>{esc(what)}</b><span>{esc(when)}</span>' if what else f'<b>{esc(when)}</b>'
    note_html = f'<p class="caltile__note"><span class="caltile__ic">{ICONS["mail"]}</span>{esc(note[:1].upper() + note[1:])}</p>' if note else ''
    return f'''<div class="t caltile"><p class="t__k">{c.h(r['a'])}</p><div class="slot">{slot}</div>{note_html}</div>'''


def firstring_page(c, fr, contents, year, *, path='/firstring/'):
    """/firstring/: FirstRing by AI Lab Pro, the flagship product page (2026-11-23). It is the former home page (the
    lighter version from 2026-10-29) cut down and renamed: hero (price, quote button, demo line, call thread), the three
    kinds of calls, the scripted demo, one price card with three FAQs beside it, and the closing band. The purchase path is unchanged
    (/start/?offer=RCP&niche=home_services); every detail stays one link away at /home-services/. The demo, the price and
    the clock styling come from the home-services page and the price book."""
    key = fr['based_on']
    n = contents[key]
    c.page = {k: v for k, v in (n.get('page_tokens') or {}).items()}
    c.page.setdefault('assistant', 'receptionist')
    c.page['tagline'] = c.t(fr['tagline'])
    cta_href = '#pricing'  # v2.0: the main buttons lead to the three plans; each plan has its own "Start free trial"
    cta_label = c.t(fr['hero']['cta'])
    faqs = faq_items(c, fr['faq'], sizes=(3,))
    hero, cl, pr, d = fr['hero'], fr['calls'], fr['pricing'], fr['demo']
    seo = fr['seo']
    title, desc = c.t(seo['title']), c.t(seo['description'])
    ld = {'@context': 'https://schema.org', '@graph': [
        org_ld(c),
        plans_ld(c, fr['product'], desc, c.site_url + path, n['seo']['service_type'], n['seo']['audience']),
        faq_ld(faqs)]}
    calls = ''.join(f'<li class="t"><span class="calls__ic">{ICONS[x["icon"]]}</span><h3>{c.h(x["title"])}</h3><p>{c.h(x["text"])}</p></li>'
                    for x in cl['items'])
    gets = ''.join(f'<li><span class="calls__ic">{ICONS[x["icon"]]}</span>{c.h(x["text"])}</li>' for x in cl['you_get'])
    faq_list = ''.join(f'<details><summary>{esc(q)}</summary><div><p>{esc(a)}</p></div></details>' for q, a in faqs)
    tk = c.tokens
    body = [
        head(c, title=title, desc=desc, path=path, og_image='/assets/og/firstring.png', og_title=c.t(seo['og_title']), jsonld=ld),
        nav(c, path, {'label': TRIAL_CTA, 'href': cta_href}),
        '<main id="main">',
        f'''<section class="hero hero--fr"><div class="wrap hero__grid bento">
<div class="t t--blue hero__copy">
<p class="eyebrow">{c.h(hero['eyebrow'])}</p>
<div class="hero__main">
<h1>{c.h(hero['title'])}</h1>
<p class="lead">{c.h(hero['lead'])}</p>
<div class="btn-row"><a class="btn btn--primary" href="{esc(cta_href)}">{esc(cta_label)}</a><a class="btn btn--link" href="#demo" data-ev="demo_start">{c.h(hero['secondary'])}</a></div>
<p class="hero__fine">{c.h(hero['fine'])}</p>
</div>
</div>
{on_call_tile(c, fr['clock'])}
<div class="t t--sun pricetile"><p class="pricetile__big"><span class="from">From</span><b class="num">{esc(tk['from_price'])}</b><span>/mo</span></p><p class="pricetile__sub"><b>{esc(tk['trial_days'])}-day free trial</b></p><p class="pricetile__fine">No setup fee · cancel anytime</p></div>
{calendar_tile(c, fr['clock'])}
<div class="calls-wrap" id="calls"><h2 class="sr-only">{esc(c.plain(cl['title']))}</h2>
<ol class="calls">{calls}</ol>
<div class="t calls__get"><p class="calls__k">{c.h(cl['you_get_title'])}</p><ul>{gets}</ul></div></div>
</div></section>''',
        f'''<section class="section" id="demo"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(d['eyebrow'])}</p><h2>{c.h(d['title'])}</h2><p class="lead">{c.h(d['lead'])}</p></div>
{demo_widget(c, [key], contents, cta_href=cta_href, cta_label=cta_label, transcript_=False)}
<script src="/assets/demo.js" defer></script>
</div></section>''',
        section_plans(c, pr, niche=key, link_niche=key,
                      after=f'''<div class="pricing pricing--after"><div class="faq" id="faq">{faq_list}</div>
<div class="pricing__side"><p class="small"><a href="{esc(fr['full_page'])}">{c.h(pr['full_page_link'])}</a></p>{video_call_box(c)}</div></div>'''),
        section_band(c, cta_href, cta_label, demo_href=None, band=fr['band']),
        '</main>', plans_mbar(c, cta_href, cta_label), footer(c, year), '</body>\n</html>\n']
    return '\n'.join(body)


AREA_ICONS = {
    'service': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13v-1a8 8 0 0116 0v1"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/><path d="M19 19c0 1.5-2 2.5-5 2.5"/></svg>',
    'sales': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
    'operations': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
}


def house_page(c, h, year, *, signup_href, path='/'):
    """/ (2026-11-23): AI Lab Pro as the house brand. Hero: one headline, one line, one button to FirstRing, and the live
    demo line as a call card (tap to call). The yellow FirstRing tile's button (2026-11-25) is the sign-up button
    ("See my price", signup_href = the same purchase path as /firstring/, data-ev quote_start), so the fold never shows
    "Meet FirstRing" twice. Then the three areas (Service with FirstRing featured, Sales, Operations): only
    what the price book sells today carries a price; anything else is a 'by request' line. Three trust points, closing
    band. No demo widget, no reviews, no client names (owner decision pending; slot between #areas and #trust)."""
    c.page = {'tagline': c.t(h['tagline'])}
    mail = c.brand.get('support_email', '')
    seo, hero, call, ar = h['seo'], h['hero'], h['call'], h['areas']
    title, desc = c.t(seo['title']), c.t(seo['description'])
    ld = {'@context': 'https://schema.org', '@graph': [
        org_ld(c), {'@type': 'WebSite', 'name': c.brand['name'], 'url': c.site_url + '/', 'publisher': {'@id': c.site_url + '/#org'}},
        plans_ld(c, 'FirstRing', c.t(ar['service']['feature']['text']), c.site_url + '/', ar['service']['feature']['service_type'],
                 ar['service']['feature']['audience'])]}
    # call card: the demo phone line (brand.json demo.*); hidden entirely when the number is not configured
    dp = c.brand.get('demo') or {}
    num, e164 = str(dp.get('phone_number') or ''), str(dp.get('phone_e164') or '')
    card = ''
    if num and re.fullmatch(r'\+1\d{10}', e164):
        biz, city = dp.get('phone_business') or '', dp.get('phone_city') or ''
        card = f'''<aside class="t t--ink ring" aria-label="{esc(c.t(call['kicker']))}">
<p class="ring__k"><span class="ring__dot" aria-hidden="true"></span>{c.h(call['kicker'])}</p>
<div class="ring__who"><span class="ring__av" aria-hidden="true">{esc(biz[:1])}<i></i><i></i></span><span><b>{esc(biz)}</b><small>{c.h(call['tag'])}{(' · ' + esc(city)) if city else ''}</small></span></div>
<a class="ring__num num" href="tel:{esc(e164)}" data-ev="demo_call">{esc(num)}</a>
<a class="btn ring__btn" href="tel:{esc(e164)}" data-ev="demo_call"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2"/></svg>{c.h(call['button'])}</a>
<p class="ring__fine">{c.h(call['fine'])}</p>
</aside>'''

    def mini(items):
        out = []
        for x in items:
            href = (x.get('href') or '').replace('{support_email}', mail)
            txt = f'<b>{c.h(x["title"])}</b><span>{c.h(x["text"])}</span>'
            if href and x.get('link'):  # a line with its own short link ("Talk to us")
                out.append(f'<li class="mini__ask">{txt}<a class="mini__link" href="{esc(href)}">{c.h(x["link"])} <span aria-hidden="true">&rarr;</span></a></li>')
            elif href:
                out.append(f'<li><a class="mini__go" href="{esc(href)}">{txt}<span class="mini__arrow" aria-hidden="true">&rarr;</span></a></li>')
            else:
                out.append(f'<li>{txt}</li>')
        return '<ul class="mini">' + ''.join(out) + '</ul>'

    def area_head(k, n_):
        return f'<h3 class="area__k"><span class="area__ic">{AREA_ICONS[k]}</span><span class="area__n">0{n_}</span>{c.h(ar[k]["label"])}</h3>'

    f = ar['service']['feature']
    chips = ''.join(f'<li>{c.h(x)}</li>' for x in f['chips'])
    feature = f'''<article class="t t--sun feat{'' if card else ' feat--tall'}">
<div class="feat__top"><span class="badge">{c.h(f['badge'])}</span><span class="feat__kicker">{c.h(f['kicker'])}</span></div>
<h2 class="feat__name">{c.h(f['name'])}<small>{c.h(f['by'])}</small></h2>
<p class="feat__text">{c.h(f['text'])}</p>
<ul class="feat__chips" aria-label="Calls it handles">{chips}</ul>
<div class="feat__foot"><p class="feat__price">From <b class="num">{esc(c.tokens['from_price'])}</b>/mo · {esc(c.tokens['trial_days'])}-day free trial</p>
<a class="btn btn--primary" href="{esc(signup_href)}">{c.h(f['cta'])}</a></div>
</article>'''
    # the Service tile below the hero lists FirstRing as a line (the big card is in the hero) plus the service items
    fr_line = {'title': f['name'], 'text': f['kicker'], 'href': f['href']}
    trust = ''.join(f'<li><b>{c.h(x["title"])}</b><span>{c.h(x["text"])}</span></li>' for x in h['trust'])
    b = h['band']
    body = [
        head(c, title=title, desc=desc, path=path, og_image='/assets/og/home.png', og_title=c.t(seo['og_title']), jsonld=ld),
        nav(c, path),
        '<main id="main">',
        f'''<section class="hero hero--house"><div class="wrap hero__grid bento">
<div class="t t--blue hero__copy">
<p class="eyebrow">{c.h(hero['eyebrow'])}</p>
<div class="hero__main">
<h1>{c.h(hero['title'])}</h1>
<p class="lead">{c.h(hero['lead'])}</p>
<div class="btn-row"><a class="btn btn--primary" href="{esc(hero['cta_href'])}">{c.h(hero['cta'])}</a><a class="btn btn--link" href="{esc(b['secondary_href'])}" data-ev="demo_start">{c.h(b['secondary'])}</a></div>
</div>
</div>
{card}
{feature}
</div></section>''',
        f'''<section class="section" id="areas"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(ar['eyebrow'])}</p><h2>{c.h(ar['title'])}</h2></div>
<div class="areas">
<article class="t area area--service">{area_head('service', 1)}{mini([fr_line] + ar['service']['items'])}</article>
<article class="t area">{area_head('sales', 2)}{mini(ar['sales']['items'])}</article>
<article class="t area">{area_head('operations', 3)}{mini(ar['operations']['items'])}</article>
</div>
</div></section>''',
        # v2.0 (2026-11-25): FirstRing's three monthly plans on the home page too (no niche in the sign-up link)
        section_plans(c, h['pricing'], niche='home_services', link_niche=None, product='FirstRing'),
        f'''<section class="section" id="trust"><div class="wrap">
<ul class="trust3">{trust}</ul>
</div></section>''',
        f'''<section class="section section--amber band"><div class="wrap">
<h2>{c.h(b['title'])}</h2><p style="margin-top:12px">{c.h(b['text'])}</p>
<div class="btn-row"><a class="btn btn--primary" href="{esc(hero['cta_href'])}">{c.h(b['cta'])}</a><a class="btn" href="{esc(b['secondary_href'])}" data-ev="demo_start">{c.h(b['secondary'])}</a></div>
</div></section>''',
        '</main>', footer(c, year), '</body>\n</html>\n']
    return '\n'.join(body)


def sitemap(c, paths):
    urls = ''.join(f'<url><loc>{esc(c.site_url + p)}</loc></url>' for p in paths)
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<!-- {MARK} -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>\n'


def robots(c):
    return (f'# {MARK}\nUser-agent: *\nAllow: /\nDisallow: /_content/\nDisallow: /_styleguide/\nDisallow: /start/\n'
            f'Disallow: /quote/\n\nSitemap: {c.site_url}/sitemap.xml\n')


# ---------------------------------------------------------------- OG images
OG_HTML = '''<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="{font}">
<style>*{{margin:0;box-sizing:border-box}}body{{width:1200px;height:630px;background:{bg};color:{ink};font-family:'Inter',sans-serif;padding:36px;display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:18px;overflow:hidden}}
.t{{border-radius:34px;padding:44px}}.main{{background:{blue};color:#fff;display:flex;flex-direction:column;justify-content:space-between}}
.k{{font-size:21px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.86)}}
h1{{font-family:'Bricolage Grotesque',sans-serif;font-size:84px;line-height:.94;font-weight:800;letter-spacing:-.045em}}h1 em{{font-style:normal;color:{sun}}}
.side{{display:grid;gap:18px;grid-template-rows:{rows}}}.p{{background:{sun};display:flex;flex-direction:column;justify-content:flex-end;padding:36px}}
.p b{{font-family:'Bricolage Grotesque',sans-serif;font-size:60px;white-space:nowrap;line-height:1;letter-spacing:-.04em;font-weight:800}}.p span{{font-size:24px;font-weight:600;margin-top:8px}}
.b{{background:{ink};color:#fff;display:flex;flex-direction:column;justify-content:space-between;padding:36px}}.b img{{width:64px;height:64px}}
.b p{{font-family:'Bricolage Grotesque',sans-serif;font-size:42px;font-weight:800;letter-spacing:-.03em;line-height:1}}.b small{{display:block;margin-top:8px;font-family:'Inter',sans-serif;font-size:18px;font-weight:600;letter-spacing:.16em;color:{sun}}}</style></head>
<body><div class="t main"><div class="k">{kicker}</div><h1>{title}</h1></div><div class="side">{price}<div class="t b"><img src="{gem}" alt=""><p>{brand}<small>US</small></p></div></div></body></html>'''


def render_og(c, specs):
    out_dir = os.path.join(SITE, 'assets', 'og')
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    import base64
    with open(os.path.join(SITE, 'assets', 'gem-128.png'), 'rb') as fh:
        gem = 'data:image/png;base64,' + base64.b64encode(fh.read()).decode()
    for slug, kicker, title, code in specs:
        th = c.brand['landing_theme']
        price = ''
        if code == 'PLANS':  # FirstRing monthly plans (v2.0): lowest monthly + the free trial
            price = f'<div class="t p"><span>From</span><b>{esc(c.tokens["from_price"])}/mo</b><span>{esc(c.tokens["trial_days"])}-day free trial</span></div>'
        elif code:  # None = no price tile (the house-brand home page)
            i = c.items[code]
            price = f'<div class="t p"><b>{money(i["monthly_cents"])}/mo</b><span>after {money(i["setup_cents"])} setup</span></div>'
        title_html = re.sub(r'<em class="em">(.*?)</em>', r'<em>\1</em>', c.h(title))
        doc = OG_HTML.format(font=esc(landing_fonts(c)), kicker=esc(kicker), title=title_html, price=price,
                             rows='1fr 1fr' if price else '1fr', brand=esc(c.brand['name']), gem=gem,
                             bg=th['bg'], ink=th['ink'], blue=th['blue'], sun=th['sun'])
        jobs.append({'html': doc, 'out': os.path.join(out_dir, f'{slug}.png')})
    script = r'''
import { chromium } from 'playwright';
const jobs = JSON.parse(process.argv[1]);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
for (const j of jobs) { await p.setContent(j.html, { waitUntil: 'networkidle' }); await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: j.out }); console.log('og: ' + j.out); }
await b.close();
'''
    r = subprocess.run(['node', '--input-type=module', '-e', script, json.dumps(jobs)], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print('build_landing: OG render failed (run `npm install`?):\n' + r.stderr[-800:])
    else:
        print(r.stdout.strip())


# ---------------------------------------------------------------- legal pages (hand-written, values stamped from config)
LEGAL_PAGES = ['legal/terms/index.html', 'legal/service-agreement/index.html', 'legal/privacy/index.html', 'legal/refund/index.html']
# any <span> carrying data-cfg, also with other attributes first (e.g. <span class="mono" data-cfg="brand:agreement_version">)
CFG_RX = re.compile(r'(<span\b[^>]*?\bdata-cfg="(pricebook|brand):([A-Za-z0-9_.]+)"[^>]*>)(.*?)(</span>)', re.S)
BANNER_RX = re.compile(r'(<div class="draft-banner" role="note")(?: hidden)?>')
BANNER_FULL_RX = re.compile(r'\s*<div class="draft-banner" role="note"(?: hidden)?>.*?</div>', re.S)


def cfg_value(c, src, path):
    v = c.pb if src == 'pricebook' else c.brand
    for k in path.split('.'):
        if not isinstance(v, dict) or k not in v:
            raise SystemExit(f'build_landing: legal data-cfg "{src}:{path}" not found in config')
        v = v[k]
    if isinstance(v, bool) or not isinstance(v, (str, int)) or v == '':
        raise SystemExit(f'build_landing: legal data-cfg "{src}:{path}" is not a non-empty string/number')
    return f'{v:,}' if isinstance(v, int) else str(v)


def stamp_legal(c):
    """site/legal/* are written by hand; every <span data-cfg="pricebook:a.b">…</span> / "brand:a.b" is re-filled from config
    here (refund windows, the satisfaction guarantee, quote SLA, business days, entity, address, governing law, version), so
    the text never drifts from the config. The DRAFT banner gets `hidden` exactly when brand.json legal_final is true."""
    out = {}
    for rel in LEGAL_PAGES:
        p = os.path.join(SITE, rel)
        if not os.path.exists(p):
            continue
        cur = open(p, encoding='utf-8').read()
        cur = CFG_RX.sub(lambda m: m.group(1) + esc(cfg_value(c, m.group(2), m.group(3))) + m.group(5), cur)
        # DRAFT banner: hidden in the static HTML exactly when brand.json "legal_final" is true (legal.js does the same).
        if c.brand.get('legal_final') is True:
            # final: drop the banner from the static HTML entirely (a hidden "DRAFT" string still shows up to text scrapers,
            # e.g. carrier reviewers checking the privacy/terms links for SMS registration)
            cur = BANNER_FULL_RX.sub('', cur)
        else:
            cur = BANNER_RX.sub(lambda m: m.group(1) + '>', cur)
        out[rel] = cur
    return out


# ---------------------------------------------------------------- main
def build(c):
    contents = {k: load(os.path.join(CONTENT, f)) for k, f in NICHE_FILES.items()}
    c.brand_niche_label = lambda k: next((x['label'] for x in c.brand['niches'] if x['key'] == k), k)
    for k, n in contents.items():
        validate_demo(k, n['demo'])
    website = load(os.path.join(CONTENT, 'website.json'))
    home = load(os.path.join(CONTENT, 'home.json'))
    firstring = load(os.path.join(CONTENT, 'firstring.json'))
    c.reviews = load(os.path.join(CONTENT, 'reviews.json'))
    year = c.pb.get('updated', '2026')[:4]
    pages = {
        'index.html': house_page(c, home, year, signup_href='#pricing'),
        'firstring/index.html': firstring_page(c, firstring, contents, year),
        'home-services/index.html': niche_page(c, 'home_services', contents, path='/home-services/', year=year),
        'real-estate/index.html': niche_page(c, 'real_estate', contents, path='/real-estate/', year=year),
        'website/index.html': website_page(c, website, year),
        'demo/index.html': demo_page(c, contents, year),
    }
    indexed = ['/', '/firstring/', '/home-services/', '/real-estate/', '/website/', '/demo/']
    pages['sitemap.xml'] = sitemap(c, indexed)
    pages['robots.txt'] = robots(c)
    og = [(contents[k]['slug'], c.t(contents[k]['seo']['og_kicker']), c.t(contents[k]['seo']['og_title']), 'PLANS') for k in NICHE_FILES]
    og.append(('website', c.t(website['seo']['og_kicker']), c.t(website['seo']['og_title']), 'WEB'))
    og.append(('firstring', c.t(firstring['seo']['og_kicker']), c.t(firstring['seo']['og_title']), 'PLANS'))
    og.append(('home', c.t(home['hero']['eyebrow']), c.t(home['seo']['og_title']), None))
    return pages, og


def main(argv):
    c = Ctx()
    pages, og = build(c)
    if '--list' in argv:
        base = argv[argv.index('--list') + 1] if len(argv) > argv.index('--list') + 1 else 'http://localhost:8787'
        for rel in pages:
            if rel.endswith('.html'):
                print(base.rstrip('/') + '/' + rel.replace('index.html', ''))
        return 0
    legal = stamp_legal(c)
    # cache busting: every local <script src> / <link rel=stylesheet> carries ?v=<content hash> (tools/asset_version.py)
    pages, legal = asset_version.stamp_pages(pages), asset_version.stamp_pages(legal)
    if '--check' in argv:
        bad = 0
        for d in theme_drift(c):
            bad += 1
            print('THEME  ' + d)
        for rel, text in legal.items():
            if open(os.path.join(SITE, rel), encoding='utf-8').read() != text:
                bad += 1
                print(f'DIFF  site/{rel} (data-cfg values out of date)')
        for rel, text in pages.items():
            visible = re.sub(r'<(script|style)\b.*?</\1>', '', text, flags=re.S)  # demo JSON keeps its own {vars}; CSS braces
            raw = sorted(set(re.findall(r'\{[a-z][a-z0-9_]*(?::[A-Z0-9_.-]+)?\}', visible)))
            if raw:
                bad += 1
                print(f'RAW TOKENS  site/{rel}: {" ".join(raw)}')
            p = os.path.join(SITE, rel)
            cur = open(p, encoding='utf-8').read() if os.path.exists(p) else None
            if cur != text:
                bad += 1
                print(f'DIFF  site/{rel}' + (' (missing)' if cur is None else ''))
        print(f'build_landing --check: {len(pages) + len(legal)} files, {bad} differ')
        return 1 if bad else 0
    for rel, text in legal.items():
        p = os.path.join(SITE, rel)
        if open(p, encoding='utf-8').read() != text:
            with open(p, 'w', encoding='utf-8') as fh:
                fh.write(text)
            print(f'stamped site/{rel}')
    drift = theme_drift(c)
    if drift:
        raise SystemExit('build_landing: theme drift between config/brand.json and base.css:\n  ' + '\n  '.join(drift))
    for rel, text in pages.items():
        p = os.path.join(SITE, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as fh:
            fh.write(text)
        print(f'wrote site/{rel}')
    asset_version.main([])   # the hand-written pages too (portal, quote, admin, demo site, styleguide)
    missing = [s for s in og if not os.path.exists(os.path.join(SITE, 'assets', 'og', s[0] + '.png'))]
    if '--og' in argv:
        render_og(c, og)
    elif missing:
        render_og(c, missing)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
