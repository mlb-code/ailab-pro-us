#!/usr/bin/env python3
"""
One-command Supabase setup for the AI Lab Pro US project (`ailab-us`). Stdlib only.

What it does (every step is safe to re-run):
  project    find `ailab-us` (or --ref); with --create: create it in the owner's Free org, region us-east-1,
             strong DB password generated and appended to .secrets.env (0600); wait for ACTIVE_HEALTHY
  migrate    run supabase/migrations/*.sql in order through the Management API SQL endpoint (idempotent files)
  test       run supabase/tests/rls_test.sql remotely; must end with RLS_TESTS_PASSED, otherwise stop
  settings   fill private.settings (admin e-mail, URLs, senders) from config/brand.json
  auth       site URL + redirect allow-list, e-mail magic link + 6-digit code (30 min), English template,
             Resend SMTP when RESEND_API_KEY is set
  google     Google sign-in when GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET are set
  apple      Sign in with Apple when APPLE_SERVICES_ID + APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_P8_PATH are set: builds the
             client secret (tools/apple_secret.py, ES256 JWT, 175 days) and sends it to Supabase; re-run before it expires
  storage    verify buckets client-files + videos-public (created by the storage migration)
  vault      Vault: ailab_us_project_url + ailab_us_service_role_key (A8 pg_net). Since 22.10.2026 the value is the
             new-style SECRET key from .secrets.env (SUPABASE_SECRET_KEY, see supabase-keys); the legacy service_role JWT
             is only a fallback (warned) until the legacy keys are switched off. resend_api_key / anthropic_api_key when present
  secrets    Edge Function secrets (ANTHROPIC_API_KEY, RESEND_API_KEY, ZAPIER_SIGNING_SECRET, and SB_SERVICE_KEY =
             SUPABASE_SECRET_KEY when present; supabase/functions/_shared/keys.ts reads it)
  functions  deploy supabase/functions/<slug>/index.ts (Supabase CLI if installed, else Management API)
  cron       select private.install_email_jobs() (A8), then verify every pg_cron job named in the migrations
  config     write site/assets/config.js (window.SITE_CONFIG: URL + publishable/anon key, BACKEND 'supabase',
             GOOGLE_ENABLED / APPLE_ENABLED from the project's auth config: the sign-in buttons follow them)
  ping       call public.ping() through the REST API with the public key
then prints a Hebrew checklist of what is still manual.

Opt-in steps (only with --only …; never part of a full run):
  supabase-keys  the new Supabase key model (Management API /v1/projects/{ref}/api-keys): creates ONE named secret key
             (--key-name, default runtime_2026_10) unless it already exists, appends it to .secrets.env as
             SUPABASE_SECRET_KEY (0600) and sets the Edge Function secret SB_SERVICE_KEY to the same value. Prints only the
             key's name and its sb_secret_ prefix, never the value. The same value then goes (by hand) to Railway
             SUPABASE_SERVICE_ROLE_KEY and the GitHub secret US_SUPABASE_SERVICE_KEY; then --only vault,secrets,functions.
             Runbook: docs/runbooks/supabase-legacy-keys-off.md (private repo).
  paypal     card / PayPal checkout: reads PAYPAL_<SANDBOX|LIVE>_CLIENT_ID + _CLIENT_SECRET from .secrets.env, checks them
             with PayPal (OAuth), finds or creates the webhook <project>/functions/v1/paypal-webhook with the events the
             function handles, sets the Edge Function secrets PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV,
             PAYPAL_WEBHOOK_ID (never printed) and writes config/brand.json payments.paypal (env, public client_id; enabled
             only with --paypal-enable) + tools/sync_config.py. --paypal-disable only switches the config off.
             Afterwards: --only functions (the functions bundle brand.json), then the site push.

Usage (from the repo root):
  python3 tools/us_setup.py --dry-run           # the plan only: no network call at all, no token needed
  python3 tools/us_setup.py --plan              # read-only: lists orgs/projects, checks the Free slot
  python3 tools/us_setup.py --create            # everything; creates the project if it does not exist
  python3 tools/us_setup.py                     # everything on an existing project (found by name / config.js)
  python3 tools/us_setup.py --ref <ref>         # use this existing project
  python3 tools/us_setup.py --only test         # one step (or a comma list: --only auth,config)
  python3 tools/us_setup.py --org <slug>        # required when the account has more than one organization
  python3 tools/us_setup.py --self-test         # offline unit tests with a fake Management API
  python3 tools/us_setup.py --only paypal --paypal-env sandbox                  # PayPal secrets + webhook, config stays off
  python3 tools/us_setup.py --only paypal --paypal-env live --paypal-enable     # the go-live switch (then functions + push)
  python3 tools/us_setup.py --only paypal --paypal-disable                      # card checkout off again (config only)
  python3 tools/us_setup.py --only supabase-keys                                # new secret key -> .secrets.env + SB_SERVICE_KEY

Secrets are read ONLY from ailab-pro-us/.secrets.env (never from the environment, never prompted), never printed,
never put in a URL. Error texts are redacted before they are shown. This script has no destructive call:
it never pauses, restores, deletes or downgrades anything.
"""
import argparse
import base64
import json
import os
import re
import secrets as pysecrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_FILE = os.path.join(ROOT, ".secrets.env")
BRAND_JSON = os.path.join(ROOT, "config", "brand.json")
MIG_DIR = os.path.join(ROOT, "supabase", "migrations")
TEST_SQL = os.path.join(ROOT, "supabase", "tests", "rls_test.sql")
FUNCTIONS_DIR = os.path.join(ROOT, "supabase", "functions")
AUTH_TEMPLATE = os.path.join(ROOT, "supabase", "auth-templates", "sign_in.html")
CONFIG_JS = os.path.join(ROOT, "site", "assets", "config.js")

API = "https://api.supabase.com/v1"
NAME = "ailab-us"
REGION = "us-east-1"
FREE_ACTIVE_LIMIT = 2
BUCKETS = ("client-files", "videos-public")
CRON_JOBS_BASE = ("ailab-us-retention", "ailab-us-expire-quotes")
RETENTION_MIGRATION = "20261011100200_us_retention.sql"
SUPABASE_JS_DEFAULT = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js"
# Public endpoints (no Supabase JWT): quote page, lead form, the unsubscribe link in e-mails (A8), card / PayPal checkout
# from the quote page and portal (the quote token is the key) and PayPal's webhook (signature checked with PayPal).
# pay-refund keeps verify_jwt: the admin's session JWT.
NO_VERIFY_JWT = {"quote-view", "quote-accept", "lead", "email-unsubscribe", "pay-create", "pay-capture", "pay-upwork", "paypal-webhook"}
STEPS = ["migrate", "test", "settings", "auth", "google", "apple", "storage", "vault", "secrets",
         "functions", "cron", "config", "ping"]
APPLE_KEYS = ("APPLE_SERVICES_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_P8_PATH")
OPT_IN_STEPS = ["paypal", "supabase-keys"]   # only with --only (paypal writes config/brand.json; supabase-keys creates a key)
SECRET_KEY_ENV = "SUPABASE_SECRET_KEY"       # .secrets.env: the named sb_secret_ key (never printed)
EDGE_SECRET_NAME = "SB_SERVICE_KEY"          # Edge Function secret read by supabase/functions/_shared/keys.ts (SUPABASE_* is reserved)
DEFAULT_KEY_NAME = "runtime_2026_10"
KEY_NAME_RX = r"[a-z][a-z0-9_]{2,40}"
SLEEP = time.sleep          # patched by the tests
POLL_SECONDS = 10
POLL_TRIES = 90             # 15 minutes


class SetupError(Exception):
    """Stops the run with a Hebrew message (already redacted)."""


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def say(msg=""):
    print(msg, flush=True)


# ------------------------------------------------------------------ secrets (.secrets.env only)
def _placeholder(v):
    return (not v) or v.startswith("<") or v.lower() in {"todo", "paste", "paste_here", "xxx", "changeme"}


def load_secrets(path=None):
    """Parse .secrets.env into a dict. Empty / placeholder values are dropped. Never prints anything."""
    path = path or SECRETS_FILE
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if not _placeholder(v):
                out[k] = v
    return out


