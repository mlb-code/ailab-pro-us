"""Copy config/brand.json and config/pricebook.json to every consumer. Stdlib only.

Targets (byte-identical copies; never edit them by hand):
  site/assets/                      static site, questionnaire, quote page (fetch('/assets/pricebook.json'))
  supabase/functions/_shared/       Edge Functions (pricing.ts imports the JSON)
  runtime/app/                      Python runtime (receptionist)
Also writes site/CNAME = brand.json "domain" (GitHub Pages custom domain).
Also: supabase/functions/_shared/{pricing,quote_view}.mjs -> site/assets/ (one pricing + public-view module for server, admin, quote mock),
      runtime/app/tenant_schema.json -> site/assets/tenant_schema.json (tenant config validation in the portal/admin, B7).

usage:
  python3 tools/sync_config.py           validate, then write copies
  python3 tools/sync_config.py --check   validate, then report drift (missing/different copy) -> exit 1
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from schema_lite import validate  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ['brand.json', 'pricebook.json']
TARGETS = ['site/assets', 'supabase/functions/_shared', 'runtime/app']
# Shared JS modules: source of truth -> byte-identical copies (same drift check). pricing.mjs = one pricing implementation
# for the Edge Functions (Deno) and the admin (browser).
MODULES = [('supabase/functions/_shared/pricing.mjs', ['site/assets/pricing.mjs']),
           # A6: public quote view + accept rules, used by the quote page's mock mode (imports ./pricing.mjs)
           ('supabase/functions/_shared/quote_view.mjs', ['site/assets/quote_view.mjs']),
           # B7: the tenant config JSON schema (generated from the runtime's pydantic model) for the portal + admin editor
           ('runtime/app/tenant_schema.json', ['site/assets/tenant_schema.json'])]
BRAND_REQUIRED = ['name', 'domain', 'site_url', 'support_email', 'senders', 'claude', 'niches', 'disclaimers']


def read(path):
    with open(path, 'rb') as fh:
        return fh.read()


def validate_config():
    errs = []
    cfg = os.path.join(ROOT, 'config')
    try:
        brand = json.loads(read(os.path.join(cfg, 'brand.json')))
        pb = json.loads(read(os.path.join(cfg, 'pricebook.json')))
        schema = json.loads(read(os.path.join(cfg, 'pricebook.schema.json')))
    except (OSError, ValueError) as e:
        return [f'cannot load config: {e}']
    errs += ['pricebook: ' + e for e in validate(pb, schema)]
    errs += [f'brand: missing "{k}"' for k in BRAND_REQUIRED if not brand.get(k)]
    if not (brand.get('claude') or {}).get('model'):
        errs.append('brand: missing claude.model')
    return errs


def main(argv):
    check = '--check' in argv
    errs = validate_config()
    for e in errs:
        print('INVALID ' + e)
    if errs:
        return 1
    drift = 0
    for name in FILES:
        src = read(os.path.join(ROOT, 'config', name))
        for t in TARGETS:
            dst = os.path.join(ROOT, t, name)
            same = os.path.exists(dst) and read(dst) == src
            rel = os.path.relpath(dst, ROOT)
            if same:
                print(f'ok      {rel}')
            elif check:
                drift += 1
                print(f'DRIFT   {rel} ({"missing" if not os.path.exists(dst) else "differs from config/" + name})')
            else:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, 'wb') as fh:
                    fh.write(src)
                print(f'wrote   {rel}')
    for src_rel, dsts in MODULES:
        src_path = os.path.join(ROOT, src_rel)
        if not os.path.exists(src_path):
            continue
        src = read(src_path)
        for rel in dsts:
            dst = os.path.join(ROOT, rel)
            if os.path.exists(dst) and read(dst) == src:
                print(f'ok      {rel}')
            elif check:
                drift += 1
                print(f'DRIFT   {rel} ({"missing" if not os.path.exists(dst) else "differs from " + src_rel})')
            else:
                with open(dst, 'wb') as fh:
                    fh.write(src)
                print(f'wrote   {rel}')
    # GitHub Pages custom domain, derived from brand.json
    cname = (json.loads(read(os.path.join(ROOT, 'config', 'brand.json')))['domain'].strip() + '\n').encode()
    dst = os.path.join(ROOT, 'site', 'CNAME')
    if os.path.exists(dst) and read(dst) == cname:
        print('ok      site/CNAME')
    elif check:
        drift += 1
        print('DRIFT   site/CNAME (missing or not brand.domain)')
    else:
        with open(dst, 'wb') as fh:
            fh.write(cname)
        print('wrote   site/CNAME')
    if check:
        print(f'sync_config --check: {"no drift" if not drift else f"{drift} file(s) drifted; run python3 tools/sync_config.py"}')
    return 1 if drift else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
