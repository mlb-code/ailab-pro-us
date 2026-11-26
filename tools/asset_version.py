"""Content-hash cache busting for the static site (2026-11-26). Stdlib only.

GitHub Pages serves every file with `Cache-Control: max-age=600`, so right after a deploy a browser can keep running the
old JS / CSS / JSON for up to 10 minutes, mixed with the new HTML (e.g. an old signup.js against the new checkout).
Fix: every reference to a local file carries `?v=<first 10 hex of the file's sha256>`, so a changed file is a new URL.

  * HTML (every site/**/*.html, hand-written or generated): each local <script src="…"> and
    <link rel="stylesheet" href="…"> gets ?v=<hash>. Relative paths (../legal.css) are resolved from the page's folder.
  * JS that fetches or imports site files at runtime carries one stamped map, written by hand with the keys
    (site-root paths) and filled in here:
        const AV = /*asset-v*/{"/assets/brand.json":"…","/assets/pricebook.json":"…"}/*/asset-v*/;
    and builds the URL with  u + '?v=' + AV[u]. JS maps are filled before the HTML is stamped, so the hash of a JS file
    in the HTML covers the versions it carries. An .mjs hash also covers the modules it imports by relative path
    (its own `import … from './pricing.mjs'` stays unversioned: a browser rule, nothing to stamp there).

usage:
  python3 tools/asset_version.py           stamp in place (also run by tools/sync_config.py and tools/build_landing.py)
  python3 tools/asset_version.py --check   exit 1 when an HTML file or a JS map is missing the current hash (make qa-fast)
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
HASH_LEN = 10
MAP_RX = re.compile(r'/\*asset-v\*/(\{[^\n]*?\})/\*/asset-v\*/')
TAG_RX = re.compile(r'<(script|link)\b[^>]*>', re.I)
ATTR_RX = re.compile(r'''\b(src|href)\s*=\s*("([^"]*)"|'([^']*)')''', re.I)
REL_STYLE_RX = re.compile(r'''\brel\s*=\s*["']?stylesheet\b''', re.I)
EXTERNAL_RX = re.compile(r'^(?:[a-z][a-z0-9+.-]*:|//|#)', re.I)
IMPORT_RX = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}/[^"']+)["']''')
SKIP_DIRS = {'node_modules', '.git'}


class AssetError(Exception):
    pass


def _rel(path):
    return os.path.relpath(path, ROOT)


def _read(path):
    with open(path, 'rb') as fh:
        return fh.read()


def _site_files(exts):
    for d, dirs, files in os.walk(SITE):
        dirs[:] = sorted(x for x in dirs if x not in SKIP_DIRS)
        for f in sorted(files):
            if os.path.splitext(f)[1] in exts:
                yield os.path.join(d, f)


class Stamper:
    """Hashes are computed from the STAMPED content (in memory), so --check and the write mode agree in one pass."""

    def __init__(self):
        self._content = {}
        self._hash = {}
        self._busy = set()

    def content(self, path):
        """Bytes as they will be published: a JS file with an asset map gets its map filled in."""
        path = os.path.normpath(path)
        if path in self._content:
            return self._content[path]
        if not os.path.isfile(path):
            raise AssetError(f'missing file {_rel(path)}')
        raw = _read(path)
        if path.endswith(('.js', '.mjs')) and b'/*asset-v*/' in raw:
            if path in self._busy:
                raise AssetError(f'asset-v map cycle through {_rel(path)}')
            self._busy.add(path)
            try:
                raw = self.stamp_js(raw.decode('utf-8'), path).encode('utf-8')
            finally:
                self._busy.discard(path)
        self._content[path] = raw
        return raw

    def version(self, path):
        path = os.path.normpath(path)
        if path in self._hash:
            return self._hash[path]
        h = hashlib.sha256(self.content(path))
        if path.endswith('.mjs'):   # an ES module's version also covers what it imports by relative path
            for dep in sorted(set(IMPORT_RX.findall(self.content(path).decode('utf-8', 'replace')))):
                h.update(self.version(os.path.join(os.path.dirname(path), dep.split('?')[0])).encode())
        self._hash[path] = h.hexdigest()[:HASH_LEN]
        return self._hash[path]

    def stamp_js(self, text, path):
        def fill(m):
            try:
                keys = json.loads(m.group(1))
            except ValueError as e:
                raise AssetError(f'{_rel(path)}: asset-v map is not JSON ({e})')
            out = {}
            for k in keys:
                if not isinstance(k, str) or not k.startswith('/'):
                    raise AssetError(f'{_rel(path)}: asset-v key {k!r} must be a site-root path like "/assets/brand.json"')
                out[k] = self.version(os.path.join(SITE, k.lstrip('/')))
            return '/*asset-v*/' + json.dumps(out, separators=(',', ':')) + '/*/asset-v*/'
        return MAP_RX.sub(fill, text)

    def stamp_html(self, text, html_path):
        """Every local <script src> / <link rel=stylesheet href> in `text` (the page at html_path) gets ?v=<hash>."""
        page = html_path if os.path.isabs(html_path) else os.path.join(SITE, html_path)
        base = os.path.dirname(page)

        def tag(m):
            t = m.group(0)
            if m.group(1).lower() == 'link' and not REL_STYLE_RX.search(t):
                return t
            a = None
            for x in ATTR_RX.finditer(t):
                if x.group(1).lower() == ('src' if m.group(1).lower() == 'script' else 'href'):
                    a = x
                    break
            if not a:
                return t
            url = a.group(3) if a.group(3) is not None else a.group(4)
            if not url or EXTERNAL_RX.match(url):
                return t
            path, _, query = url.partition('?')
            path = path.split('#')[0]
            if query and not re.fullmatch(r'v=[0-9a-f]*', query):
                raise AssetError(f'{_rel(page)}: {url} has a query string other than ?v=')
            full = os.path.join(SITE, path.lstrip('/')) if path.startswith('/') else os.path.join(base, path)
            if not os.path.normpath(full).startswith(SITE + os.sep):
                raise AssetError(f'{_rel(page)}: {url} points outside site/')
            new = path + '?v=' + self.version(full)
            q = a.group(2)[0]
            return t[:a.start(2)] + q + new + q + t[a.end(2):]
        return TAG_RX.sub(tag, text)


def plan():
    """{abs path: new text} for every JS map and HTML file under site/ whose stamped text differs from the disk."""
    st = Stamper()
    out = {}
    for p in _site_files({'.js', '.mjs'}):
        cur = _read(p)
        new = st.content(p)
        if new != cur:
            out[p] = new.decode('utf-8')
    for p in _site_files({'.html'}):
        cur = _read(p).decode('utf-8')
        new = st.stamp_html(cur, p)
        if new != cur:
            out[p] = new
    return out


def stamp_pages(pages):
    """For tools/build_landing.py: {rel under site/: text} -> the same with ?v= hashes on every HTML page."""
    st = Stamper()
    return {rel: (st.stamp_html(t, os.path.join(SITE, rel)) if rel.endswith('.html') else t) for rel, t in pages.items()}


def main(argv):
    check = '--check' in argv
    try:
        changes = plan()
    except AssetError as e:
        print(f'asset_version: {e}')
        return 1
    if check:
        for p in changes:
            print(f'STALE   {_rel(p)} (local script/stylesheet/asset-v map without the current ?v= hash)')
        print(f'asset_version --check: {"all current" if not changes else f"{len(changes)} file(s) stale; run python3 tools/asset_version.py"}')
        return 1 if changes else 0
    for p, text in changes.items():
        with open(p, 'w', encoding='utf-8', newline='') as fh:
            fh.write(text)
        print(f'stamped {_rel(p)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