def append_secret(name, value, path=None):
    """Append NAME=value to .secrets.env (created if missing) and force mode 0600."""
    path = path or SECRETS_FILE
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(f"\n# added by tools/us_setup.py {time.strftime('%Y-%m-%d')}\n{name}={value}\n")
    os.chmod(path, 0o600)


def secret_get(sec, *names):
    for n in names:
        if sec.get(n):
            return sec[n]
    return ""


class Redactor:
    def __init__(self, values):
        self.values = sorted({v for v in values if v and len(v) >= 6}, key=len, reverse=True)

    def __call__(self, text):
        text = str(text)
        for v in self.values:
            text = text.replace(v, "***")
        # belt and braces: anything that looks like a key
        text = re.sub(r"\b(sbp_|sb_secret_|sk-ant-|re_)[A-Za-z0-9_\-]{6,}", r"\1***", text)
        return text


def sql_lit(value):
    if "\x00" in value:
        raise SetupError("❌ ערך לא תקין (תו NUL).")
    return "'" + value.replace("'", "''") + "'"


def check_key(value, label):
    if not re.fullmatch(r"[A-Za-z0-9_\-]{8,400}", value or ""):
        raise SetupError(f"❌ {label} בקובץ .secrets.env נראה לא תקין (רק אותיות, ספרות, _ ו-). להעתיק שוב.")


# ------------------------------------------------------------------ HTTP
def urllib_transport(method, url, headers, data, timeout=120):
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        reason = getattr(e, "reason", None) or e.__class__.__name__
        raise NetError(f"{method} {url.split('?')[0]}: {reason}") from None


class NetError(Exception):
    """No answer from the server (DNS, connection, timeout)."""


class ApiError(Exception):
    def __init__(self, method, path, status, text):
        super().__init__(f"{method} {path} -> {status}: {text[:600]}")
        self.status = status
        self.text = text


