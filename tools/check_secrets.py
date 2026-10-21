"""Secrets scan (gitleaks-light). Stdlib only.

usage:
  python3 tools/check_secrets.py [path ...]      scan files/dirs (default: repo root); exit 1 on any finding
  python3 tools/check_secrets.py --self-test     prove every rule fires on synthetic samples and stays quiet on safe text

Never prints a secret: findings show file:line, rule name and a masked preview only.
Skips: .git, node_modules, qa-shots, virtualenvs, binaries, files > 5 MB, and the gitignored secret stores
(.secrets.env, .env*, *.p8), which are never opened.
"""
import fnmatch
import os
import re
import sys

RULES = [
    ('anthropic-api-key', re.compile(r'sk-ant-[A-Za-z0-9_\-]{16,}')),
    ('supabase-access-token', re.compile(r'\bsbp_[A-Za-z0-9]{20,}')),
    ('supabase-secret-key', re.compile(r'\bsb_secret_[A-Za-z0-9_\-]{16,}')),
    ('resend-api-key', re.compile(r'\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}')),
    ('twilio-account-sid', re.compile(r'\bAC[0-9a-f]{32}\b')),
    ('twilio-api-key-sid', re.compile(r'\bSK[0-9a-f]{32}\b')),
    ('private-key', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----')),
    ('google-oauth-client-secret', re.compile(r'\bGOCSPX-[A-Za-z0-9_\-]{20,}')),
    ('aws-access-key-id', re.compile(r'\bAKIA[0-9A-Z]{16}\b')),
    ('stripe-secret-key', re.compile(r'\b[sr]k_live_[A-Za-z0-9]{16,}')),
    # PayPal: a REST app secret has no prefix, so catch the env-style line it would be pasted in, and OAuth access tokens
    ('paypal-client-secret', re.compile(r'\bPAYPAL_[A-Z_]*SECRET\s*[=:]\s*["\']?[A-Za-z0-9_\-]{20,}')),
    ('paypal-access-token', re.compile(r'\bA21AA[A-Za-z0-9_\-]{40,}')),
]

SKIP_DIRS = {'.git', 'node_modules', 'qa-shots', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache'}
# Secret stores are gitignored and must never be opened by tools.
NEVER_OPEN = ['.secrets.env', '*.secrets*', '.env', '.env.*', '*.p8']
ALLOW_OPEN = ['.secrets.env.example', '.env.example']
MAX_BYTES = 5 * 1024 * 1024


def never_open(name):
    if name in ALLOW_OPEN:
        return False
    return any(fnmatch.fnmatch(name, pat) for pat in NEVER_OPEN)


def mask(value):
    return value[:6] + '…' + f'({len(value)} chars)'


def scan_text(text):
    """Yield (line_no, rule, masked) for every finding in text."""
    for n, line in enumerate(text.splitlines(), 1):
        if 'secrets-scan: allow' in line:  # explicit, reviewable opt-out for documented fake samples
            continue
        for name, rx in RULES:
            for m in rx.finditer(line):
                yield n, name, mask(m.group(0))


def iter_files(paths):
    for p in paths:
        if os.path.isfile(p):
            if not never_open(os.path.basename(p)):
                yield p
            continue
        for root, dirs, files in os.walk(p):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            for f in sorted(files):
                if never_open(f):
                    continue
                yield os.path.join(root, f)


def read_text(path):
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return None
        with open(path, 'rb') as fh:
            data = fh.read()
    except OSError:
        return None
    if b'\x00' in data[:8192]:
        return None  # binary
    return data.decode('utf-8', errors='replace')


def scan(paths):
    findings, scanned = [], 0
    for path in iter_files(paths):
        text = read_text(path)
        if text is None:
            continue
        scanned += 1
        for n, rule, masked in scan_text(text):
            findings.append((path, n, rule, masked))
    return findings, scanned


def self_test():
    # Samples are assembled at runtime so this file never contains a matching literal.
    hexs = '0123456789abcdef' * 2
    alnum = 'AbCdEf0123456789XyZw'
    positives = {
        'anthropic-api-key': 'key = "' + 'sk-' + 'ant-api03-' + alnum + '"',
        'supabase-access-token': 'SUPABASE_ACCESS_TOKEN=' + 'sbp' + '_' + alnum + alnum,
        'supabase-secret-key': 'x=' + 'sb_' + 'secret_' + alnum,
        'resend-api-key': 'RESEND=' + 're' + '_' + 'Ab12Cd34' + '_' + alnum,
        'twilio-account-sid': 'sid: ' + 'A' + 'C' + hexs,
        'twilio-api-key-sid': 'key: ' + 'S' + 'K' + hexs,
        'private-key': '-----BEGIN ' + 'PRIVATE KEY-----',
        'google-oauth-client-secret': 'secret=' + 'GOC' + 'SPX-' + alnum,
        'aws-access-key-id': 'AKIA' + 'ABCDEFGHIJKLMNOP',
        'stripe-secret-key': 'sk' + '_live_' + alnum,
        'paypal-client-secret': 'PAYPAL_' + 'LIVE_CLIENT_' + 'SECRET=' + 'EK' + alnum + alnum,
        'paypal-access-token': 'Authorization: Bearer ' + 'A21' + 'AA' + alnum + alnum + alnum,
    }
    negatives = [
        'const pre_render = are_you_sure_about_this;',      # "re_" inside words
        'ACCOUNT_SID=AC' + 'x' * 32,                          # placeholder, not hex
        'sk-ant-...',                                         # documentation ellipsis
        'see https://supabase.com/docs, sbp_ prefix tokens',  # prefix mention only
        'ANTHROPIC_API_KEY=',                                 # empty example value
        'PAYPAL_LIVE_CLIENT_SECRET=',                         # empty example value (.secrets.env.example)
        'secrets PAYPAL_CLIENT_SECRET, PAYPAL_ENV',           # a name in prose
    ]
    bad = 0
    for rule, sample in positives.items():
        hits = {r for _, r, _ in scan_text(sample)}
        ok = rule in hits
        bad += not ok
        print(f"{'ok  ' if ok else 'BAD '} fires   {rule}")
    for sample in negatives:
        hits = list(scan_text(sample))
        ok = not hits
        bad += not ok
        print(f"{'ok  ' if ok else 'BAD '} quiet   {sample[:40]!r}" + ('' if ok else f' -> {hits}'))
    for name in ['.secrets.env', '.env', '.env.local', 'AuthKey_X.p8', 'prod.secrets.json']:
        ok = never_open(name)
        bad += not ok
        print(f"{'ok  ' if ok else 'BAD '} skips   {name}")
    ok = not never_open('.secrets.env.example')
    bad += not ok
    print(f"{'ok  ' if ok else 'BAD '} scans   .secrets.env.example")
    print('self-test ' + ('FAILED' if bad else 'passed'))
    return 1 if bad else 0


def main(argv):
    if '--self-test' in argv:
        return self_test()
    paths = [a for a in argv if not a.startswith('-')] or [os.path.dirname(os.path.dirname(os.path.abspath(__file__)))]
    findings, scanned = scan(paths)
    for path, n, rule, masked in findings:
        print(f'SECRET  {path}:{n}  {rule}  {masked}')
    print(f'secrets scan: {scanned} files scanned, {len(findings)} finding(s)')
    return 1 if findings else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
