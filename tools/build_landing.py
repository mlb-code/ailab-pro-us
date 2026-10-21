"""Build the public landing pages from config + content. Stdlib only. Never edit the generated HTML by hand.

Inputs : config/brand.json, config/pricebook.json, site/_content/{_shared,home-services,real-estate,website,reviews}.json
Outputs: site/index.html (home services), site/home-services/, site/real-estate/,
         site/website/, site/demo/, site/sitemap.xml, site/robots.txt, site/assets/og/*.png (only with --og or when missing)

usage:
  python3 tools/build_landing.py            build (renders missing OG images with Playwright)
  python3 tools/build_landing.py --check    rebuild in memory; exit 1 if any generated text file differs (no writes)
  python3 tools/build_landing.py --og       force re-render of the OG images (needs `npm install`)
  python3 tools/build_landing.py --list     print the URLs of every generated page (used by tools/urls-landing.txt)

Legal pages (site/legal/*/index.html) are hand-written; their <span data-cfg="pricebook:path"> / "brand:path" values are
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
        # usage text: config wins (A3 may add rules.usage_policy.text), else content fallback
        usage = (rules.get('usage_policy') or {}).get('text') or self.shared['usage_text_fallback']
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
        return re.sub(r'\{([a-z][a-z0-9_]*(?::[A-Z0-9-]+(?:\.[a-z]+)?)?)\}', sub, s)

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


def theme_drift(c):
    """config/brand.json theme must equal the :root values in site/assets/base.css (one palette, two files)."""
    with open(os.path.join(SITE, 'assets', 'base.css'), encoding='utf-8') as fh:
        css = fh.read()
    out = []
    for k, var in THEME_VARS.items():
        want = (c.brand.get('theme') or {}).get(k, '')
        m = re.search(re.escape(var) + r':(#[0-9A-Fa-f]{6})\b', css)
        if not m or m.group(1).upper() != want.upper():
            out.append(f'{var} = {m.group(1) if m else "missing"} in base.css, brand.json theme.{k} = {want or "missing"}')
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
}


def analytics(c):
    a = c.brand.get('analytics', {})
    out = []
    guard = "!/^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname)"
    if a.get('ga4_id'):
        gid = esc(a['ga4_id'])
        out.append(f'<script async src="https://www.googletagmanager.com/gtag/js?id={gid}"></script>')
        out.append(f"<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments)}}if({guard}){{gtag('js',new Date());gtag('config','{gid}');}}</script>")
    if a.get('clarity_id'):
        cid = esc(a['clarity_id'])
        out.append('<script>if(' + guard + '){(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","' + cid + '");}</script>')
    return '\n'.join(out)


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
<meta name="theme-color" content="{esc(c.brand['theme']['ink'])}">
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
<link rel="stylesheet" href="{esc(c.brand['fonts']['google_css'])}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="{esc(c.brand['fonts']['google_css'])}"></noscript>
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
    cta = cta or {'label': 'Get a quote', 'href': '/start/?offer=RCP', 'ev': 'quote_start'}
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


def founder_slot(c):
    """Reserved: shown only when brand.json has "show_founder_price": true (owner has not approved yet)."""
    if not c.brand.get('show_founder_price'):
        return ''
    return f'<p class="notice">{c.h(c.shared["founder"]["text"])}</p>'


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


def section_missed(c, steps, sms_note=True):
    m = c.shared['missed']
    lis = ''.join(
        f'<li><span class="n">0{n + 1}</span>{ICONS[s["icon"]]}<h3>{c.h(s["title"])}</h3><p>{c.h(s["text"])}</p></li>'
        for n, s in enumerate(steps))
    note = f'<p class="small muted" style="margin-top:20px">{c.h(c.shared["sms_note"])}</p>' if sms_note else ''
    return f'''<section class="section" id="how-it-answers"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(m['eyebrow'])}</p><h2>{c.h(m['title'])}</h2></div>
<ol class="steps3">{lis}</ol>{note}
</div></section>'''


def section_why(c):
    """Dark "why" block on a square grid: three cited stats (number, label, line, source under each card). Numbers count
    up once in view (landing.js, motion only); the final value is always the DOM text."""
    w = c.shared['why']
    cards = []
    for s_ in w['stats']:
        if not (s_.get('source') and s_.get('source_url', '').startswith('https://')):
            raise SystemExit('build_landing: every why.stats entry needs source + https source_url (no uncited numbers)')
        cards.append(f'<li class="stat"><p class="stat__num num" data-count>{esc(s_["num"])}</p><h3>{c.h(s_["label"])}</h3>'
                     f'<p>{c.h(s_["text"])}</p><p class="stat__src">Source: <a href="{esc(s_["source_url"])}" rel="noopener nofollow">{esc(s_["source"])}</a></p></li>')
    return f'''<section class="section why" id="why"><div class="wrap">
<div class="shead shead--c"><p class="eyebrow">{c.h(w['eyebrow'])}</p><h2>{c.h(w['title'])}</h2><p class="lead">{c.h(w['lead'])}</p></div>
<ul class="stats">{''.join(cards)}</ul>
<p class="why__pill"><span class="why__dots" aria-hidden="true"><i></i><i></i><i></i></span>{c.h(w['pill'])}</p>
</div></section>'''


def sample_cards(c, keys, contents, rv):
    """Two honest "Sample" cards per demo scenario: the first exchange, and the booking confirmation (from the scripted demo)."""
    out = []
    for k in keys:
        d = contents[k]['demo']
        for scn in d['scenarios']:
            path = demo_paths(scn)[0]
            first = path[0]
            reply = scn['nodes'][first['next']].get('bot', [''])[0]
            vars_ = {}
            for ch in path:
                vars_.update(ch.get('set', {}))
            done = next(n for n in scn['nodes'].values() if n.get('booked'))
            final = fill_vars((done.get('bot') or [''])[0], vars_)
            ai = c.t(rv['assistant'])
            for lines in ([(rv['caller'], first['say']), (ai, fill_vars(reply, vars_))], [(ai, final)]):
                if not lines[-1][1]:
                    continue
                body = ''.join(f'<p><span class="rv__k">{esc(w)}</span>{esc(t)}</p>' for w, t in lines)
                out.append(f'<figure class="rv rv--sample"><div class="rv__head"><span class="rv__av" aria-hidden="true">{esc(d["business"][:1])}</span>'
                           f'<span class="rv__who"><b>{esc(d["business"])}</b><small>{esc(rv["sample_sub"])} · {esc(scn["label"])}</small></span>'
                           f'<span class="rv__tag">{esc(rv["sample_tag"])}</span></div><blockquote class="rv__body">{body}</blockquote></figure>')
    return out


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


def section_reviews(c, key, contents):
    """Two sections. 1) "What a call sounds like": sample cards from this page's demo, always shown, labeled Sample
    (a product demo, not social proof). 2) "What clients say": real reviews, only with >= REVIEWS_MIN approved ones;
    otherwise omitted entirely (no empty "your review here" placeholders)."""
    rv = c.reviews
    sm = rv['samples']
    samples = sample_cards(c, [key], contents, rv)  # this page's niche only (on-topic; real estate never says "receptionist")
    out = f'''<section class="section reviews" id="sample-calls"><div class="wrap">
<div class="shead shead--c"><p class="eyebrow">{c.h(sm['eyebrow'])}</p><h2>{c.h(sm['title'])}</h2><p class="lead">{c.h(sm['lead'])}</p></div>
</div>
<div class="rvrows">{marquee_row(samples[0::2])}{marquee_row(samples[1::2], reverse=True)}</div>
</section>'''
    real = review_cards(c, rv)
    if len(real) >= REVIEWS_MIN:
        out += f'''
<section class="section reviews" id="reviews"><div class="wrap">
<div class="shead shead--c"><p class="eyebrow">{c.h(rv['eyebrow'])}</p><h2>{c.h(rv['title'])}</h2><p class="lead">{c.h(rv['lead'])}</p></div>
</div>
<div class="rvrows">{marquee_row(real)}</div>
</section>'''
    return out


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


def demo_payload(c, keys, contents):
    data = {}
    for k in keys:
        d = contents[k]['demo']
        n = contents[k]
        data[k] = {'label': c.brand_niche_label(k), 'business': d['business'], 'line': d['business_line'],
                   'product': n.get('product_name') or c.items[n['offer']]['name'],
                   'cta': f'/start/?offer={n["offer"]}&niche={k}', 'scenarios': d['scenarios']}
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')


def demo_widget(c, keys, contents, *, cta_href, cta_label, switcher=False):
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
{sw}
<p class="small muted">Pick a situation:</p>
<div class="demo__picks" role="group" aria-label="Demo scenarios">{picks}</div>
{transcript(c, first)}
</div>
<div class="phone">
<div class="phone__bar"><span class="phone__av" aria-hidden="true">{av}</span><span class="phone__who"><b data-demo-biz>{esc(first['business'])}</b><span data-demo-line>{esc(first['business_line'])} · AI assistant</span></span></div>
<p class="phone__demo">{esc(note)}</p>
<div class="chat" data-demo-chat aria-live="polite" aria-label="Demo conversation">
<p class="bubble bubble--system">Pick a situation to start. You play the customer.</p>
</div>
<div class="demo__end" data-demo-end hidden><button type="button" class="btn btn--ghost btn--sm" data-demo-restart>Try another situation</button><a class="btn btn--primary btn--sm" href="{esc(cta_href)}" data-ev="quote_start" data-niche-cta>{esc(cta_label)}</a></div>
</div>
<script type="application/json" data-demo-data>{demo_payload(c, keys, contents)}</script>
<p class="sr-only" data-demo-note>{esc(note)}</p>
</div>'''


# ---------------------------------------------------------------- sections
def section_demo(c, key, contents, cta_href, cta_label):
    d = contents[key]['demo']
    return f'''<section class="section" id="demo"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(d['eyebrow'])}</p><h2>{c.h(d['title'])}</h2><p class="lead">{c.h(d['lead'])}</p></div>
{demo_widget(c, [key], contents, cta_href=cta_href, cta_label=cta_label)}
<script src="/assets/demo.js" defer></script>
</div></section>'''


def includes_list(c, code):
    out = []
    for s in c.items[code]['includes']:
        if s.lower().startswith('included usage'):
            s = c.tokens['usage_text']
        out.append(f'<li>{esc(s)}</li>')
    return ''.join(out)


ADDON_SUFFIX = re.compile(r' \(add-on [A-Z0-9-]+\)$')  # price-book code suffix: machine-readable, shown as plain words


def excludes_list(c, code):
    return ''.join(f'<li>{esc(ADDON_SUFFIX.sub(" (extra, fixed price)", s))}</li>' for s in c.items[code]['excludes']
                   if not s.lower().startswith('usage above'))


def tool_status(c, key):
    v = c.pb['integrations'].get(key, 'custom')
    if v == 'native':
        return 'is-native', 'Included'
    if v == 'zapier':
        return 'is-zap', 'Via Zapier · included'
    if v.startswith('addon:'):
        it = c.items[v.split(':', 1)[1]]
        return 'is-addon', f'Extra {money(it["setup_cents"])} + {money(it["monthly_cents"])}/mo'
    return 'is-custom', 'Custom quote'


def niche_includes(c, n):
    """Niche override list (content) or the price-book list for the core offer."""
    if n.get('included_items'):
        return [c.t(x) for x in n['included_items']]
    out = []
    for s_ in c.items[n['offer']]['includes']:
        out.append(c.tokens['usage_text'] if s_.lower().startswith('included usage') else s_)
    return out


def section_included(c, niche_key, inc, n):
    tools = []
    allow = n.get('tools')
    for k, meta in c.pb.get('integration_meta', {}).items():
        if k == 'other' or not ('*' in meta['niches'] or niche_key in meta['niches']):
            continue
        if allow is not None and k not in allow:
            continue
        cls, label = tool_status(c, k)
        tools.append(f'<li class="{cls}"><span>{esc(meta["label"])}</span><span>{esc(label)}</span></li>')
    return f'''<section class="section" id="included"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(inc['eyebrow'])}</p><h2>{c.h(inc['title'])}</h2></div>
<div class="incl">
<div><h3>{esc(n.get('product_name') or c.items['RCP']['name'])}</h3><ul class="ticks">{''.join(f'<li>{esc(x)}</li>' for x in niche_includes(c, n))}</ul>
<p class="small muted" style="margin-top:14px">{c.h(c.shared['sms_note'])}</p>
<details class="more"><summary>Not included</summary><ul class="ticks ticks--no">{excludes_list(c, 'RCP')}</ul></details></div>
<div><h3>{c.h(inc['tools_title'])}</h3><ul class="tools">{''.join(tools)}</ul></div>
</div>
</div></section>'''


def rail(c, steps):
    return '<ol class="rail">' + ''.join(
        f'<li><span class="num">{c.h(s["num"])}</span><h3>{c.h(s["title"])}</h3><p>{c.h(s["text"])}</p></li>' for s in steps) + '</ol>'


def video_call_href(c):
    url = c.brand.get('calendly_url')
    if url:
        return url
    mail = c.brand.get('support_email') or c.brand.get('senders', {}).get('reply_to', '')
    from urllib.parse import quote
    return f'mailto:{mail}?subject=' + quote('15-minute video call') + '&body=' + quote('Hi, I would like a 15-minute video call before choosing. Business name: ')


def video_call_line(c):
    txt = c.h(c.shared['how']['video_call'])
    return f'<p class="how__call">{txt} <a href="{esc(video_call_href(c))}" rel="noopener">Book a video call</a>.</p>'


def video_call_box(c):
    v = c.shared['video_call_box']
    return (f'<p class="notice small"><span><b>{c.h(v["title"])}</b> {c.h(v["text"])} '
            f'<a href="{esc(video_call_href(c))}" rel="noopener">{c.h(v["link"])}</a></span></p>')


def section_how(c, how=None):
    how = how or c.shared['how']
    return f'''<section class="section" id="how"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(how['eyebrow'])}</p><h2>{c.h(how['title'])}</h2>{f'<p class="lead">{c.h(how["lead"])}</p>' if how.get('lead') else ''}</div>
{rail(c, how['steps'])}
{video_call_line(c)}
</div></section>'''


def section_after_pay(c):
    a = c.shared['after_pay']
    return f'''<section class="section" id="after-you-pay"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(a['eyebrow'])}</p><h2>{c.h(a['title'])}</h2><p class="lead">{c.h(a['lead'])}</p></div>
<ol class="rail rail--5" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr))">{''.join(f'<li><span class="num">{c.h(s["num"])}</span><h3>{c.h(s["title"])}</h3><p>{c.h(s["text"])}</p></li>' for s in a['steps'])}</ol>
</div></section>'''


def section_proof(c, rows_override=None):
    p = c.shared['proof']
    rows = ''.join(f'<div class="proof__row"><dt>{c.h(r["k"])}</dt><dd>{c.h(r["v"])}</dd></div>' for r in (rows_override or p['rows']))
    return f'''<section class="section" id="trust"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(p['eyebrow'])}</p><h2>{c.h(p['title'])}</h2></div>
<dl class="proof">{rows}</dl>
<p class="small muted" style="margin-top:16px">* {esc(c.brand['disclaimers']['footer'])}</p>
</div></section>'''


def addons_table(c, core, hide=()):
    rows = []
    for i in c.pb['items']:
        if i['group'] != 'addon' or core not in i['applies_to'] and 'any' not in i['applies_to']:
            continue
        if i['code'] in hide:
            continue
        if i['kind'] == 'percent':
            price = f'+{i["setup_pct"]}% of setup'
        else:
            parts = []
            if i['setup_cents']:
                parts.append(money(i['setup_cents']))
            if i['monthly_cents']:
                parts.append(f'{money(i["monthly_cents"])}/mo')
            price = ' + '.join(parts)
        rows.append(f'<tr><td>{esc(i["name"])}</td><td>{esc(price)}</td></tr>')
    return f'<table class="addons"><caption>Extras, fixed prices</caption><tbody>{"".join(rows)}</tbody></table>'


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


def refund_fine(c, code):
    """Price-card fine print from refund_rules: the satisfaction guarantee for its codes (RCP, BNDL), then the deposit rule."""
    rr = c.pb.get('refund_rules', {})
    g = rr.get('rcp_guarantee', {})
    lines = ([g['text']] if code in g.get('codes', []) and g.get('text') else []) + [rr.get('deposit', {}).get('text', '')]
    return ''.join(f'<p class="price-card__fine">{esc(s)}</p>' for s in lines if s)


def section_pricing(c, pr, code, cta_href, cta_label, *, early=False, bundle_link=True, n=None):
    side = [f'<p>{c.h(pr["note"])}</p>', addons_table(c, code, (n or {}).get('addons_hide', ()))]
    if bundle_link:
        b = c.items['BNDL']
        side.append(f'<p class="small">Need a website too? The <a href="/website/#bundle">{esc((n or {}).get("bundle_name") or b["name"])}</a> is {money(b["setup_cents"])} + {money(b["monthly_cents"])}/mo.</p>')
        side.append(video_call_box(c))
    side.append(f'<p class="small muted">{c.h(c.tokens["usage_text"])}</p>')
    return f'''<section class="section" id="pricing"><div class="wrap">
<div class="shead"><p class="eyebrow">{c.h(pr['eyebrow'])}</p><h2>{c.h(pr['title'])}</h2></div>
<div class="pricing">{price_card(c, code, cta_href, cta_label, early=early, n=n)}<div class="pricing__side">{'' if early else founder_slot(c)}{''.join(side)}</div></div>
</div></section>'''


def faq_items(c, faq):
    out = []
    for f in faq:
        if 'ref' in f:
            f = c.shared['faq'][f['ref']]
        out.append((c.t(f['q']), c.t(f['a'])))
    if len(out) not in (8, 9):
        raise SystemExit(f'FAQ must have 8 or 9 entries, has {len(out)}')
    return out


def section_faq(faqs):
    items = ''.join(f'<details><summary>{esc(q)}</summary><div><p>{esc(a)}</p></div></details>' for q, a in faqs)
    return f'''<section class="section" id="faq"><div class="wrap">
<div class="shead"><p class="eyebrow">FAQ</p><h2>Straight <em class="em">answers</em>.</h2></div>
<div class="faq">{items}</div>
</div></section>'''


def section_band(c, cta_href, cta_label, demo_href='#demo', band=None, niche_cta=False):
    b = band or c.shared['cta_band']
    nc = ' data-niche-cta' if niche_cta else ''
    return f'''<section class="section section--amber band"><div class="wrap">
<h2>{c.h(b['title'])}</h2><p style="margin-top:12px">{c.h(b['text'])}</p>
<div class="btn-row"><a class="btn btn--primary" href="{esc(cta_href)}" data-ev="quote_start"{nc}>{esc(cta_label)}</a><a class="btn" href="{esc(demo_href)}" data-ev="demo_start">Try the demo</a></div>
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
    cta_href = f'/start/?offer={n["offer"]}&niche={key}'
    cta_label = 'Get my fixed quote'
    faqs = faq_items(c, n['faq'])
    canon_url = c.site_url + (canonical or path)
    ld = None
    if index:
        ld = {'@context': 'https://schema.org', '@graph': [
            org_ld(c),
            service_ld(c, n['offer'], n.get('service_name') or c.items[n['offer']]['name'], desc, canon_url,
                       seo['service_type'], seo['audience']),
            faq_ld(faqs)]}
    hero = n['hero']
    if early:
        buttons = '<a class="btn btn--primary" href="#early-access">Join early access</a><a class="btn btn--ghost" href="#demo" data-ev="demo_start">Try the demo</a>'
        badge = '<span class="badge badge--acc badge-early">Early access · not yet available</span>'
        tag = 'Expected price · fixed, in writing'
    else:
        buttons = f'<a class="btn btn--primary" href="{esc(cta_href)}" data-ev="quote_start">{cta_label}</a><a class="btn btn--ghost" href="#demo" data-ev="demo_start">Try the demo</a>'
        badge = ''
        tag = 'Fixed price · in writing · no hourly billing'
    also = f'<p class="small muted">{c.h(hero["also"])}</p>' if hero.get('also') else ''
    body = [
        head(c, title=title, desc=desc, path=path, canonical=canonical, index=index,
             og_image=f'/assets/og/{n["slug"]}.png', og_title=c.t(seo['og_title']), jsonld=ld),
        nav(c, '/' if key == 'home_services' else path,
            {'label': 'Join early access', 'href': '#early-access'} if early else
            {'label': 'Get a quote', 'href': cta_href, 'ev': 'quote_start'}),
        '<main id="main">',
        f'''<section class="hero"><div class="wrap hero__grid">
<div class="hero__copy">{badge}
<p class="eyebrow">{c.h(hero['eyebrow'])}</p>
<h1>{c.h(hero['title'])}</h1>
<p class="lead">{c.h(hero['lead'])}</p>
{price_line(c, n['offer'], tag)}
<div class="btn-row">{buttons}</div>
{call_line(c)}<p class="hero__fine">{c.h(hero['fine'])}</p>{also}
</div>
{clock(c, n['clock'], 'A missed call becomes a booking', n.get('demo'))}
</div></section>''',
        section_why(c),
        section_missed(c, n['missed_steps']),
        section_demo(c, key, contents, '#early-access' if early else cta_href, 'Join early access' if early else cta_label),
        section_included(c, key, n['included'], n),
        section_how(c),
        section_after_pay(c),
        section_proof(c),
        section_reviews(c, key, contents),
        section_pricing(c, n['pricing'], n['offer'], cta_href, cta_label, early=early, bundle_link=not early, n=n),
    ]
    if early:
        body.append(section_early(c, n['early'], key))
    body += [section_faq(faqs)]
    if not early:
        body.append(section_band(c, cta_href, cta_label))
    body += ['</main>', '' if early else mobile_bar(c, n['offer'], cta_href, cta_label), footer(c, year), '</body>\n</html>\n']
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
    href_web, href_b = '/start/?offer=WEB', '/start/?offer=BNDL'
    ld = {'@context': 'https://schema.org', '@graph': [
        org_ld(c), service_ld(c, 'WEB', c.items['WEB']['name'], desc, c.site_url + path, seo['service_type'], seo['audience']),
        faq_ld(faqs)]}
    sheets = ''.join(
        f'<div class="sheet" style="--i:{n}"><b>{esc(p["name"])}</b><i class="w60"></i><span class="blk"></span><span class="cta"></span></div>'
        for n, p in enumerate(w['pages']))
    pages = ''.join(f'<li><b>{esc(p["name"])}</b><span>{c.h(p["line"])}</span></li>' for p in w['pages'])
    hero = w['hero']
    b = c.items['BNDL']
    inc_web = ''.join(f'<li>{esc(s)}</li>' for s in c.items['WEB']['includes'])
    exc_web = excludes_list(c, 'WEB')
    body = [
        head(c, title=title, desc=desc, path=path, og_image='/assets/og/website.png', og_title=c.t(seo['og_title']), jsonld=ld),
        nav(c, path, {'label': 'Choose package', 'href': href_web, 'ev': 'quote_start'}), '<main id="main">',
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
        f'''<section class="section" id="included"><div class="wrap">
<div class="shead"><p class="eyebrow">What's included</p><h2>Built, hosted and kept up to <em class="em">date</em>.</h2></div>
<div class="incl"><div><h3>{esc(c.items['WEB']['name'])}</h3><ul class="ticks">{inc_web}</ul>
<details class="more"><summary>Not included</summary><ul class="ticks ticks--no">{exc_web}</ul></details></div>
<div>{addons_table(c, 'WEB')}<p class="small muted" style="margin-top:12px">Choosing an extra adds a short written quote step.</p></div></div>
</div></section>''',
        section_how(c, w['how']),
        section_proof(c, w['proof_rows']),
        f'''<section class="section" id="pricing"><div class="wrap">
<div class="shead"><p class="eyebrow">Pricing</p><h2>Pick one. The price is <em class="em">final</em>.</h2></div>
<div class="pricing">{price_card(c, 'WEB', href_web, 'Choose this package')}
<div class="bundle" id="bundle"><span class="badge">Bundle</span><h3>{c.h(w['bundle']['title'])}</h3><p>{c.h(w['bundle']['text'])}</p>
<div class="price-card__amount"><b>{money(b['setup_cents'])}</b><span>setup</span><b>{money(b['monthly_cents'])}</b><span>/ month</span></div>
<ul class="price-card__list">{''.join(f'<li>{esc(s)}</li>' for s in b['includes'])}</ul>
<a class="btn btn--ghost" href="{href_b}" data-ev="quote_start">Choose the bundle</a>
<p class="price-card__fine">{c.h(c.shared['sms_note'])}</p>{video_call_box(c)}</div></div>
</div></section>''',
        section_faq(faqs),
        section_band(c, href_web, 'Choose this package', '/demo/', band=w['band']),
        '</main>', mobile_bar(c, 'WEB', href_web, 'Choose this package'), footer(c, year), '</body>\n</html>\n']
    return '\n'.join(body)


def demo_page(c, contents, year):
    path = '/demo/'
    c.page = {}
    k0 = PUBLIC_DEMO_NICHES[0]
    n0 = contents[k0]
    cta0 = f'/start/?offer={n0["offer"]}&niche={k0}'
    i0 = c.items[n0['offer']]
    title = f'Try the AI receptionist demo | {c.brand["name"]}'
    desc = 'A scripted demo of the text conversation after a missed call: home services and real estate. No real booking is made.'
    ld = {'@context': 'https://schema.org', '@graph': [org_ld(c), {'@type': 'WebPage', 'name': title, 'url': c.site_url + path, 'description': desc}]}
    body = [
        head(c, title=title, desc=desc, path=path, og_image='/assets/og/home-services.png', og_title='Try the AI receptionist', jsonld=ld),
        nav(c, path, {'label': 'Get a quote', 'href': cta0, 'ev': 'quote_start', 'niche_cta': True}), '<main id="main">',
        f'''<section class="section" id="demo"><div class="wrap">
<div class="shead"><p class="eyebrow">Demo</p><h1 style="font-size:clamp(2.1rem,5vw,3.6rem)">Be the <em class="em">customer</em>. Tap the replies.</h1>
<p class="lead">This is what a caller gets after a missed call: a text from your AI assistant, a few quick questions, and a booked time. The answers are set in advance. {esc(c.brand['disclaimers']['demo'])}.</p>
<p class="hero__price"><b class="num">{money(i0['setup_cents'])}</b> setup <span class="plus">+</span> <b class="num">{money(i0['monthly_cents'])}</b>/mo<span class="tag"><span data-demo-product>{esc(n0.get('product_name') or i0['name'])}</span> · fixed price, in writing</span></p>
{call_line(c, long=True)}</div>
{demo_widget(c, PUBLIC_DEMO_NICHES, contents, cta_href=cta0, cta_label='Get my fixed quote', switcher=True)}
<script src="/assets/demo.js" defer></script>
</div></section>''',
        section_band(c, cta0, 'Get my fixed quote', '#demo', niche_cta=True),
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
<style>*{{margin:0;box-sizing:border-box}}body{{width:1200px;height:630px;background:{ink};color:{paper};font-family:'Noto Sans',sans-serif;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}}
body:before{{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(242,240,247,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(242,240,247,.06) 1px,transparent 1px);background-size:60px 60px;-webkit-mask-image:radial-gradient(70% 90% at 80% 20%,#000,transparent)}}
body:after{{content:"";position:absolute;right:-200px;top:-260px;width:820px;height:820px;border-radius:50%;background:radial-gradient(closest-side,{deep}66,transparent 70%)}}
body>*{{position:relative;z-index:1}}
.k{{font-family:'Space Mono',monospace;font-size:22px;letter-spacing:.16em;text-transform:uppercase;color:{violet2}}}
h1{{font-size:78px;line-height:1.0;font-weight:800;letter-spacing:-.045em;font-variation-settings:"wdth" 86;max-width:980px}}
.p{{font-size:30px;color:rgba(242,240,247,.75)}}.p b{{font-family:'Noto Serif',serif;color:{amber};font-size:48px}}
.f{{display:flex;justify-content:space-between;align-items:center}}.b{{display:flex;align-items:center;gap:14px;font-size:34px;font-weight:800;letter-spacing:-.02em}}.b img{{width:56px;height:56px}}.b small{{font-family:'Space Mono',monospace;font-size:18px;color:{violet2};font-weight:400;letter-spacing:.2em}}</style></head>
<body><div class="k">{kicker}</div><h1>{title}</h1><div class="f"><div class="p"><b>{setup}</b> setup + <b>{monthly}</b>/mo</div><span class="b"><img src="{gem}" alt="">{brand} <small>US</small></span></div></body></html>'''


def render_og(c, specs):
    out_dir = os.path.join(SITE, 'assets', 'og')
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    import base64
    with open(os.path.join(SITE, 'assets', 'gem-128.png'), 'rb') as fh:
        gem = 'data:image/png;base64,' + base64.b64encode(fh.read()).decode()
    for slug, kicker, title, code in specs:
        i = c.items[code]
        th = c.brand['theme']
        doc = OG_HTML.format(font=esc(c.brand['fonts']['google_css']), kicker=esc(kicker), title=esc(c.plain(title)),
                             setup=money(i['setup_cents']), monthly=money(i['monthly_cents']), brand=esc(c.brand['name']),
                             gem=gem, ink=th['ink'], paper=th['paper'], deep=th['violet_deep'], violet2=th['violet_2'], amber=th['amber'])
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
LEGAL_PAGES = ['legal/terms/index.html', 'legal/service-agreement/index.html', 'legal/privacy/index.html']
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
    c.reviews = load(os.path.join(CONTENT, 'reviews.json'))
    year = c.pb.get('updated', '2026')[:4]
    pages = {
        'index.html': niche_page(c, 'home_services', contents, path='/', year=year),
        'home-services/index.html': niche_page(c, 'home_services', contents, path='/home-services/', canonical='/', year=year),
        'real-estate/index.html': niche_page(c, 'real_estate', contents, path='/real-estate/', year=year),
        'website/index.html': website_page(c, website, year),
        'demo/index.html': demo_page(c, contents, year),
    }
    indexed = ['/', '/real-estate/', '/website/', '/demo/']
    pages['sitemap.xml'] = sitemap(c, indexed)
    pages['robots.txt'] = robots(c)
    og = [(contents[k]['slug'], c.t(contents[k]['seo']['og_kicker']), c.t(contents[k]['seo']['og_title']), 'RCP') for k in NICHE_FILES]
    og.append(('website', c.t(website['seo']['og_kicker']), c.t(website['seo']['og_title']), 'WEB'))
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
            raw = sorted(set(re.findall(r'\{[a-z][a-z0-9_]*(?::[A-Z0-9.-]+)?\}', visible)))
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
    missing = [s for s in og if not os.path.exists(os.path.join(SITE, 'assets', 'og', s[0] + '.png'))]
    if '--og' in argv:
        render_og(c, og)
    elif missing:
        render_og(c, missing)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