class Api:
    """Management API client. The token only ever goes into the Authorization header; requests are never echoed."""

    def __init__(self, token, redact, transport=None):
        self._token = token
        self.redact = redact
        self.transport = transport or urllib_transport

    def req(self, method, path, body=None, ok=(200, 201, 204), raw=None, content_type="application/json",
            base=API, auth=True, extra_headers=None):
        headers = {"Accept": "application/json", "User-Agent": "ailab-us-setup/1.0"}
        if auth:
            headers["Authorization"] = "Bearer " + self._token
        headers.update(extra_headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
        if data is not None:
            headers["Content-Type"] = content_type
        status, payload = self.transport(method, base + path, headers, data)
        text = (payload or b"").decode("utf-8", errors="replace")
        if status not in ok:
            raise ApiError(method, path, status, self.redact(text))
        try:
            return json.loads(text) if text.strip() else None
        except ValueError:
            return text

    def sql(self, ref, query):
        return self.req("POST", f"/projects/{ref}/database/query", {"query": query}, ok=(200, 201))


# ------------------------------------------------------------------ brand / derived values
def load_brand():
    with open(BRAND_JSON, encoding="utf-8") as f:
        return json.load(f)


def parse_sender(s):
    """'Name <a@b.c>' -> (name, a@b.c)."""
    m = re.match(r"\s*(.*?)\s*<([^>]+)>\s*$", s or "")
    return (m.group(1), m.group(2)) if m else ("", (s or "").strip())


def smtp_sender(brand, override=None):
    """SMTP sender: --smtp-from > brand.smtp_from > brand.senders.fallback (verified ai-lab.co.il, SPEC §5)
    > brand.senders.transactional. Switch brand.smtp_from to the new domain once it is Verified in Resend."""
    s = brand.get("senders") or {}
    return override or brand.get("smtp_from") or s.get("fallback") or s.get("transactional", "")


def site_urls(brand):
    base = (brand.get("site_url") or f"https://{brand.get('domain', '')}").rstrip("/")
    return {
        "base": base,
        "portal": base + "/start/",
        "admin": base + "/start/admin/",
        "quote": base + "/quote/",
        "allow": [base + "/**", "http://localhost:*/**", "http://127.0.0.1:*/**"],
    }


# ------------------------------------------------------------------ context
class Ctx:
    def __init__(self, args, sec, brand, api=None):
        self.args = args
        self.sec = sec
        self.brand = brand
        self.api = api
        self.ref = None
        self.report = []        # (ok: bool|None, text)
        self.google_on = None
        self.apple_on = None
        self.public_key = None
        self.functions_skipped = []
        self.active_projects = []

    def ok(self, text):
        self.report.append((True, text)); say("✅ " + text)

    def warn(self, text):
        self.report.append((None, text)); say("⚠️  " + text)

    def fail(self, text):
        self.report.append((False, text)); say("❌ " + text)


# ------------------------------------------------------------------ step: project
def ref_from_config():
    if not os.path.exists(CONFIG_JS):
        return None
    m = re.search(r"SUPABASE_URL:\s*['\"]https://([a-z0-9]{10,})\.supabase\.co['\"]", read_text(CONFIG_JS))
    return m.group(1) if m else None


def pick_org(ctx, orgs):
    want = ctx.args.org or ctx.sec.get("SUPABASE_ORG_SLUG")
    if not orgs:
        raise SetupError("❌ אין ארגון בחשבון Supabase. ליצור ארגון (Free) בדשבורד ולהריץ שוב.")
    if want:
        for o in orgs:
            if want in (o.get("id"), o.get("slug"), o.get("name")):
                return o
        raise SetupError(f"❌ הארגון '{want}' לא נמצא. הארגונים בחשבון: " + ", ".join(o.get("name", "?") for o in orgs))
    if len(orgs) > 1:
        names = "\n".join(f"   --org {o.get('slug') or o.get('id')}   ({o.get('name')})" for o in orgs)
        raise SetupError("❌ יש יותר מארגון אחד בחשבון. להריץ שוב עם אחד מאלה:\n" + names)
    return orgs[0]


def org_slug(o):
    return o.get("slug") or o.get("id")


def free_slot(ctx, org, projects):
    """Returns (plan, active_count). Raises if the org is paid (no paid action) or full."""
    slug = org_slug(org)
    info = ctx.api.req("GET", f"/organizations/{slug}") or {}
    plan = (info.get("plan") or org.get("plan") or "").lower()
    inactive = {"INACTIVE", "PAUSED", "PAUSING", "REMOVED", "GOING_DOWN", "INIT_FAILED"}
    # The Free limit counts the user's active projects across ALL organizations, not only this one.
    active = [p for p in projects if (p.get("status") or "").upper() not in inactive]
    ctx.active_projects = active
    return plan, len(active)


def ensure_free_slot(ctx, org, projects):
    plan, active = free_slot(ctx, org, projects)
    if plan and plan != "free":
        raise SetupError(f"❌ הארגון {org.get('name')} בתוכנית '{plan}' (בתשלום). הפרויקט חייב לקום בארגון Free. "
                         "לבחור ארגון Free עם --org, או ליצור ארגון Free חדש בדשבורד.")
    if not plan:
        ctx.warn("לא הצלחתי לקרוא את תוכנית הארגון; ממשיך בהנחה שהוא Free (לבדוק בדשבורד).")
    if active >= FREE_ACTIVE_LIMIT:
        names = ", ".join(f"{p.get('name')} ({project_ref(p)})" for p in ctx.active_projects)
        raise SetupError(f"❌ אין מקום פנוי: בחשבון כבר {active} פרויקטים פעילים בכל הארגונים יחד ({names}). "
                         f"המקסימום ב-Free הוא {FREE_ACTIVE_LIMIT} למשתמש. הסקריפט לא משהה ולא מוחק פרויקטים. "
                         "לפנות מקום בדשבורד ולהריץ שוב.")
    return plan, active


def project_ref(p):
    return p.get("ref") or p.get("id")


def find_or_create(ctx):
    projects = ctx.api.req("GET", "/projects") or []
    ref = ctx.args.ref or ref_from_config()
    if ref:
        for p in projects:
            if project_ref(p) == ref:
                say(f"משתמש בפרויקט קיים: {p.get('name')} ({ref})")
                return ref
        if ctx.args.ref:
            raise SetupError(f"❌ הפרויקט {ref} לא נמצא בחשבון הזה. לבדוק שהטוקן נוצר בחשבון הנכון.")
    for p in projects:
        if p.get("name") == NAME:
            say(f"משתמש בפרויקט קיים: {NAME} ({project_ref(p)})")
            return project_ref(p)
    if not ctx.args.create:
        raise SetupError(f"❌ לא מצאתי פרויקט בשם {NAME}. להריץ שוב עם --create.")
    orgs = ctx.api.req("GET", "/organizations") or []
    org = pick_org(ctx, orgs)
    ensure_free_slot(ctx, org, projects)
    pw = ctx.sec.get("SUPABASE_DB_PASSWORD")
    if not pw:
        pw = pysecrets.token_urlsafe(32)
        append_secret("SUPABASE_DB_PASSWORD", pw)   # stored BEFORE the create call, so it is never lost
        ctx.sec["SUPABASE_DB_PASSWORD"] = pw
        ctx.api.redact.values.append(pw)
        say("  סיסמת מסד נתונים חזקה נוצרה ונשמרה ב-.secrets.env (לא מוצגת)")
    say(f"יוצר פרויקט {NAME} בארגון {org.get('name')} ({REGION}, Free)…")
    body = {"name": NAME, "organization_slug": org_slug(org), "region": REGION, "db_pass": pw}
    try:
        p = ctx.api.req("POST", "/projects", body)
    except ApiError as e:
        if e.status in (400, 422) and "organization" in e.text.lower():
            body.pop("organization_slug")
            body["organization_id"] = org.get("id")
            p = ctx.api.req("POST", "/projects", body)
        else:
            raise
    ref = project_ref(p or {})
    if not ref:
        raise SetupError("❌ Supabase לא החזיר מזהה פרויקט. לנסות שוב בעוד דקה.")
    ctx.ok(f"{NAME} נוצר ({ref}, {REGION})")
    return ref


def wait_healthy(ctx):
    for i in range(POLL_TRIES):
        st = (ctx.api.req("GET", f"/projects/{ctx.ref}") or {}).get("status")
        if st == "ACTIVE_HEALTHY":
            return
        if st in ("INACTIVE", "PAUSED"):
            raise SetupError("❌ הפרויקט מושהה (Free נרדם אחרי 7 ימים). להיכנס ל-supabase.com/dashboard, לפתוח את "
                             f"{NAME} וללחוץ Restore, ואז להריץ שוב.")
        say(f"  ממתין שהפרויקט יעלה ({st})…")
        SLEEP(POLL_SECONDS)
    raise SetupError("❌ הפרויקט לא עלה תוך 15 דקות. לנסות שוב מאוחר יותר (הסקריפט ימשיך מאותה נקודה).")


# ------------------------------------------------------------------ step: migrations + RLS test
def migration_files():
    return sorted(f for f in os.listdir(MIG_DIR) if f.endswith(".sql"))


def step_migrate(ctx):
    for f in migration_files():
        say(f"  מיגרציה {f}")
        try:
            ctx.api.sql(ctx.ref, read_text(os.path.join(MIG_DIR, f)))
        except ApiError as e:
            raise SetupError(f"❌ המיגרציה {f} נכשלה: {e.text[:400]}\nעוצר. להעביר לקלוד את השורה הזו.")
    ctx.ok(f"המיגרציות רצו ({len(migration_files())} קבצים)")


def step_test(ctx):
    try:
        ctx.api.sql(ctx.ref, read_text(TEST_SQL))
    except ApiError as e:
        m = re.search(r"RLS_TESTS_PASSED \((\d+) checks\)", e.text)
        if m:
            ctx.ok(f"בדיקת RLS עברה ({m.group(1)} בדיקות: לקוח א' לא רואה את ב', אדמין רואה הכל)")
            return True
        raise SetupError("❌ בדיקת RLS נכשלה: " + e.text[:400] + "\nעוצר. להעביר לקלוד את השורה הזו.")
    raise SetupError("❌ בדיקת RLS לא החזירה את התוצאה הצפויה (RLS_TESTS_PASSED). עוצר.")


# ------------------------------------------------------------------ step: private.settings
def step_settings(ctx):
    b = ctx.brand
    u = site_urls(b)
    s = b.get("senders", {})
    vals = {
        "admin_url": u["admin"], "portal_url": u["portal"], "quote_url": u["quote"],
        "client_from": s.get("quotes") or s.get("transactional") or "",
        "admin_from": s.get("alerts") or s.get("transactional") or "",
        "reply_to": s.get("reply_to") or b.get("support_email") or "",
    }
    admin = (b.get("owner") or {}).get("admin_email") or ""
    if admin:
        vals["admin_email"] = admin
    sets = ", ".join(f"{k} = {sql_lit(v)}" for k, v in vals.items())
    ctx.api.sql(ctx.ref, f"update private.settings set {sets}, updated_at = now() where id = 1;")
    ctx.ok("private.settings עודכן מ-brand.json (כתובות, שולחים" + (", מייל אדמין)" if admin else ")"))


# ------------------------------------------------------------------ step: auth
def auth_template(brand):
    tpl = read_text(AUTH_TEMPLATE)
    return tpl.replace("{{BRAND_NAME}}", brand.get("name", "")).replace("{{SUPPORT_EMAIL}}", brand.get("support_email", ""))


def step_auth(ctx):
    b = ctx.brand
    u = site_urls(b)
    tpl = auth_template(b)
    subject = "Your sign-in code: {{ .Token }}"
    body = {
        "site_url": u["portal"],
        "uri_allow_list": ",".join(u["allow"]),
        "external_email_enabled": True,
        "mailer_autoconfirm": False,
        "mailer_secure_email_change_enabled": True,
        "mailer_otp_length": 6,
        "mailer_otp_exp": 1800,
        "mailer_subjects_magic_link": subject,
        "mailer_templates_magic_link_content": tpl,
        "mailer_subjects_confirmation": subject,
        "mailer_templates_confirmation_content": tpl,
        "disable_signup": False,
    }
    rk = ctx.sec.get("RESEND_API_KEY")
    if rk:
        check_key(rk, "RESEND_API_KEY")
        name, addr = parse_sender(smtp_sender(b, ctx.args.smtp_from))
        body.update({"smtp_admin_email": addr, "smtp_host": "smtp.resend.com", "smtp_port": "465",
                     "smtp_user": "resend", "smtp_pass": rk, "smtp_sender_name": name or b.get("name", ""),
                     "smtp_max_frequency": 30, "rate_limit_email_sent": 60})
    ctx.api.req("PATCH", f"/projects/{ctx.ref}/config/auth", body)
    ctx.ok("Auth הוגדר: קישור + קוד 6 ספרות (30 דק'), כתובת אתר והפניות"
           + (f", SMTP של Resend (שולח {body['smtp_admin_email']})" if rk else ""))
    if not rk:
        ctx.warn("אין RESEND_API_KEY: המיילים יוצאים מהשרת המובנה של Supabase (מוגבל ל-2–4 בשעה). מספיק לבדיקה בלבד.")


def step_google(ctx):
    cid = ctx.sec.get("GOOGLE_OAUTH_CLIENT_ID", "")
    csec = ctx.sec.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
    if not (cid and csec):
        ctx.google_on = False
        say("  Google: אין Client ID/Secret ב-.secrets.env, מדלג (כפתור Google יישאר כבוי).")
        return
    ctx.api.req("PATCH", f"/projects/{ctx.ref}/config/auth", {
        "external_google_enabled": True, "external_google_client_id": cid, "external_google_secret": csec})
    ctx.google_on = True
    ctx.ok("כניסה עם Google הופעלה")


def step_apple(ctx):
    vals = {k: ctx.sec.get(k, "") for k in APPLE_KEYS}
    if not all(vals.values()):
        ctx.apple_on = False
        say("  Apple: חסרים " + ", ".join(k for k, v in vals.items() if not v) + " ב-.secrets.env, מדלג (כפתור Apple יישאר כבוי).")
        return
    sid, team, kid, p8 = (vals[k].strip() for k in APPLE_KEYS)
    if not re.fullmatch(r"[A-Za-z0-9.\-]{3,100}", sid) or not re.fullmatch(r"[A-Z0-9]{10}", team) or not re.fullmatch(r"[A-Z0-9]{10}", kid):
        raise SetupError("❌ APPLE_SERVICES_ID / APPLE_TEAM_ID / APPLE_KEY_ID נראים לא תקינים (Team ID ו-Key ID = 10 תווים גדולים/ספרות).")
    p8 = os.path.expanduser(p8)
    if not os.path.isfile(p8):
        raise SetupError(f"❌ קובץ ה-.p8 לא נמצא בנתיב שב-APPLE_P8_PATH. להוריד שוב מ-developer.apple.com (Keys) ולעדכן את הנתיב.")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from apple_secret import MAX_DAYS, make_secret
    secret = make_secret(team, kid, sid, p8, MAX_DAYS)
    ctx.api.redact.values.append(secret)
    ctx.api.req("PATCH", f"/projects/{ctx.ref}/config/auth", {
        "external_apple_enabled": True, "external_apple_client_id": sid, "external_apple_secret": secret})
    ctx.apple_on = True
    exp = time.strftime("%d.%m.%Y", time.localtime(time.time() + MAX_DAYS * 86400))
    ctx.ok(f"כניסה עם Apple הופעלה (Services ID {sid}). הסוד תקף עד {exp}: לפני כן להריץ שוב --only apple")


# ------------------------------------------------------------------ step: storage
def step_storage(ctx):
    rows = ctx.api.sql(ctx.ref, "select id, public from storage.buckets order by id;") or []
    have = {r.get("id"): r.get("public") for r in rows}
    missing = [b for b in BUCKETS if b not in have]
    if missing:
        say("  חסרים דליים, מריץ שוב את מיגרציית האחסון…")
        for f in migration_files():
            if "storage" in f:
                ctx.api.sql(ctx.ref, read_text(os.path.join(MIG_DIR, f)))
        rows = ctx.api.sql(ctx.ref, "select id, public from storage.buckets order by id;") or []
        have = {r.get("id"): r.get("public") for r in rows}
        missing = [b for b in BUCKETS if b not in have]
    if missing:
        raise SetupError("❌ דליי אחסון חסרים: " + ", ".join(missing))
    if have.get("client-files") is not False or have.get("videos-public") is not True:
        raise SetupError("❌ הרשאות הדליים לא נכונות (client-files חייב להיות פרטי, videos-public ציבורי).")
    ctx.ok("אחסון: client-files (פרטי) + videos-public (ציבורי)")


# ------------------------------------------------------------------ step: vault + function secrets
VAULT_KEYS = (("RESEND_API_KEY", "resend_api_key", "Resend key (pg_net e-mail triggers)"),
              ("ANTHROPIC_API_KEY", "anthropic_api_key", "Claude API key"))
FUNCTION_SECRET_KEYS = ("ANTHROPIC_API_KEY", "RESEND_API_KEY", "ZAPIER_SIGNING_SECRET")


def vault_put(ctx, name, val, desc):
    ctx.api.sql(ctx.ref, f"""do $v$ declare sid uuid; begin
  select id into sid from vault.secrets where name = {sql_lit(name)};
  if sid is null then perform vault.create_secret({sql_lit(val)}, {sql_lit(name)}, {sql_lit(desc)});
  else perform vault.update_secret(sid, {sql_lit(val)}); end if; end $v$;""")


def secret_key_from_file(ctx):
    """The new-style secret key from .secrets.env (SUPABASE_SECRET_KEY), validated; "" when absent. Never printed."""
    key = ctx.sec.get(SECRET_KEY_ENV, "")
    if not key:
        return ""
    if not key.startswith("sb_secret_") or not re.fullmatch(r"[A-Za-z0-9_\-]{20,400}", key):
        raise SetupError(f"❌ {SECRET_KEY_ENV} בקובץ .secrets.env צריך להתחיל ב-sb_secret_ (מפתח סודי חדש). "
                         "למחוק את השורה ולהריץ: python3 tools/us_setup.py --only supabase-keys")
    ctx.api.redact.values.append(key)
    return key


def server_key(ctx):
    """The server key for Vault (pg_net -> Edge Functions): the new-style secret key from .secrets.env, else the legacy
    service_role JWT from the API (warned: it stops working once legacy keys are off). Never printed."""
    key = secret_key_from_file(ctx)
    if key:
        return key
    keys = ctx.api.req("GET", f"/projects/{ctx.ref}/api-keys?reveal=true") or []
    key = next((k.get("api_key") for k in keys if k.get("name") == "service_role" and k.get("api_key")), None)
    if not key or not re.fullmatch(r"[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+", key):
        raise SetupError(f"❌ אין {SECRET_KEY_ENV} ב-.secrets.env וגם לא נמצא מפתח service_role (JWT) ישן לפרויקט. "
                         "להריץ: python3 tools/us_setup.py --only supabase-keys ואז שוב את הפקודה הזו. להעביר לקלוד.")
    ctx.api.redact.values.append(key)
    ctx.warn(f"Vault מקבל את מפתח ה-service_role הישן (JWT). כשמכבים את המפתחות הישנים זה יפסיק לעבוד: "
             f"להריץ --only supabase-keys ואז --only vault,secrets.")
    return key


def step_vault(ctx):
    for env, _, _ in VAULT_KEYS:          # validate every pasted key before any SQL is sent
        if ctx.sec.get(env):
            check_key(ctx.sec[env], env)
    # A8 (pg_net → Edge Functions): project URL + server key, always (the key is validated before any SQL is sent).
    key = server_key(ctx)
    vault_put(ctx, "ailab_us_project_url", f"https://{ctx.ref}.supabase.co", "ailab-us project URL (A8 cron/pg_net)")
    vault_put(ctx, "ailab_us_service_role_key", key, "server key (sb_secret_ or legacy JWT) for pg_net -> Edge Functions (A8)")
    done = ["ailab_us_project_url", "ailab_us_service_role_key"]
    for env, name, desc in VAULT_KEYS:
        val = ctx.sec.get(env)
        if not val:
            continue
        check_key(val, env)
        vault_put(ctx, name, val, desc)
        done.append(name)
    ctx.ok("Vault: " + ", ".join(done))
    if len(done) == 2:
        ctx.warn("Vault: אין עדיין מפתחות Resend/Claude ב-.secrets.env, נשמרו רק כתובת הפרויקט ומפתח השירות.")


def step_secrets(ctx):
    items = []
    for k in FUNCTION_SECRET_KEYS:
        v = ctx.sec.get(k)
        if v:
            check_key(v, k)
            items.append({"name": k, "value": v})
    if secret_key_from_file(ctx):
        items.append({"name": EDGE_SECRET_NAME, "value": ctx.sec[SECRET_KEY_ENV]})
    if not items:
        ctx.warn("סודות Edge Functions: אין עדיין מפתחות ב-.secrets.env, דילגתי.")
        return
    ctx.api.req("POST", f"/projects/{ctx.ref}/secrets", items)
    ctx.ok("סודות Edge Functions: " + ", ".join(i["name"] for i in items))


# ------------------------------------------------------------------ step: functions
def function_slugs():
    if not os.path.isdir(FUNCTIONS_DIR):
        return []
    return sorted(d for d in os.listdir(FUNCTIONS_DIR)
                  if not d.startswith((".", "_")) and os.path.isfile(os.path.join(FUNCTIONS_DIR, d, "index.ts")))


def _collect(slug):
    """Files to upload: the function folder + supabase/functions/_shared (imports use ../_shared/...)."""
    out = []
    for folder in (slug, "_shared"):
        base = os.path.join(FUNCTIONS_DIR, folder)
        if not os.path.isdir(base):
            continue
        for dp, dn, fn in os.walk(base):
            dn[:] = [d for d in dn if d not in ("node_modules", "fixtures", "tests") and not d.startswith(".")]
            for f in sorted(fn):
                if f.endswith((".ts", ".js", ".mjs", ".json", ".tsx", ".html", ".txt")) and not f.endswith("_test.ts"):
                    p = os.path.join(dp, f)
                    out.append((os.path.relpath(p, FUNCTIONS_DIR).replace(os.sep, "/"), _read_bytes(p)))
    return out


def _read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


def multipart(fields, files):
    boundary = "----ailabus" + uuid.uuid4().hex
    parts = []
    for name, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n'
                     f'Content-Type: application/json\r\n\r\n'.encode() + value.encode() + b"\r\n")
    for path, data in files:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path}"\r\n'
                     f'Content-Type: application/octet-stream\r\n\r\n'.encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), "multipart/form-data; boundary=" + boundary


