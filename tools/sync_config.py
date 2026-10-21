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
import re
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
    claude = brand.get('claude') or {}
    for key in ('model', 'voice_model', 'quote_model'):
        if not claude.get(key):
            errs.append(f'brand: missing claude.{key}')
    prices = claude.get('price_usd_per_mtok') or {}
    for key in ('model', 'voice_model', 'quote_model'):
        if claude.get(key) and len(prices.get(claude[key]) or []) != 4:
            errs.append(f'brand: claude.price_usd_per_mtok needs [in, out, cache_read, cache_write] for claude.{key}')
    errs += ['brand: ' + e for e in paypal_errors(brand)]
    return errs


# same rule as paypalOn() in supabase/functions/_shared/quote_view.mjs
PAYPAL_CLIENT_ID_RX = re.compile(r'^[A-Za-z0-9_-]{16,128}$')


def paypal_errors(brand):
    """payments.paypal (card / PayPal checkout): public values only. A missing section = PayPal off (allowed)."""
    pay = brand.get('payments')
    if pay is None:
        return []
    pp = pay.get('paypal') if isinstance(pay, dict) else None
    if not isinstance(pp, dict):
        return ['payments.paypal must be an object']
    errs = []
    if not isinstance(pp.get('enabled'), bool):
        errs.append('payments.paypal.enabled must be true or false')
    if pp.get('env') not in ('sandbox', 'live'):
        errs.append('payments.paypal.env must be "sandbox" or "live"')
    cid = pp.get('client_id')
    if not isinstance(cid, str) or (cid and not PAYPAL_CLIENT_ID_RX.match(cid)):
        errs.append('payments.paypal.client_id must be empty or a PayPal REST client ID (letters, digits, - and _)')
    if pp.get('enabled') is True and not cid:
        errs.append('payments.paypal.enabled needs payments.paypal.client_id (run tools/us_setup.py --only paypal)')
    extra = sorted(k for k in set(pp) - {'enabled', 'env', 'client_id'} if not k.startswith('$'))
    if extra:
        errs.append('payments.paypal has unknown keys (secrets never go here): ' + ', '.join(extra))
    return errs


# Keys that must not reach the public static site (served as https://<domain>/assets/brand.json). The site renders
# brand.display_address; the full postal address stays server-side (email footers, runtime) only.
SITE_PRIVATE_KEYS = {'brand.json': ('physical_address',)}


def public_copy(name, target, src):
    keys = SITE_PRIVATE_KEYS.get(name) if target == 'site/assets' else None
    if not keys:
        return src
    data = json.loads(src)
    for k in keys:
        data.pop(k, None)
    return (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode()


def main(argv):
    check = '--check' in argv
    errs = validate_config()
    for e in errs:
        print('INVALID ' + e)
    if errs:
        return 1
    drift = 0
    for name in FILES:
        base_src = read(os.path.join(ROOT, 'config', name))
        for t in TARGETS:
            src = public_copy(name, t, base_src)
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
