#!/usr/bin/env python3
"""Render the Facebook post cards and lint the post bank. Stdlib + Node/Playwright (already a dev dependency).

usage:
  python3 social/bank/render.py            lint posts.json, then render every card to social/bank/img/slot-NN.png
  python3 social/bank/render.py --slot 7   render one card
  python3 social/bank/render.py --check    lint only (no browser): rules below, images exist, PNGs <= 400 KB

Cards come from social/bank/card.html; text from posts.json ("card": kicker, num, title with one *accent* word, sub);
colors, fonts, brand name and domain from config/brand.json. Same rendering method as tools/build_landing.py (OG images).
"""
import base64
import html
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
POSTS = os.path.join(HERE, 'posts.json')
IMG = os.path.join(HERE, 'img')
MAX_BYTES = 400 * 1024
KINDS = {'tip', 'stat', 'how-it-works', 'faq', 'product', 'story-sample', 'website', 'review'}
# FTC / claims / brand rules (see social/bank/README.he.md). Case-insensitive substrings.
BANNED = ['hipaa', 'tcpa compliant', 'tcpa-compliant', 'compliant', 'guaranteed', 'guarantee you', 'testimonial',
          'dental', 'dentist', 'patient', 'israel', 'hebrew', 'best in', '#1', 'world-class', 'revolution']
EMOJI_RX = re.compile('[\U0001F300-\U0001FAFF☀-➿]')


def load():
    with open(POSTS, encoding='utf-8') as fh:
        return json.load(fh)


def brand():
    with open(os.path.join(ROOT, 'config', 'brand.json'), encoding='utf-8') as fh:
        return json.load(fh)