def deploy_api(ctx, slug):
    meta = {"name": slug, "entrypoint_path": f"{slug}/index.ts", "verify_jwt": slug not in NO_VERIFY_JWT}
    raw, ctype = multipart([("metadata", json.dumps(meta))], _collect(slug))
    ctx.api.req("POST", f"/projects/{ctx.ref}/functions/deploy?slug={slug}", raw=raw, content_type=ctype)


def deploy_cli(ctx, slug, cli):
    cmd = [cli, "functions", "deploy", slug, "--project-ref", ctx.ref, "--use-api"]
    if slug in NO_VERIFY_JWT:
        cmd.append("--no-verify-jwt")
    env = dict(os.environ, SUPABASE_ACCESS_TOKEN=ctx.sec["SUPABASE_ACCESS_TOKEN"])  # env, never argv
    r = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise ApiError("CLI", slug, r.returncode, ctx.api.redact((r.stderr or r.stdout)[-600:]))


def step_functions(ctx):
    slugs = function_slugs()
    if not slugs:
        ctx.warn("Edge Functions: אין עדיין פונקציות ב-supabase/functions (נוצרות ב-A6/A8). דילגתי.")
        return
    cli = shutil.which("supabase") if not ctx.args.functions_via_api else None
    for slug in slugs:
        try:
            deploy_cli(ctx, slug, cli) if cli else deploy_api(ctx, slug)
            say(f"  נפרסה {slug}" + (" (CLI)" if cli else " (API)"))
        except ApiError as e:
            ctx.functions_skipped.append(slug)
            ctx.fail(f"פריסת {slug} נכשלה: {e.text[:200]}")
    if not ctx.functions_skipped:
        ctx.ok("Edge Functions נפרסו: " + ", ".join(slugs))


