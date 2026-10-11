"""Static dev server: serves site/ at / and tools/fixtures/ at /__fixture__/ (QA fixtures only).

usage: python3 tools/serve.py [port=8787]
Stdlib only. Never use in production; GitHub Pages serves site/ directly.
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
FIXTURES = os.path.join(ROOT, 'tools', 'fixtures')
PREFIX = '/__fixture__/'


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = path.split('?', 1)[0].split('#', 1)[0]
        if clean.startswith(PREFIX):
            rel = clean[len(PREFIX):]
            full = os.path.normpath(os.path.join(FIXTURES, rel))
            if os.path.commonpath([full, FIXTURES]) != FIXTURES:
                return os.path.join(FIXTURES, '__denied__')
            return full
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        if os.environ.get('SERVE_QUIET') != '1':
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    handler = functools.partial(Handler, directory=SITE)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as srv:
        print(f'serving {SITE} on http://localhost:{port}/  (fixtures at {PREFIX})', flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