def allowed_dollars():
    """Every dollar amount a post may print: price-book setup/monthly values, the founding setup price and the bundle
    comparison sums (setup and monthly of RCP + WEB, and the savings)."""
    with open(os.path.join(ROOT, 'config', 'pricebook.json'), encoding='utf-8') as fh:
        pb = json.load(fh)
    items = {i['code']: i for i in pb['items']}
    cents = set()
    for i in items.values():
        for k in ('setup_cents', 'monthly_cents'):
            if i.get(k):
                cents.add(i[k])
    f = pb['rules']['discounts']['FOUNDING']['setup_pct']
    cents.add(items['RCP']['setup_cents'] * (100 - f) // 100)
    for k in ('setup_cents', 'monthly_cents'):
        s = items['RCP'][k] + items['WEB'][k]
        cents.update({s, s - items['BNDL'][k]})
    return {c // 100 for c in cents}


def words(msg):
    return len(re.findall(r"[A-Za-z0-9$%][\w$%,.'’–-]*", msg))


def lint(data, check_images=True):
    errs = []
    posts = data['posts']
    slots = [p['slot'] for p in posts]
    if sorted(slots) != list(range(1, len(posts) + 1)):
        errs.append(f'slots must be 1..{len(posts)} without gaps: {slots}')
    dollars = allowed_dollars()
    site = brand()['site_url']
    seen = set()
    for p in posts:
        tag = f"slot {p['slot']}"
        m = p['message']
        if p['kind'] not in KINDS:
            errs.append(f'{tag}: unknown kind {p["kind"]}')
        if not 40 <= words(m) <= 120:
            errs.append(f'{tag}: {words(m)} words (40-120)')
        if not m.rstrip().split()[-1].startswith(site):
            errs.append(f'{tag}: must end with a {site} link')
        if len(re.findall(r'(?<!\w)#\w', m)) > 2:
            errs.append(f'{tag}: more than 2 hashtags')
        if len(EMOJI_RX.findall(m)) > 1:
            errs.append(f'{tag}: more than 1 emoji')
        low = (m + ' ' + json.dumps(p.get('card', {}))).lower()
        for b in BANNED:
            if b in low:
                errs.append(f'{tag}: banned phrase "{b}"')
        for amt in re.findall(r'\$(\d{1,3}(?:,\d{3})*|\d+)', m + json.dumps(p.get('card', {}))):
            if int(amt.replace(',', '')) not in dollars:
                errs.append(f'{tag}: ${amt} is not a price-book amount')
        if p['kind'] == 'stat' and not re.search(r'survey|FCC|CFR|source', m, re.I):
            errs.append(f'{tag}: a stat post must name its source')
        key = norm(m)[:60]
        if key in seen:
            errs.append(f'{tag}: first 60 characters repeat another post (the poster matches on them)')
        seen.add(key)
        if p.get('image') and check_images:
            path = os.path.join(ROOT, p['image'])
            if not os.path.exists(path):
                errs.append(f'{tag}: image missing: {p["image"]}')
            elif p['image'].startswith('social/bank/img/') and os.path.getsize(path) > MAX_BYTES:
                errs.append(f'{tag}: {p["image"]} is over 400 KB')
        if p.get('image', '').startswith('social/bank/img/') and not p.get('card'):
            errs.append(f'{tag}: bank image without a "card" to render it from')
    return errs


def norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def card_html(tpl, b, card, gem):
    th = b['theme']
    title = html.escape(card['title'])
    title = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', title, count=1)
    vals = {'FONT': html.escape(b['fonts']['google_css']), 'INK': th['ink'], 'INK2': th['ink_2'], 'PAPER': th['paper'],
            'VIOLET': th['violet'], 'VIOLET2': th['violet_2'], 'DEEP': th['violet_deep'], 'AMBER': th['amber'],
            'BODYCLASS': 'has-num' if card.get('num') else '', 'KICKER': html.escape(card.get('kicker', '')),
            'NUM': html.escape(card.get('num', '')), 'TITLE': title, 'SUB': html.escape(card.get('sub', '')),
            'GEM': gem, 'BRAND': html.escape(b['name']), 'DOMAIN': html.escape(b['domain'])}
    return re.sub(r'\{\{([A-Z0-9]+)\}\}', lambda m: vals[m.group(1)], tpl)


RENDER_JS = r'''
import { chromium } from 'playwright';
import fs from 'node:fs';
const jobs = JSON.parse(fs.readFileSync(0, 'utf8'));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
for (const j of jobs) {
  await p.setContent(j.html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  const over = await p.evaluate(() => { const m = document.querySelector('.main').getBoundingClientRect(), f = document.querySelector('.f').getBoundingClientRect(), h = document.querySelector('h1').getBoundingClientRect(); return f.bottom > 630 || m.bottom > f.top - 8 || h.right > 1130; });
  await p.screenshot({ path: j.out });
  console.log((over ? 'OVERFLOW ' : 'card: ') + j.out);
}
await b.close();
'''


def render(posts):
    b = brand()
    with open(os.path.join(HERE, 'card.html'), encoding='utf-8') as fh:
        tpl = fh.read()
    with open(os.path.join(ROOT, 'site', 'assets', 'gem-128.png'), 'rb') as fh:
        gem = 'data:image/png;base64,' + base64.b64encode(fh.read()).decode()
    os.makedirs(IMG, exist_ok=True)
    jobs = [{'html': card_html(tpl, b, p['card'], gem), 'out': os.path.join(ROOT, p['image'])}
            for p in posts if p.get('card') and p.get('image', '').startswith('social/bank/img/')]
    if not jobs:
        print('render: nothing to render')
        return 0
    r = subprocess.run(['node', '--input-type=module', '-e', RENDER_JS], input=json.dumps(jobs), cwd=ROOT,
                       capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        print('render: failed (run `make install`?):\n' + r.stderr[-800:])
        return 1
    return 1 if 'OVERFLOW' in r.stdout else 0


def main(argv):
    data = load()
    if '--check' in argv:
        errs = lint(data)
        for e in errs:
            print('ERROR ' + e)
        print(f'posts.json: {len(data["posts"])} posts, {len(errs)} errors')
        return 1 if errs else 0
    errs = lint(data, check_images=False)
    if errs:
        for e in errs:
            print('ERROR ' + e)
        return 1
    posts = data['posts']
    if '--slot' in argv:
        n = int(argv[argv.index('--slot') + 1])
        posts = [p for p in posts if p['slot'] == n]
    rc = render(posts)
    for p in posts:
        path = os.path.join(ROOT, p.get('image', ''))
        if p.get('card') and os.path.exists(path) and os.path.getsize(path) > MAX_BYTES:
            print(f'ERROR {p["image"]} is {os.path.getsize(path) // 1024} KB (max 400)')
            rc = 1
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