# ------------------------------------------------------------------ step: cron
def cron_job_names():
    """Every pg_cron job the migrations schedule (incl. A8's private.install_email_jobs()), read from the SQL files."""
    names = list(CRON_JOBS_BASE)
    for f in migration_files():
        for n in re.findall(r"cron\.schedule\(\s*'(ailab-us-[a-z0-9-]+)'", read_text(os.path.join(MIG_DIR, f))):
            if n not in names:
                names.append(n)
    return tuple(names)


def has_email_jobs():
    return any("install_email_jobs" in read_text(os.path.join(MIG_DIR, f)) for f in migration_files())


def cron_jobs(ctx):
    rows = ctx.api.sql(ctx.ref, "select jobname, schedule, active from cron.job order by jobname;") or []
    return {r.get("jobname"): r for r in rows}


def step_cron(ctx):
    if has_email_jobs():
        # A8: needs Vault ailab_us_project_url + ailab_us_service_role_key (step vault); idempotent
        ctx.api.sql(ctx.ref, "select private.install_email_jobs();")
    want = cron_job_names()
    jobs = cron_jobs(ctx)
    if not all(j in jobs for j in CRON_JOBS_BASE):
        say("  משימת cron חסרה, מריץ שוב את מיגרציית השמירה…")
        ctx.api.sql(ctx.ref, read_text(os.path.join(MIG_DIR, RETENTION_MIGRATION)))
        jobs = cron_jobs(ctx)
    missing = [j for j in want if j not in jobs]
    if missing:
        raise SetupError("❌ משימות cron חסרות: " + ", ".join(missing))
    ctx.ok(f"cron ({len(want)} משימות): " + ", ".join(f"{j} ({jobs[j].get('schedule')})" for j in want))


# ------------------------------------------------------------------ step: config.js
def public_key(ctx):
    keys = ctx.api.req("GET", f"/projects/{ctx.ref}/api-keys?reveal=false") or []
    pub = next((k.get("api_key") for k in keys if k.get("type") == "publishable" and k.get("api_key")), None)
    anon = next((k.get("api_key") for k in keys if k.get("name") == "anon" and k.get("api_key")), None)
    key = pub or anon
    if not key:
        raise SetupError("❌ לא נמצא מפתח ציבורי (publishable/anon) לפרויקט.")
    if key.startswith("sb_secret_") or "service_role" in key:
        raise SetupError("❌ התקבל מפתח סודי במקום ציבורי. עוצר ולא כותב config.js.")
    return key


def google_enabled(ctx):
    if ctx.google_on is not None:
        return ctx.google_on
    cfg = ctx.api.req("GET", f"/projects/{ctx.ref}/config/auth") or {}
    return bool(cfg.get("external_google_enabled"))


def apple_enabled(ctx):
    if ctx.apple_on is not None:
        return ctx.apple_on
    cfg = ctx.api.req("GET", f"/projects/{ctx.ref}/config/auth") or {}
    return bool(cfg.get("external_apple_enabled"))


def render_config(url, key, google_on, brand, supabase_js, apple_on=False):
    flags = {"show_founder_price": bool(brand.get("show_founder_price")), "legal_final": bool(brand.get("legal_final"))}
    return f"""/* Site-wide runtime config. PUBLIC values only (URL + publishable/anon key are public by design; never a service key).
   generated-by: tools/us_setup.py (task A2). Re-run `python3 tools/us_setup.py --only config` to refresh; do not edit by hand.
   BACKEND: 'mock'     -> everything runs in the browser (localStorage), no network
            'supabase' -> real project; needs SUPABASE_URL + SUPABASE_ANON_KEY
   ALLOW_MOCK_SWITCH: when true, ?mock=1 forces the mock backend on any host (always allowed on localhost).
   FEATURES: copied from config/brand.json. */
window.SITE_CONFIG = {{
  BACKEND: 'supabase',
  SUPABASE_URL: {json.dumps(url)},
  SUPABASE_ANON_KEY: {json.dumps(key)},
  SUPABASE_JS: {json.dumps(supabase_js)},
  GOOGLE_ENABLED: {'true' if google_on else 'false'},
  APPLE_ENABLED: {'true' if apple_on else 'false'},
  ALLOW_MOCK_SWITCH: false,
  BUCKET: 'client-files',
  MAX_FILES: 5,
  MAX_FILE_MB: 10,
  FEATURES: {json.dumps(flags)}
}};
"""


def step_config(ctx):
    key = public_key(ctx)
    ctx.public_key = key
    cur = read_text(CONFIG_JS) if os.path.exists(CONFIG_JS) else ""
    m = re.search(r"SUPABASE_JS:\s*['\"](https://[^'\"]+)['\"]", cur)
    text = render_config(f"https://{ctx.ref}.supabase.co", key, google_enabled(ctx), ctx.brand,
                         m.group(1) if m else SUPABASE_JS_DEFAULT, apple_enabled(ctx))
    with open(CONFIG_JS, "w", encoding="utf-8") as f:
        f.write(text)
    ctx.ok(f"נכתב {os.path.relpath(CONFIG_JS, ROOT)} (BACKEND 'supabase', כתובת + מפתח ציבורי, Google {'פעיל' if 'GOOGLE_ENABLED: true' in text else 'כבוי'}, Apple {'פעיל' if 'APPLE_ENABLED: true' in text else 'כבוי'})")


# ------------------------------------------------------------------ step: ping
def step_ping(ctx):
    key = ctx.public_key or public_key(ctx)
    hdr = {"apikey": key}
    if key.count(".") == 2:            # legacy anon JWT also goes in Authorization
        hdr["Authorization"] = "Bearer " + key
    res = ctx.api.req("POST", "/rest/v1/rpc/ping", {}, base=f"https://{ctx.ref}.supabase.co", auth=False,
                      extra_headers=hdr)
    if res != "ok":
        raise SetupError(f"❌ ping() החזיר {res!r} במקום 'ok'.")
    ctx.ok("ping() דרך ה-REST עם המפתח הציבורי מחזיר ok")


