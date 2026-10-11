"""Build the public landing pages from config + content. Stdlib only. Never edit the generated HTML by hand.

Inputs : config/brand.json, config/pricebook.json, site/_content/{_shared,home-services,real-estate,dental,website}.json
Outputs: site/index.html (home services), site/home-services/, site/real-estate/, site/dental/ (noindex, early access),
         site/website/, site/demo/, site/sitemap.xml, site/robots.txt, site/assets/og/*.png (only with --og or when missing)

usage:
  python3 tools/build_landing.py            build (renders missing OG images with Playwright)
  python3 tools/build_landing.py --check    rebuild in memory; exit 1 if any generated text file differs (no writes)
  python3 tools/build_landing.py --og       force re-render of the OG images (needs `npm install`)
  python3 tools/build_landing.py --list     print the URLs of every generated page (used by tools/urls-landing.txt)

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
NICHE_FILES = {'home_services': 'home-services.json', 'real_estate': 'real-estate.json', 'dental': 'dental.json'}
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
        """Token-fill + HTML-escape + **bold**."""
        out = html.escape(self.t(s), quote=False)
        return re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', out)


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
<meta name="theme-color" content="#0F1A26">
<meta name="robots" content="{robots}">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{esc(canon)}">
<meta property="og:type" content="website"><meta property="og:locale" content="en_US"><meta property="og:site_name" content="{esc(c.brand['name'])}">
<meta property="og:title" content="{esc(og_title)}"><meta property="og:description" content="{esc(desc)}"><meta property="og:url" content="{esc(canon)}">
<meta property="og:image" content="{esc(c.site_url + og_image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230F1A26'/%3E%3Cpath d='M16 6l8 10-8 10-8-10z' fill='%23E8A64A'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{esc(c.brand['fonts']['google_css'])}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="{esc(c.brand['fonts']['google_css'])}"></noscript>
<style>{inline_css()}</style>
{analytics(c)}
{ld}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>'''


def nav(c, active, cta=None):
    cta = cta or {'label': 'Get a quote', 'href': '/start/?offer=RCP', 'ev': 'quote_start'}
    links = ''.join(
        f'<a href="{esc(n["href"])}"' + (' aria-current="page"' if n['href'] == active else '') + f'>{esc(n["label"])}</a>'
        for n in c.shared['nav'])
    return f'''<header class="nav"><div class="wrap nav__in">
<a class="brandmark" href="/">{esc(c.brand['name'])}<small>US</small></a>
<nav class="nav__links" aria-label="Main">{links}<a class="btn btn--primary btn--sm" href="{esc(cta['href'])}"{f' data-ev="{cta["ev"]}"' if cta.get('ev') else ''}{' data-niche-cta' if cta.get('niche_cta') else ''}>{esc(cta['label'])}</a></nav>
</div></header>'''


def footer(c, year):
    b = c.brand
    mail = b.get('support_email', '')
    return f'''<footer class="footer"><div class="wrap">
<div class="footer__grid">
<div><a class="brandmark" href="/">{esc(b['name'])}<small>US</small></a>
<p class="footer__note small">{esc(c.page.get('tagline') or b.get('tagline', ''))}. Fixed prices, everything in writing.</p>
{f'<p class="small"><a href="mailto:{esc(mail)}">{esc(mail)}</a></p>' if mail else ''}</div>
<div><h4>Products</h4><ul><li><a href="/">Home services</a></li><li><a href="/real-estate/">Real estate</a></li><li><a href="/website/">Business website</a></li><li><a href="/demo/">Try the demo</a></li></ul></div>
<div><h4>Legal</h4><ul><li><a href="/legal/terms/">Terms of Service</a></li><li><a href="/legal/privacy/">Privacy Policy</a></li><li><a href="/legal/service-agreement/">Service Agreement</a></li></ul></div>
</div>
<div class="footer__legal"><span>&copy; {year} {esc(b['name'])}</span><span>{esc(b['disclaimers']['footer'])}</span><span>Claude is a trademark of Anthropic, PBC.</span></div>
</div></footer>
<script src="/assets/landing.js" defer></script>'''


def price_line(c, code, tag):
    i = c.items[code]
    return (f'<p class="hero__price"><b class="num">{money(i["setup_cents"])}</b> setup <span class="plus">+</span> '
            f'<b class="num">{money(i["monthly_cents"])}</b>/mo<span class="tag">{esc(tag)}</span></p>')


def founder_slot(c):
    """Reserved: shown only when brand.json has "show_founder_price": true (owner has not approved yet)."""
    if not c.brand.get('show_founder_price'):
        return ''
    return f'<p class="notice">{c.h(c.shared["founder"]["text"])}</p>'


def clock(c, data, label):
    rows = []
    for n, r in enumerate(data['rows']):
        cls = ' class="is-booked"' if r.get('booked') else ''
        rows.append(f'<li{cls} style="--i:{n}"><time>{esc(r["t"])}</time><b>{c.h(r["a"])}</b><span>{c.h(r["b"])}</span></li>')
    return f'''<figure class="clock" aria-label="{esc(label)}">
<div class="clock__head"><span><i>&#9679;</i> Missed call</span><span>2 minutes later</span></div>
<ol>{''.join(rows)}</ol>
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


def excludes_list(c, code):
    return ''.join(f'<li>{esc(s)}</li>' for s in c.items[code]['excludes']
                   if not s.lower().startswith('usage above'))


def tool_status(c, key):
    v = c.pb['integrations'].get(key, 'custom')
    if v == 'native':
        return 'is-native', 'Included'
    if v == 'zapier':
        return 'is-zap', 'Via Zapier · included'
    if v.startswith('addon:'):
        it = c.items[v.split(':', 1)[1]]
        return 'is-addon', f'Add-on {money(it["setup_cents"])} + {money(it["monthly_cents"])}/mo'
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
    return f'<table class="addons"><caption>Add-ons, fixed prices</caption><tbody>{"".join(rows)}</tbody></table>'


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
<span class="badge badge--acc">{esc(code)} · fixed price</span>
<div class="price-card__name">{esc(name)}</div>
<div class="price-card__amount"><b>{money(i['setup_cents'])}</b><span>setup</span><b>{money(i['monthly_cents'])}</b><span>/ month from go-live</span></div>
<ul class="split"><li><span>Deposit to start</span><b>{money(dep)}</b></li><li><span>Before go-live</span><b>{money(i['setup_cents'] - dep)}</b></li><li><span>Delivery</span><b>{days} business days</b></li></ul>
<ul class="price-card__list">{lis}</ul>
{btn}
<p class="price-card__fine">{esc(c.pb.get('refund_rules', {}).get('deposit', {}).get('text', ''))}</p>
</div>'''


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
    if len(out) != 8:
        raise SystemExit(f'FAQ must have 8 entries, has {len(out)}')
    return out


def section_faq(faqs):
    items = ''.join(f'<details><summary>{esc(q)}</summary><div><p>{esc(a)}</p></div></details>' for q, a in faqs)
    return f'''<section class="section" id="faq"><div class="wrap">
<div class="shead"><p class="eyebrow">FAQ</p><h2>Straight answers.</h2></div>
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
<p class="hero__fine">{c.h(hero['fine'])}</p>{also}
</div>
{clock(c, n['clock'], 'A missed call becomes a booking')}
</div></section>''',
        section_missed(c, n['missed_steps']),
        section_demo(c, key, contents, '#early-access' if early else cta_href, 'Join early access' if early else cta_label),
        section_included(c, key, n['included'], n),
        section_how(c),
        section_after_pay(c),
        section_proof(c),
        section_pricing(c, n['pricing'], n['offer'], cta_href, cta_label, early=early, bundle_link=not early, n=n),
    ]
    if early:
        body.append(section_early(c, n['early'], key))
    body += [section_faq(faqs)]
    if not early:
        body.append(section_band(c, cta_href, cta_label))
    body += ['</main>', footer(c, year), '</body>\n</html>\n']
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
<div class="shead"><p class="eyebrow">What's included</p><h2>Built, hosted and kept up to date.</h2></div>
<div class="incl"><div><h3>{esc(c.items['WEB']['name'])}</h3><ul class="ticks">{inc_web}</ul>
<details class="more"><summary>Not included</summary><ul class="ticks ticks--no">{exc_web}</ul></details></div>
<div>{addons_table(c, 'WEB')}<p class="small muted" style="margin-top:12px">Choosing an add-on adds a short written quote step.</p></div></div>
</div></section>''',
        section_how(c, w['how']),
        section_proof(c, w['proof_rows']),
        f'''<section class="section" id="pricing"><div class="wrap">
<div class="shead"><p class="eyebrow">Pricing</p><h2>Pick one. The price is final.</h2></div>
<div class="pricing">{price_card(c, 'WEB', href_web, 'Choose this package')}
<div class="bundle" id="bundle"><span class="badge">{esc('BNDL')}</span><h3>{c.h(w['bundle']['title'])}</h3><p>{c.h(w['bundle']['text'])}</p>
<div class="price-card__amount"><b>{money(b['setup_cents'])}</b><span>setup</span><b>{money(b['monthly_cents'])}</b><span>/ month</span></div>
<ul class="price-card__list">{''.join(f'<li>{esc(s)}</li>' for s in b['includes'])}</ul>
<a class="btn btn--ghost" href="{href_b}" data-ev="quote_start">Choose the bundle</a>
<p class="price-card__fine">{c.h(c.shared['sms_note'])}</p>{video_call_box(c)}</div></div>
</div></section>''',
        section_faq(faqs),
        section_band(c, href_web, 'Choose this package', '/demo/', band=w['band']),
        '</main>', footer(c, year), '</body>\n</html>\n']
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
<div class="shead"><p class="eyebrow">Demo</p><h1 style="font-size:clamp(2.1rem,5vw,3.6rem)">Be the customer. Tap the replies.</h1>
<p class="lead">This is what a caller gets after a missed call: a text from your AI assistant, a few quick questions, and a booked slot. Scripted, in your browser. {esc(c.brand['disclaimers']['demo'])}.</p>
<p class="hero__price"><b class="num">{money(i0['setup_cents'])}</b> setup <span class="plus">+</span> <b class="num">{money(i0['monthly_cents'])}</b>/mo<span class="tag"><span data-demo-product>{esc(n0.get('product_name') or i0['name'])}</span> · fixed price, in writing</span></p></div>
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
<style>*{{margin:0;box-sizing:border-box}}body{{width:1200px;height:630px;background:#0F1A26;color:#EFE7D8;font-family:'Noto Sans',sans-serif;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}}
body:before{{content:"";position:absolute;right:-180px;bottom:-260px;width:760px;height:760px;border-radius:50%;background:radial-gradient(closest-side,rgba(232,166,74,.18),transparent 70%)}}
.k{{font-family:'Space Mono',monospace;font-size:22px;letter-spacing:.16em;text-transform:uppercase;color:#E8A64A}}
h1{{font-family:'Noto Serif',serif;font-size:76px;line-height:1.03;font-weight:700;font-variation-settings:"wdth" 82;max-width:960px}}
.p{{font-size:30px;color:rgba(239,231,216,.75)}}.p b{{font-family:'Noto Serif',serif;color:#E8A64A;font-size:48px}}
.f{{display:flex;justify-content:space-between;align-items:baseline;font-family:'Noto Serif',serif;font-size:30px;font-weight:700}}.f small{{font-family:'Space Mono',monospace;font-size:18px;color:rgba(239,231,216,.6);font-weight:400}}</style></head>
<body><div class="k">{kicker}</div><h1>{title}</h1><div class="f"><div class="p"><b>{setup}</b> setup + <b>{monthly}</b>/mo</div><span>{brand} <small>{note}</small></span></div></body></html>'''


def render_og(c, specs):
    out_dir = os.path.join(SITE, 'assets', 'og')
    os.makedirs(out_dir, exist_ok=True)
    jobs = []
    for slug, kicker, title, code in specs:
        i = c.items[code]
        doc = OG_HTML.format(font=esc(c.brand['fonts']['google_css']), kicker=esc(kicker), title=esc(title),
                             setup=money(i['setup_cents']), monthly=money(i['monthly_cents']), brand=esc(c.brand['name']),
                             note='Fixed price')
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


# ---------------------------------------------------------------- main
def build(c):
    contents = {k: load(os.path.join(CONTENT, f)) for k, f in NICHE_FILES.items()}
    c.brand_niche_label = lambda k: next((x['label'] for x in c.brand['niches'] if x['key'] == k), k)
    for k, n in contents.items():
        validate_demo(k, n['demo'])
    website = load(os.path.join(CONTENT, 'website.json'))
    year = c.pb.get('updated', '2026')[:4]
    pages = {
        'index.html': niche_page(c, 'home_services', contents, path='/', year=year),
        'home-services/index.html': niche_page(c, 'home_services', contents, path='/home-services/', canonical='/', year=year),
        'real-estate/index.html': niche_page(c, 'real_estate', contents, path='/real-estate/', year=year),
        'dental/index.html': niche_page(c, 'dental', contents, path='/dental/', year=year),
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
    if '--check' in argv:
        bad = 0
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
        print(f'build_landing --check: {len(pages)} files, {bad} differ')
        return 1 if bad else 0
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
