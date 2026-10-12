#!/usr/bin/env python3
"""Post the next Facebook post from social/bank/posts.json to the US page, one every ~2 days. Stdlib only.

usage:
  python3 social/fb_post.py              post the next unposted slot if the newest page post is older than 44 h
  python3 social/fb_post.py --dry-run    same decision, prints what it would post, never posts
  python3 social/fb_post.py --status     table of posted / unposted slots (read-only; combine with --dry-run)
  python3 social/fb_post.py --slot N     post slot N (refuses a slot that is already posted unless --force)
  python3 social/fb_post.py --force      ignore the 44-hour gap

Env: META_ACCESS_TOKEN (system-user token; local fallback: META_ACCESS_TOKEN in
"~/Desktop/Pyton1/pyton corus 1/meta-ads/.env"), META_PRO_PAGE_ID (fallback below), SOCIAL_FB_DRY_RUN=1 = --dry-run.
How "posted" is decided: the first 60 characters (whitespace collapsed) of each bank message are compared with the last
60 page posts. So editing the opening of a post that is already live makes it look unposted: don't.
Photo posts upload the PNG bytes (multipart "source"). Exit 0 = posted or nothing to do, 1 = bad input, 2 = API error.
The token is never printed.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BANK = os.path.join(HERE, 'bank', 'posts.json')
GRAPH = 'https://graph.facebook.com/v21.0'
DEFAULT_PAGE_ID = '1405415849316418'
LOCAL_ENV = os.path.expanduser('~/Desktop/Pyton1/pyton corus 1/meta-ads/.env')
MIN_GAP_HOURS = 44
FEED_LIMIT = 60
KEY_LEN = 60


class ApiError(Exception):
    pass


def log(msg):
    print(f'{dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")} fb_post: {msg}', flush=True)


def env_file_value(path, key):
    try:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(key + '='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ''


def config():
    token = os.environ.get('META_ACCESS_TOKEN', '').strip() or env_file_value(LOCAL_ENV, 'META_ACCESS_TOKEN')
    page = (os.environ.get('META_PRO_PAGE_ID', '').strip() or env_file_value(LOCAL_ENV, 'META_PRO_PAGE_ID')
            or DEFAULT_PAGE_ID)
    return token, page


def _scrub(text, secrets):
    for s in secrets:
        if s:
            text = text.replace(s, '***')
    return text


def call(method, path, token, params=None, files=None, secrets=()):
    """Graph API call. GET params go in the query string; POST uses form or multipart. Raises ApiError (scrubbed)."""
    params = dict(params or {})
    params['access_token'] = token
    url = GRAPH + path
    data, headers = None, {}
    if method == 'GET':
        url += '?' + urllib.parse.urlencode(params)
    elif files:
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in params.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for k, (name, blob, ctype) in files.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                         f'Content-Type: {ctype}\r\n\r\n'.encode() + blob + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        data = b''.join(parts)
        headers['Content-Type'] = f'multipart/form-data; boundary={boundary}'
    else:
        data = urllib.parse.urlencode(params).encode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='replace')
        try:
            err = json.loads(body).get('error', {})
            msg = f'{err.get("type", "")} {err.get("code", "")}: {err.get("message", body)}'
        except ValueError:
            msg = body[:300]
        raise ApiError(_scrub(f'{method} {path} -> HTTP {e.code} {msg}', (token,) + tuple(secrets))) from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise ApiError(_scrub(f'{method} {path} -> {e}', (token,) + tuple(secrets))) from None


def page_token(user_token, page_id):
    path, params = '/me/accounts', {'fields': 'id,name,access_token', 'limit': 100}
    while True:
        res = call('GET', path, user_token, params)
        for acc in res.get('data', []):
            if str(acc.get('id')) == str(page_id):
                return acc['access_token'], acc.get('name', '')
        nxt = res.get('paging', {}).get('cursors', {}).get('after')
        if not nxt or not res.get('paging', {}).get('next'):
            break
        params['after'] = nxt
    raise ApiError(f'page {page_id} not found in /me/accounts for this token')


def norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def key(s):
    return norm(s)[:KEY_LEN]


def parse_time(s):
    # Graph returns e.g. 2026-10-12T09:15:03+0000
    return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S%z')


def load_bank():
    with open(BANK, encoding='utf-8') as fh:
        posts = json.load(fh)['posts']
    return sorted(posts, key=lambda p: p['slot'])


def posted_map(bank, feed):
    """slot -> (post id, created_time) for bank posts found in the feed."""
    by_key = {}
    for f in feed:
        k = key(f.get('message', ''))
        if k and k not in by_key:
            by_key[k] = (f['id'], f['created_time'])
    return {p['slot']: by_key[key(p['message'])] for p in bank if key(p['message']) in by_key}


def print_status(bank, posted, latest):
    print(f'{"slot":>4}  {"kind":<13} {"status":<24} first line')
    for p in bank:
        first = norm(p['message'].split('\n', 1)[0])[:58]
        if p['slot'] in posted:
            st = 'posted ' + posted[p['slot']][1][:10]
        elif p.get('skip'):
            st = 'skipped (hold)'
        else:
            st = 'unposted'
        print(f'{p["slot"]:>4}  {p["kind"]:<13} {st:<24} {first}')
    n = len(posted)
    print(f'-- {n} posted, {len(bank) - n} unposted (of {len(bank)}). Newest page post: '
          f'{latest.isoformat() if latest else "none"}')


def publish(page_id, ptoken, post, user_token):
    msg = post['message']
    img = post.get('image')
    if img:
        path = os.path.join(ROOT, img)
        with open(path, 'rb') as fh:
            blob = fh.read()
        ctype = 'image/png' if path.lower().endswith('.png') else 'image/jpeg'
        res = call('POST', f'/{page_id}/photos', ptoken, {'message': msg, 'published': 'true'},
                   files={'source': (os.path.basename(path), blob, ctype)}, secrets=(user_token,))
        return res.get('post_id') or res.get('id')
    params = {'message': msg}
    if post.get('link'):
        params['link'] = post['link']
    res = call('POST', f'/{page_id}/feed', ptoken, params, secrets=(user_token,))
    return res.get('id')


def main(argv=None):
    ap = argparse.ArgumentParser(description='Post the next bank post to the US Facebook page.')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--slot', type=int)
    ap.add_argument('--status', action='store_true')
    a = ap.parse_args(argv)
    dry = a.dry_run or os.environ.get('SOCIAL_FB_DRY_RUN', '') in ('1', 'true', 'yes')

    try:
        bank = load_bank()
    except (OSError, ValueError, KeyError) as e:
        log(f'error=bad_bank {e}')
        return 1
    token, page_id = config()
    if not token:
        log('error=no_token META_ACCESS_TOKEN is not set (nothing posted)')
        return 1

    try:
        ptoken, page_name = page_token(token, page_id)
        feed = call('GET', f'/{page_id}/posts', ptoken, {'fields': 'id,message,created_time', 'limit': FEED_LIMIT},
                    secrets=(token,)).get('data', [])
    except ApiError as e:
        log(f'error=api {e}')
        return 2

    posted = posted_map(bank, feed)
    times = [parse_time(f['created_time']) for f in feed if f.get('created_time')]
    latest = max(times) if times else None
    now = dt.datetime.now(dt.timezone.utc)
    age_h = (now - latest).total_seconds() / 3600 if latest else None

    if a.status:
        print(f'Page: {page_name} ({page_id}) · feed read: {len(feed)} posts')
        print_status(bank, posted, latest)
        if not dry and a.slot is None and not a.force:
            return 0  # --status alone is read-only

    if a.slot is not None:
        cand = [p for p in bank if p['slot'] == a.slot]
        if not cand:
            log(f'error=no_slot slot={a.slot}')
            return 1
        post = cand[0]
        if post['slot'] in posted and not a.force:
            log(f'action=none reason=slot_already_posted slot={post["slot"]} post={posted[post["slot"]][0]}')
            return 0
    else:
        todo = [p for p in bank if p['slot'] not in posted and not p.get('skip')]
        if not todo:
            log(f'action=none reason=bank_empty posted={len(posted)}/{len(bank)}')
            return 0
        post = todo[0]

    if age_h is not None and age_h < MIN_GAP_HOURS and not a.force:
        log(f'action=wait reason=last_post_{age_h:.1f}h_ago (< {MIN_GAP_HOURS}h) next_slot={post["slot"]} '
            f'posted={len(posted)}/{len(bank)}')
        return 0

    if post.get('image') and not os.path.exists(os.path.join(ROOT, post['image'])):
        log(f'error=image_missing slot={post["slot"]} image={post["image"]}')
        return 1

    if dry:
        log(f'action=dry_run would_post slot={post["slot"]} kind={post["kind"]} image={post.get("image") or "-"} '
            f'last_post_age_h={"%.1f" % age_h if age_h is not None else "none"}')
        print('----- message -----\n' + post['message'] + '\n-------------------')
        return 0

    try:
        pid = publish(page_id, ptoken, post, token)
    except (ApiError, OSError) as e:
        log(f'error=api slot={post["slot"]} {e}')
        return 2
    log(f'action=posted slot={post["slot"]} kind={post["kind"]} post={pid} posted={len(posted) + 1}/{len(bank)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