# ------------------------------------------------------------------ step: paypal (opt-in: --only paypal)
PAYPAL_API = {"sandbox": "https://api-m.sandbox.paypal.com", "live": "https://api-m.paypal.com"}
# = WEBHOOK_EVENTS in supabase/functions/paypal-webhook/index.ts (tools/us_setup_test.py checks they match)
PAYPAL_EVENTS = ("PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED",
                 "PAYMENT.CAPTURE.DECLINED", "CUSTOMER.DISPUTE.CREATED")
PAYPAL_KEYS = {"sandbox": ("PAYPAL_SANDBOX_CLIENT_ID", "PAYPAL_SANDBOX_CLIENT_SECRET"),
               "live": ("PAYPAL_LIVE_CLIENT_ID", "PAYPAL_LIVE_CLIENT_SECRET")}
PAYPAL_ID_RX = r"[A-Za-z0-9_\-]{16,128}"     # client id: same rule as sync_config.py / quote_view.mjs paypalOn()


def run_sync_config():
    """config/brand.json -> site/, supabase/functions/_shared, runtime/ copies (patched by the tests)."""
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "sync_config.py")], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SetupError("❌ tools/sync_config.py נכשל אחרי עדכון config/brand.json:\n" + (r.stdout + r.stderr)[-600:])


def write_paypal_config(ctx, **changes):
    """Update config/brand.json payments.paypal (public values only) keeping the file's formatting, then sync the copies."""
    brand = load_brand()
    pay = brand.setdefault("payments", {})
    pp = pay.setdefault("paypal", {"enabled": False, "env": "sandbox", "client_id": ""})
    pp.update(changes)
    with open(BRAND_JSON, "w", encoding="utf-8") as f:
        f.write(json.dumps(brand, indent=2, ensure_ascii=False) + "\n")
    ctx.brand = brand
    run_sync_config()
    return pp


def paypal_call(ctx, env, method, path, headers, data=None):
    status, payload = ctx.api.transport(method, PAYPAL_API[env] + path, headers, data)
    text = (payload or b"").decode("utf-8", errors="replace")
    try:
        body = json.loads(text) if text.strip() else {}
    except ValueError:
        body = {}
    return status, body, ctx.api.redact(text)


def step_paypal(ctx):
    a = ctx.args
    if a.paypal_disable:
        write_paypal_config(ctx, enabled=False)
        ctx.ok("PayPal כובה ב-config/brand.json (התשלום בכרטיס לא יוצג). עכשיו: --only functions ואז לדחוף את האתר.")
        return
    env = a.paypal_env
    kid, ksec = PAYPAL_KEYS[env]
    cid, secret = ctx.sec.get(kid, ""), ctx.sec.get(ksec, "")
    if not cid or not secret:
        raise SetupError(f"❌ חסרים {kid} ו/או {ksec} בקובץ .secrets.env. המדריך: docs/kits/paypal-setup.he.md (בריפו הפרטי).")
    for value, label in ((cid, kid), (secret, ksec)):
        if not re.fullmatch(PAYPAL_ID_RX if label == kid else r"[A-Za-z0-9_\-]{20,200}", value):
            raise SetupError(f"❌ {label} בקובץ .secrets.env נראה לא תקין (רק אותיות, ספרות, _ ו-). להעתיק שוב מ-developer.paypal.com.")
    ctx.api.redact.values.extend([secret, cid])
    # 1. the keys work (OAuth client credentials)
    basic = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    ctx.api.redact.values.append(basic)
    status, body, text = paypal_call(ctx, env, "POST", "/v1/oauth2/token", {"Authorization": "Basic " + basic, "Accept": "application/json",
                                     "Content-Type": "application/x-www-form-urlencoded"}, b"grant_type=client_credentials")
    token = body.get("access_token") if isinstance(body, dict) else None
    if status != 200 or not isinstance(token, str) or not token:
        raise SetupError(f"❌ PayPal ({env}) לא קיבל את המפתחות (HTTP {status}). לבדוק ש-{kid} ו-{ksec} הם של אותה אפליקציה "
                         f"ושל {'Sandbox' if env == 'sandbox' else 'Live'}.")
    ctx.api.redact.values.append(token)
    auth = {"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"}
    # 2. the webhook: find ours by URL (Meir may have made it by hand), else create it; make sure it has our 4 events
    url = f"https://{ctx.ref}.supabase.co/functions/v1/paypal-webhook"
    want = [{"name": n} for n in PAYPAL_EVENTS]
    status, body, text = paypal_call(ctx, env, "GET", "/v1/notifications/webhooks", auth)
    if status != 200:
        raise SetupError(f"❌ PayPal: קריאת ה-webhooks נכשלה (HTTP {status}): {text[:200]}")
    hook = next((h for h in body.get("webhooks", []) if isinstance(h, dict) and h.get("url") == url), None)
    if hook:
        have = {e.get("name") for e in hook.get("event_types", []) if isinstance(e, dict)}
        if not set(PAYPAL_EVENTS) <= have:
            status, _, text = paypal_call(ctx, env, "PATCH", f"/v1/notifications/webhooks/{hook.get('id', '')}", auth,
                                          json.dumps([{"op": "replace", "path": "/event_types", "value": want}]).encode())
            if status not in (200, 204):
                raise SetupError(f"❌ PayPal: עדכון האירועים של ה-webhook נכשל (HTTP {status}): {text[:200]}")
            say("  עודכנו האירועים של ה-webhook הקיים")
        wid = hook.get("id", "")
    else:
        status, body, text = paypal_call(ctx, env, "POST", "/v1/notifications/webhooks", auth,
                                         json.dumps({"url": url, "event_types": want}).encode())
        if status not in (200, 201):
            raise SetupError(f"❌ PayPal: יצירת ה-webhook נכשלה (HTTP {status}): {text[:200]}")
        wid = body.get("id", "")
        say("  נוצר webhook ב-PayPal")
    if not re.fullmatch(r"[A-Za-z0-9\-]{8,64}", str(wid)):
        raise SetupError("❌ PayPal לא החזיר מזהה webhook תקין. להעביר לקלוד.")
    # 3. Edge Function secrets (values never printed)
    ctx.api.req("POST", f"/projects/{ctx.ref}/secrets", [
        {"name": "PAYPAL_CLIENT_ID", "value": cid}, {"name": "PAYPAL_CLIENT_SECRET", "value": secret},
        {"name": "PAYPAL_ENV", "value": env}, {"name": "PAYPAL_WEBHOOK_ID", "value": wid}])
    # 4. public config (the browser's SDK must use the same app + environment as the server)
    pp = write_paypal_config(ctx, env=env, client_id=cid, **({"enabled": True} if a.paypal_enable else {}))
    ctx.ok(f"PayPal {env}: המפתחות תקינים, webhook מוגדר ({len(PAYPAL_EVENTS)} אירועים), 4 סודות הוגדרו בפונקציות, "
           f"config/brand.json עודכן ({'מופעל' if pp.get('enabled') else 'עדיין כבוי'})")
    if a.paypal_enable and env == "sandbox":
        ctx.warn("Sandbox מופעל בקונפיג: רק לבדיקה. לא לדחוף את config/brand.json ל-GitHub במצב הזה.")
    say("  הבא: python3 tools/us_setup.py --only functions (הפונקציות קוראות את brand.json בזמן הפריסה), ואז לדחוף את האתר.")


# ------------------------------------------------------------------ step: supabase-keys (opt-in: --only supabase-keys)
def step_supabase_keys(ctx):
    """New key model: one named secret key for everything server-side. Idempotent: an existing key (file or project)
    is reused, nothing is ever deleted or rotated here. The value is never printed."""
    name = ctx.args.key_name or DEFAULT_KEY_NAME
    if not re.fullmatch(KEY_NAME_RX, name):
        raise SetupError("❌ --key-name: רק אותיות קטנות, ספרות ו-_ (3–41 תווים, מתחיל באות).")
    key = secret_key_from_file(ctx)
    if key:
        say(f"  {SECRET_KEY_ENV} כבר קיים ב-.secrets.env, לא נוצר מפתח חדש")
    else:
        keys = ctx.api.req("GET", f"/projects/{ctx.ref}/api-keys?reveal=true") or []
        mine = next((k for k in keys if k.get("type") == "secret" and k.get("name") == name), None)
        if mine and mine.get("api_key"):
            key = mine["api_key"]
            say(f"  מפתח סודי בשם {name} כבר קיים בפרויקט, משתמש בו")
        else:
            created = ctx.api.req("POST", f"/projects/{ctx.ref}/api-keys", {
                "type": "secret", "name": name,
                "description": "ailab-us server key: Edge Functions (SB_SERVICE_KEY), Vault, Railway runtime, weekly report"}) or {}
            key = created.get("api_key") or ""
            say(f"  נוצר מפתח סודי חדש בשם {name}")
        if not isinstance(key, str) or not key.startswith("sb_secret_") or not re.fullmatch(r"[A-Za-z0-9_\-]{20,400}", key):
            raise SetupError("❌ Supabase לא החזיר מפתח sb_secret_ תקין. להעביר לקלוד.")
        ctx.api.redact.values.append(key)
        append_secret(SECRET_KEY_ENV, key)
        ctx.sec[SECRET_KEY_ENV] = key
    ctx.api.req("POST", f"/projects/{ctx.ref}/secrets", [{"name": EDGE_SECRET_NAME, "value": key}])
    ctx.ok(f"מפתח סודי {name} (sb_secret_…): שמור ב-.secrets.env בשורה {SECRET_KEY_ENV}, וסוד {EDGE_SECRET_NAME} הוגדר ב-Edge Functions")
    say("  הבא (לפי docs/runbooks/supabase-legacy-keys-off.md בריפו הפרטי):")
    say("   1. python3 tools/us_setup.py --only vault,secrets,functions   (Vault + פריסת הפונקציות עם המפתח החדש)")
    say(f"   2. Railway → runtime → Variables → SUPABASE_SERVICE_ROLE_KEY = הערך של {SECRET_KEY_ENV} מ-.secrets.env")
    say(f"   3. GitHub (ריפו פרטי) → secret US_SUPABASE_SERVICE_KEY = אותו ערך")
    say("   4. רק אחרי שהכול עובד: בדשבורד Supabase → Settings → API Keys → Legacy API keys → Disable")


# ------------------------------------------------------------------ checklist
def checklist(ctx):
    ref = ctx.ref or "<ref>"
    sec = ctx.sec
    lines = ["", "📋 מה נשאר לעשות ידנית (לפי הסדר):"]
    n = 1

    def add(t):
        nonlocal n
        lines.append(f"  {n}. {t}"); n += 1

    add("להחזיר לקלוד: 'us_setup הסתיים' והוא יריץ את tools/us_setup_check.py ויבדוק הכל.")
    add("keep-alive (שלא יירדם): ב-GitHub של הריפו → Settings → Secrets and variables → Actions → New repository secret.\n"
        f"       שם US_SUPABASE_URL, ערך https://{ref}.supabase.co ; שם US_SUPABASE_KEY, ערך המפתח הציבורי מ-site/assets/config.js.\n"
        "       (אפשר גם לבקש מקלוד להריץ gh secret set.)")
    if not sec.get("RESEND_API_KEY"):
        add("Resend: resend.com → API Keys → Create → להדביק ב-.secrets.env בשורה RESEND_API_KEY= ולהריץ:\n"
            "       python3 tools/us_setup.py --only auth,vault,secrets")
    add(f"מיילי הכניסה יוצאים כרגע מ-{parse_sender(smtp_sender(ctx.brand, ctx.args.smtp_from))[1]}. כשהדומיין החדש "
        "Verified ב-Resend: לשנות את smtp_from ב-config/brand.json ולהריץ --only auth.")
    if not sec.get("ANTHROPIC_API_KEY"):
        add("מפתח Claude: console.anthropic.com → API Keys → Create → .secrets.env בשורה ANTHROPIC_API_KEY= ואז:\n"
            "       python3 tools/us_setup.py --only vault,secrets")
    if not sec.get("GOOGLE_OAUTH_CLIENT_ID"):
        add("Google (לא חובה): ב-Google Cloud → Credentials → OAuth client (Web). Authorized redirect URI:\n"
            f"       https://{ref}.supabase.co/auth/v1/callback ; להדביק ID+Secret ב-.secrets.env ולהריץ --only google,config")
    else:
        add(f"Google Cloud → OAuth client: לוודא ש-https://{ref}.supabase.co/auth/v1/callback נמצא ב-Authorized redirect URIs.")
    if not all(sec.get(k) for k in APPLE_KEYS):
        add("Apple (לא חובה): Services ID + מפתח Sign in with Apple (.p8) ב-developer.apple.com, לפי docs/runbooks/social-signin-setup.md "
            "(ריפו פרטי); להדביק APPLE_SERVICES_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_P8_PATH ב-.secrets.env ולהריץ --only apple,config")
    else:
        add("Apple: הסוד תקף 175 יום. תזכורת ביומן חודש לפני, ואז: python3 tools/us_setup.py --only apple")
    if ctx.functions_skipped or not function_slugs():
        add("Edge Functions: כשיהיו (A6/A8), להריץ --only functions. אם הפריסה דרך ה-API נכשלת:\n"
            "       brew install supabase/tap/supabase ואז שוב --only functions (הסקריפט משתמש ב-CLI אם הוא מותקן).")
    add("דשבורד Supabase → Authentication → Emails: לשלוח לעצמך קוד כניסה מ-/start/ ולוודא שהגיע מייל עם קוד 6 ספרות וקישור.")
    add("כשהדומיין עולה: אם site_url ב-config/brand.json השתנה, להריץ --only settings,auth.")
    say("\n".join(lines))


# ------------------------------------------------------------------ dry-run / plan
def dry_run(args, sec, brand):
    u = site_urls(brand)
    have = lambda *k: "יש" if secret_get(sec, *k) else "אין"
    steps = parse_only(args.only) or STEPS
    say("🔎 מצב dry-run: שום קריאת רשת לא מתבצעת. זו התוכנית:")
    say(f"  פרויקט: {args.ref or ref_from_config() or NAME} | אזור {REGION} | Free | "
        + ("ייווצר אם לא קיים (--create)" if args.create else "רק פרויקט קיים (בלי --create)"))
    say(f"  ארגון: {args.org or sec.get('SUPABASE_ORG_SLUG') or 'אוטומטי (אם יש יותר מאחד: חובה --org)'}")
    say(f"  סודות ב-.secrets.env (רק יש/אין): טוקן Supabase {have('SUPABASE_ACCESS_TOKEN')}, Resend {have('RESEND_API_KEY')}, "
        f"Claude {have('ANTHROPIC_API_KEY')}, Google {have('GOOGLE_OAUTH_CLIENT_ID')}, Apple {have('APPLE_KEY_ID')}, "
        f"סיסמת DB {have('SUPABASE_DB_PASSWORD')}, מפתח סודי חדש {have(SECRET_KEY_ENV)}")
    plan = {
        "migrate": "מיגרציות לפי הסדר: " + ", ".join(migration_files()),
        "test": "בדיקת RLS מרחוק (supabase/tests/rls_test.sql), חייב RLS_TESTS_PASSED",
        "settings": f"private.settings ← brand.json (portal {u['portal']})",
        "auth": f"Auth: site_url {u['portal']}, הפניות {', '.join(u['allow'])}, קוד 6 ספרות/30 דק', "
                + (f"SMTP Resend משולח {parse_sender(smtp_sender(brand, args.smtp_from))[1]}" if sec.get("RESEND_API_KEY")
                   else "בלי SMTP (אין מפתח Resend)"),
        "google": "Google: " + ("יופעל" if sec.get("GOOGLE_OAUTH_CLIENT_ID") else "ידולג (אין פרטים)"),
        "apple": "Apple: " + ("יופעל (סוד ל-175 יום)" if all(sec.get(k) for k in APPLE_KEYS) else "ידולג (חסרים APPLE_* ב-.secrets.env)"),
        "storage": "אחסון: " + ", ".join(BUCKETS),
        "vault": "Vault: ailab_us_project_url, ailab_us_service_role_key ("
                 + (f"המפתח הסודי החדש מ-{SECRET_KEY_ENV}" if sec.get(SECRET_KEY_ENV) else "service_role ישן מה-API, לא מודפס") + ")"
                 + "".join(", " + n for e, n, _ in VAULT_KEYS if sec.get(e)),
        "secrets": "סודות Edge Functions: " + (", ".join([k for k in FUNCTION_SECRET_KEYS if sec.get(k)]
                                                      + ([EDGE_SECRET_NAME] if sec.get(SECRET_KEY_ENV) else [])) or "ידולג"),
        "functions": "Edge Functions: " + (", ".join(function_slugs()) or "אין עדיין, ידולג")
                     + (" (CLI)" if shutil.which("supabase") else " (Management API)"),
        "cron": ("select private.install_email_jobs(); ואז " if has_email_jobs() else "")
                + f"בדיקת {len(cron_job_names())} משימות: " + ", ".join(cron_job_names()),
        "config": f"כתיבת {os.path.relpath(CONFIG_JS, ROOT)} עם BACKEND 'supabase'",
        "ping": "בדיקת public.ping() עם המפתח הציבורי",
        "paypal": ("כיבוי PayPal ב-config/brand.json" if args.paypal_disable else
                   f"PayPal {args.paypal_env}: מפתחות {have(*PAYPAL_KEYS[args.paypal_env])}, webhook, 4 סודות לפונקציות, config/brand.json"
                   + (" (מופעל)" if args.paypal_enable else " (נשאר כבוי)")),
        "supabase-keys": f"מפתח סודי חדש {args.key_name or DEFAULT_KEY_NAME}: " + ("כבר ב-.secrets.env" if sec.get(SECRET_KEY_ENV)
                         else "ייווצר (או ייקרא אם קיים) ויישמר ב-.secrets.env") + f", וסוד {EDGE_SECRET_NAME} בפונקציות",
    }
    for i, s in enumerate(steps, 1):
        say(f"  {i:>2}. [{s}] {plan[s]}")
    say("✅ dry-run הסתיים. אין שינויים.")


def plan_mode(ctx):
    """Read-only network: orgs, projects, Free slot. No writes."""
    orgs = ctx.api.req("GET", "/organizations") or []
    projects = ctx.api.req("GET", "/projects") or []
    say("ארגונים: " + (", ".join(f"{o.get('name')} ({org_slug(o)})" for o in orgs) or "אין"))
    for p in projects:
        say(f"  פרויקט {p.get('name')} | {project_ref(p)} | {p.get('region')} | {p.get('status')}")
    existing = next((p for p in projects if p.get("name") == NAME), None)
    if existing:
        ctx.ok(f"{NAME} כבר קיים ({project_ref(existing)}); --create לא ייצור עוד אחד")
        return
    org = pick_org(ctx, orgs)
    plan, active = ensure_free_slot(ctx, org, projects)
    ctx.ok(f"יש מקום פנוי בארגון {org.get('name')} (תוכנית {plan or '?'}, {active}/{FREE_ACTIVE_LIMIT} פרויקטים פעילים בכל הארגונים). "
           f"--create ייצור את {NAME} ב-{REGION}")


# ------------------------------------------------------------------ main
def parse_only(only):
    if not only:
        return None
    steps = [s.strip() for s in only.split(",") if s.strip()]
    bad = [s for s in steps if s not in STEPS + OPT_IN_STEPS]
    if bad:
        raise SetupError(f"❌ שלב לא מוכר: {', '.join(bad)}. האפשרויות: {', '.join(STEPS + OPT_IN_STEPS)}")
    return steps


STEP_FUNCS = {"migrate": step_migrate, "test": step_test, "settings": step_settings, "auth": step_auth,
              "google": step_google, "apple": step_apple, "storage": step_storage, "vault": step_vault, "secrets": step_secrets,
              "functions": step_functions, "cron": step_cron, "config": step_config, "ping": step_ping,
              "paypal": step_paypal, "supabase-keys": step_supabase_keys}


def build_parser():
    ap = argparse.ArgumentParser(description="Supabase setup for ailab-us (see module docstring).")
    ap.add_argument("--create", action="store_true", help="create the project if it does not exist")
    ap.add_argument("--ref", help="use this existing project ref")
    ap.add_argument("--org", help="organization slug (required if the account has more than one)")
    ap.add_argument("--only", help="comma list of steps: " + ",".join(STEPS) + " (opt-in: " + ",".join(OPT_IN_STEPS) + ")")
    ap.add_argument("--dry-run", action="store_true", help="print the plan; no network call")
    ap.add_argument("--plan", action="store_true", help="read-only network check: orgs, projects, Free slot")
    ap.add_argument("--smtp-from", help="override SMTP sender, e.g. 'Name <hello@verified-domain>'")
    ap.add_argument("--functions-via-api", action="store_true", help="deploy functions via the API even if the CLI exists")
    ap.add_argument("--paypal-env", choices=("sandbox", "live"), default="sandbox", help="--only paypal: which PayPal app (default sandbox)")
    ap.add_argument("--paypal-enable", action="store_true", help="--only paypal: also set payments.paypal.enabled = true")
    ap.add_argument("--paypal-disable", action="store_true", help="--only paypal: only set payments.paypal.enabled = false")
    ap.add_argument("--key-name", help=f"--only supabase-keys: name of the secret key (default {DEFAULT_KEY_NAME})")
    ap.add_argument("--self-test", action="store_true", help="run offline unit tests (tools/us_setup_test.py)")
    return ap


def run(argv=None, transport=None):
    args = build_parser().parse_args(argv)
    if args.self_test:
        here = os.path.dirname(os.path.abspath(__file__))
        return subprocess.call([sys.executable, os.path.join(here, "us_setup_test.py")])
    if os.path.exists(SECRETS_FILE) and os.stat(SECRETS_FILE).st_mode & 0o077:
        os.chmod(SECRETS_FILE, 0o600)   # secrets file readable by the owner only
    sec = load_secrets()
    brand = load_brand()
    try:
        if args.dry_run:
            dry_run(args, sec, brand)
            return 0
        token = sec.get("SUPABASE_ACCESS_TOKEN", "")
        if not token:
            raise SetupError("❌ חסר SUPABASE_ACCESS_TOKEN. להדביק את הטוקן בקובץ ailab-pro-us/.secrets.env אחרי סימן "
                             "השווה, לשמור ולהריץ שוב (מדריך: docs/runbooks/supabase-us-setup.he.md).")
        if not token.startswith("sbp_"):
            raise SetupError("❌ הטוקן צריך להתחיל ב-sbp_. כנראה הודבק מפתח אחר (sb_publishable / sb_secret). לבדוק את הקובץ.")
        steps = parse_only(args.only) or STEPS
        api = Api(token, Redactor(list(sec.values())), transport)
        ctx = Ctx(args, sec, brand, api)
        if args.plan:
            plan_mode(ctx)
            return 0
        ctx.ref = find_or_create(ctx)
        say(f"פרויקט: {ctx.ref}")
        wait_healthy(ctx)
        for s in steps:
            say(f"\n— {s} —")
            STEP_FUNCS[s](ctx)
        if not args.only or len(steps) > 1:
            checklist(ctx)
        failed = [t for ok, t in ctx.report if ok is False]
        say("\n" + ("❌ הסתיים עם כשלים: " + "; ".join(failed) if failed else "✅ הכל הסתיים בהצלחה."))
        return 1 if failed else 0
    except SetupError as e:
        say(str(e))
        return 1
    except ApiError as e:
        say("❌ שגיאה מ-Supabase: " + str(e)[:500] + "\nעוצר. להעביר לקלוד את השורה הזו.")
        return 1
    except NetError as e:
        say("❌ אין חיבור ל-Supabase (אינטרנט, VPN או שהשרת לא עונה): " + Redactor(list(sec.values()))(str(e))[:300]
            + "\nלבדוק את החיבור ולהריץ שוב את אותה פקודה. הסקריפט ממשיך מאיפה שעצר.")
        return 1


if __name__ == "__main__":
    sys.exit(run())
