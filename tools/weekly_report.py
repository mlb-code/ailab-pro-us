#!/usr/bin/env python3
"""Weekly owner report for Meir (Hebrew, RTL e-mail). Stdlib only. READ-ONLY on every data source.

Sunday 08:00 Asia/Jerusalem time (GitHub Actions: .github/workflows/weekly-report.yml). The runtime already sends a DAILY
summary (runtime/app/reports.py `admin_daily`); this one is the higher-level weekly view: the last 7 days vs. the 7
before, across the site, the sales pipeline, the demo phone line, SMS compliance, Facebook, Upwork, health and costs.

usage (from the repo root):
  python3 tools/weekly_report.py --dry-run    writes docs/reports/weekly/YYYY-MM-DD.html, prints the text version
  python3 tools/weekly_report.py --send       sends it from the transactional sender to owner.admin_email (Resend)
  python3 tools/weekly_report.py --self-test  offline checks of the rendering (no network)

Inputs (environment first; locally falls back to .secrets.env and the meta-ads .env):
  US_SUPABASE_URL            https://<ref>.supabase.co (fallback: site/assets/config.js)
  US_SUPABASE_SERVICE_KEY    service-role key (reads leads/quotes/calls with RLS bypassed). Locally, when it is missing,
                             it is fetched in memory through the Management API with SUPABASE_ACCESS_TOKEN (never printed).
  RESEND_API_KEY             only for --send
  RUNTIME_ADMIN_TOKEN        GET /health/deep on the runtime
  TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN   balance + this week's usage cost
  META_ACCESS_TOKEN / META_PRO_PAGE_ID     Facebook page posts + followers (page token from /me/accounts)
  RUNTIME_URL                optional override of the runtime URL
Static inputs the orchestrator edits: docs/status/upwork.json, docs/status/next.json.
Any source that fails shows "לא זמין" in the report; the report itself still goes out. Exit 1 only if sending fails.
No secret is ever printed or written to the HTML; there is no personal data in the report (counts only).
"""
import argparse
import base64
import datetime as dt
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_FILE = os.path.join(ROOT, ".secrets.env")
META_ENV = os.path.expanduser("~/Desktop/Pyton1/pyton corus 1/meta-ads/.env")
BRAND_JSON = os.path.join(ROOT, "config", "brand.json")
CONFIG_JS = os.path.join(ROOT, "site", "assets", "config.js")
STATUS_DIR = os.path.join(ROOT, "docs", "status")
OUT_DIR = os.path.join(ROOT, "docs", "reports", "weekly")
RUNTIME_URL = "https://runtime-production-7097.up.railway.app"
GRAPH = "https://graph.facebook.com/v21.0"
DEFAULT_PAGE_ID = "1405415849316418"
ANSWERED = ("booked", "message", "handoff", "emergency")
BRAND_NAME = (lambda b: b.get("name") or "")(json.load(open(BRAND_JSON, encoding="utf-8")) if os.path.exists(BRAND_JSON) else {})
UA = {"User-Agent": "ailab-us-weekly/1.0", "Accept": "application/json"}


# ------------------------------------------------------------------ config
def env_file(path):
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    v = v.strip().strip('"').strip("'")
                    if v and not v.startswith("<"):
                        out[k.strip()] = v
    except OSError:
        pass
    return out


class Cfg:
    def __init__(self):
        self.local = env_file(SECRETS_FILE)
        self.meta = env_file(META_ENV)

    def get(self, *names):
        for n in names:
            v = os.environ.get(n, "").strip()
            if v:
                return v
        for n in names:
            if self.local.get(n):
                return self.local[n]
        for n in names:
            if self.meta.get(n):
                return self.meta[n]
        return ""

    def secrets(self):
        vals = list(self.local.values()) + list(self.meta.values()) + [v for k, v in os.environ.items()
                                                                       if re.search(r"KEY|TOKEN|SECRET", k)]
        return sorted({v for v in vals if v and len(v) >= 8}, key=len, reverse=True)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


# ------------------------------------------------------------------ HTTP
class Scrub:
    def __init__(self, cfg):
        self.vals = cfg.secrets()

    def __call__(self, text):
        text = str(text)
        for v in self.vals:
            text = text.replace(v, "***")
        return re.sub(r"\b(sbp_|sb_secret_|sk-ant-|re_|EAA)[A-Za-z0-9_\-]{6,}", r"\1***", text)


def http(method, url, headers=None, body=None, timeout=60):
    data = None
    h = dict(UA)
    h.update(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code} {url.split('?')[0]} {raw[:200]}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"{url.split('?')[0]}: {getattr(e, 'reason', e)}") from None


def basic(user, pw):
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()}


# ------------------------------------------------------------------ periods
def periods(now):
    cur = (now - dt.timedelta(days=7), now)
    prev = (now - dt.timedelta(days=14), now - dt.timedelta(days=7))
    return cur, prev


def ts(v):
    if not v:
        return None
    try:
        d = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def within(v, span):
    d = ts(v)
    return d is not None and span[0] <= d < span[1]


# ------------------------------------------------------------------ Supabase (PostgREST, service role, GET only)
def supabase_url(cfg):
    url = cfg.get("US_SUPABASE_URL")
    if url:
        return url.rstrip("/")
    try:
        with open(CONFIG_JS, encoding="utf-8") as f:
            m = re.search(r"SUPABASE_URL:\s*['\"](https://[a-z0-9]+\.supabase\.co)['\"]", f.read())
            return m.group(1) if m else ""
    except OSError:
        return ""


def service_key(cfg, url):
    key = cfg.get("US_SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE_KEY")
    if key:
        return key
    tok = cfg.get("SUPABASE_ACCESS_TOKEN")
    m = re.match(r"https://([a-z0-9]+)\.supabase\.co", url or "")
    if not tok or not m:
        return ""
    _, keys = http("GET", f"https://api.supabase.com/v1/projects/{m.group(1)}/api-keys?reveal=true",
                   {"Authorization": "Bearer " + tok})
    for k in keys or []:
        if k.get("name") == "service_role" and k.get("api_key"):
            return k["api_key"]
    for k in keys or []:
        if str(k.get("api_key", "")).startswith("sb_secret_"):
            return k["api_key"]
    return ""


class Db:
    def __init__(self, url, key):
        self.url, self.key = url, key

    def rows(self, table, select, since_col=None, since=None):
        h = {"apikey": self.key}
        if self.key.count(".") == 2:
            h["Authorization"] = "Bearer " + self.key
        out, offset = [], 0
        while True:
            q = {"select": select}
            if since_col and since:
                q[since_col] = "gte." + since.isoformat()
            url = f"{self.url}/rest/v1/{table}?" + urllib.parse.urlencode(q)
            hh = dict(h, Range=f"{offset}-{offset + 999}")
            _, chunk = http("GET", url, hh)
            chunk = chunk or []
            out.extend(chunk)
            if len(chunk) < 1000:
                return out
            offset += 1000


def gather_db(db, cur, prev):
    since = prev[0]
    d = {}
    leads = db.rows("leads", "created_at,niche", "created_at", since)
    qs = db.rows("questionnaires", "created_at,submitted_at,status", "updated_at", since)
    quotes = db.rows("quotes", "created_at,sent_at,accepted_at,status,setup_cents,monthly_cents", "updated_at", since)
    tenants = db.rows("tenants", "id,slug,status,config")
    calls = db.rows("calls", "tenant_id,started_at,outcome,duration_s,cost_usd", "started_at", since)
    sms = db.rows("sms_messages", "tenant_id,direction,created_at", "created_at", since)
    consent = db.rows("sms_consent", "consent_type,decision,created_at", "created_at", since)
    optouts = db.rows("opt_outs", "opted_out_at", "opted_out_at", since)
    bookings = db.rows("bookings", "created_at,status", "created_at", since)

    def pair(fn):
        return fn(cur), fn(prev)

    d["leads"] = pair(lambda s: sum(within(r["created_at"], s) for r in leads))
    d["q_started"] = pair(lambda s: sum(within(r["created_at"], s) for r in qs))
    d["q_submitted"] = pair(lambda s: sum(within(r.get("submitted_at"), s) for r in qs))
    d["quotes_drafted"] = pair(lambda s: sum(within(r["created_at"], s) for r in quotes))
    d["quotes_sent"] = pair(lambda s: sum(within(r.get("sent_at"), s) for r in quotes))
    d["quotes_accepted"] = pair(lambda s: sum(within(r.get("accepted_at"), s) for r in quotes))
    d["sent_value"] = pair(lambda s: sum((r.get("setup_cents") or 0) for r in quotes if within(r.get("sent_at"), s)) / 100)
    d["accepted_value"] = pair(lambda s: sum((r.get("setup_cents") or 0) for r in quotes
                                             if within(r.get("accepted_at"), s)) / 100)
    d["accepted_monthly"] = pair(lambda s: sum((r.get("monthly_cents") or 0) for r in quotes
                                               if within(r.get("accepted_at"), s)) / 100)
    d["calls_total"] = pair(lambda s: sum(within(r["started_at"], s) for r in calls))
    d["calls_answered"] = pair(lambda s: sum(within(r["started_at"], s) and r.get("outcome") in ANSWERED for r in calls))
    d["bookings"] = pair(lambda s: sum(within(r["created_at"], s) and r.get("status") != "cancelled" for r in bookings))
    d["call_minutes"] = pair(lambda s: round(sum((r.get("duration_s") or 0) for r in calls
                                                 if within(r["started_at"], s)) / 60, 1))
    d["call_cost"] = pair(lambda s: round(sum(float(r.get("cost_usd") or 0) for r in calls
                                              if within(r["started_at"], s)), 2))
    d["sms_sent"] = pair(lambda s: sum(within(r["created_at"], s) and r.get("direction") == "outbound" for r in sms))
    d["sms_in"] = pair(lambda s: sum(within(r["created_at"], s) and r.get("direction") == "inbound" for r in sms))
    d["consent"] = pair(lambda s: sum(within(r["created_at"], s) and r.get("consent_type") != "opt_out" for r in consent))
    d["consent_yes"] = pair(lambda s: sum(within(r["created_at"], s) and r.get("decision") == "yes" for r in consent))
    d["optouts"] = pair(lambda s: sum(within(r["opted_out_at"], s) for r in optouts))
    per = []
    for t in tenants:
        name = ((t.get("config") or {}).get("business") or {}).get("name") or t.get("slug")
        c = [r for r in calls if r.get("tenant_id") == t["id"]]
        per.append({"name": name, "status": t.get("status"),
                    "answered": (sum(within(r["started_at"], cur) and r.get("outcome") in ANSWERED for r in c),
                                 sum(within(r["started_at"], prev) and r.get("outcome") in ANSWERED for r in c))})
    d["tenants"] = per
    return d


# ------------------------------------------------------------------ other sources
def gather_health(cfg):
    tok = cfg.get("RUNTIME_ADMIN_TOKEN")
    base = (cfg.get("RUNTIME_URL") or RUNTIME_URL).rstrip("/")
    if not tok:
        raise RuntimeError("אין RUNTIME_ADMIN_TOKEN")
    _, body = http("GET", base + "/health/deep", {"Authorization": "Bearer " + tok}, timeout=45)
    checks = (body or {}).get("checks") or {}
    bad = [k for k, v in checks.items() if v is False]
    return {"ok": bool(checks) and not bad, "bad": bad, "count": len(checks)}


def gather_twilio(cfg, cur, prev):
    sid, tok = cfg.get("TWILIO_ACCOUNT_SID"), cfg.get("TWILIO_AUTH_TOKEN")
    if not sid or not tok:
        raise RuntimeError("אין פרטי Twilio")
    auth = basic(sid, tok)
    base = f"https://api.twilio.com/2010-04-01/Accounts/{sid}"
    _, bal = http("GET", base + "/Balance.json", auth)
    out = {"balance": float(bal.get("balance") or 0), "currency": bal.get("currency") or "USD"}

    def cost(span):
        # Usage records are by whole UTC day: [start date, end date - 1]
        q = urllib.parse.urlencode({"Category": "totalprice", "StartDate": span[0].date().isoformat(),
                                    "EndDate": (span[1] - dt.timedelta(days=1)).date().isoformat()})
        _, r = http("GET", base + "/Usage/Records.json?" + q, auth)
        return round(sum(float(x.get("price") or 0) for x in (r or {}).get("usage_records", [])), 2)

    out["cost"] = (cost(cur), cost(prev))
    return out


def gather_facebook(cfg, cur, prev):
    user_tok = cfg.get("META_ACCESS_TOKEN")
    page = cfg.get("META_PRO_PAGE_ID") or DEFAULT_PAGE_ID
    if not user_tok:
        raise RuntimeError("אין META_ACCESS_TOKEN")
    q = urllib.parse.urlencode({"fields": "id,access_token", "limit": 100, "access_token": user_tok})
    _, acc = http("GET", f"{GRAPH}/me/accounts?{q}")
    ptok = next((a["access_token"] for a in (acc or {}).get("data", []) if str(a.get("id")) == str(page)), None)
    if not ptok:
        raise RuntimeError("הדף לא נמצא בטוקן")
    q = urllib.parse.urlencode({"fields": "fan_count,followers_count", "access_token": ptok})
    _, info = http("GET", f"{GRAPH}/{page}?{q}")
    q = urllib.parse.urlencode({"fields": "created_time", "limit": 100, "since": int(prev[0].timestamp()),
                                "access_token": ptok})
    _, posts = http("GET", f"{GRAPH}/{page}/posts?{q}")
    times = [p.get("created_time") for p in (posts or {}).get("data", [])]
    return {"followers": info.get("followers_count"), "likes": info.get("fan_count"),
            "posts": (sum(within(t, cur) for t in times), sum(within(t, prev) for t in times))}


# ------------------------------------------------------------------ gather everything
def gather(cfg, now):
    scrub = Scrub(cfg)
    cur, prev = periods(now)
    rep = {"now": now, "cur": cur, "prev": prev, "errors": {}}

    def attempt(name, fn):
        try:
            rep[name] = fn()
        except Exception as e:  # noqa: BLE001 - every source is optional; the report still goes out
            rep[name] = None
            rep["errors"][name] = scrub(e)[:200]

    def db_part():
        url = supabase_url(cfg)
        key = service_key(cfg, url)
        if not url or not key:
            raise RuntimeError("אין מפתח Supabase (US_SUPABASE_SERVICE_KEY)")
        return gather_db(Db(url, key), cur, prev)

    attempt("db", db_part)
    attempt("health", lambda: gather_health(cfg))
    attempt("twilio", lambda: gather_twilio(cfg, cur, prev))
    attempt("fb", lambda: gather_facebook(cfg, cur, prev))
    rep["upwork"] = load_json(os.path.join(STATUS_DIR, "upwork.json"), {})
    rep["next"] = load_json(os.path.join(STATUS_DIR, "next.json"), {})
    return rep


# ------------------------------------------------------------------ rendering
NA = "לא זמין"


def fmt(v, money=False):
    if v is None:
        return NA
    if money:
        return f"${v:,.2f}" if (isinstance(v, float) and v != int(v)) else f"${v:,.0f}"
    if isinstance(v, float) and v != int(v):
        return f"{v:,.1f}"
    return f"{int(v):,}"


def trend(cur, prev, money=False):
    """(symbol, color, text) for the change vs. last week."""
    if cur is None or prev is None:
        return "", "#6b7280", ""
    diff = cur - prev
    if abs(diff) < 1e-9:
        return "=", "#6b7280", "ללא שינוי"
    sym, color = ("▲", "#15803d") if diff > 0 else ("▼", "#b91c1c")
    return sym, color, f"{sym} {fmt(abs(diff), money)}"


def metric_rows(rep):
    """Sections of (label, hint, cur, prev, money, lower_is_better)."""
    d = rep.get("db")
    g = (lambda k: d[k]) if d else (lambda k: (None, None))
    fb = rep.get("fb") or {}
    tw = rep.get("twilio") or {}
    fb_posts = fb.get("posts", (None, None))
    sections = [
        ("מכירות ואתר", [
            ("פניות מהאתר", "מישהו השאיר מייל באתר", *g("leads"), False, False),
            ("שאלונים שהתחילו", "לקוח פתח את שאלון ההיכרות", *g("q_started"), False, False),
            ("שאלונים שהוגשו", "לקוח סיים ושלח את השאלון", *g("q_submitted"), False, False),
            ("הצעות מחיר שנוצרו", "טיוטות שהמערכת הכינה", *g("quotes_drafted"), False, False),
            ("הצעות מחיר שנשלחו", "יצאו ללקוח", *g("quotes_sent"), False, False),
            ("שווי ההצעות שנשלחו", "סכום ההקמה", *g("sent_value"), True, False),
            ("הצעות מחיר שאושרו", "הלקוח חתם", *g("quotes_accepted"), False, False),
            ("שווי ההצעות שאושרו", "סכום ההקמה (בלי החודשי)", *g("accepted_value"), True, False),
            ("הכנסה חודשית שנוספה", "מההצעות שאושרו", *g("accepted_monthly"), True, False),
        ]),
        ("קו הטלפון והודעות", [
            ("שיחות שנענו", "כל הקווים יחד", *g("calls_answered"), False, False),
            ("כל השיחות", "כולל ניתוקים וספאם", *g("calls_total"), False, False),
            ("תורים שנקבעו", "בשיחות", *g("bookings"), False, False),
            ("דקות שיחה", "", *g("call_minutes"), False, False),
            ("הודעות SMS שנשלחו", "", *g("sms_sent"), False, False),
            ("הודעות SMS שהתקבלו", "", *g("sms_in"), False, False),
            ("רישומי הסכמה ל-SMS", "תיעוד חוקי של \"כן/לא\" מהמתקשר", *g("consent"), False, False),
            ("הסרות (STOP)", "ביקשו לא לקבל הודעות", *g("optouts"), False, True),
        ]),
        ("פייסבוק", [
            ("פוסטים שפורסמו", "בדף העסקי בארה\"ב", fb_posts[0], fb_posts[1], False, False),
        ]),
        ("עלויות", [
            ("עלות Twilio", "טלפון ו-SMS, לפי חשבון Twilio", *(tw.get("cost") or (None, None)), True, True),
            ("עלות שיחות מתועדת", "Twilio + Claude לפי רישום השיחות", *g("call_cost"), True, True),
        ]),
    ]
    return sections


def summary_line(rep):
    d = rep.get("db")
    parts = []
    if d:
        parts.append(f"{d['leads'][0]} פניות מהאתר")
        parts.append(f"{d['q_submitted'][0]} שאלונים שהוגשו")
        parts.append(f"{d['quotes_sent'][0]} הצעות מחיר שנשלחו")
        parts.append(f"{d['calls_answered'][0]} שיחות שנענו")
    h = rep.get("health")
    if h is not None:
        parts.append("המערכת תקינה" if h["ok"] else "יש תקלה במערכת, ראה למטה")
    return "השבוע: " + ", ".join(parts) + "." if parts else "השבוע לא הצלחתי לקרוא את הנתונים."


def he_date(d):
    return d.strftime("%d.%m")


def render_html(rep):
    tz = ZoneInfo("Asia/Jerusalem")
    cur, prev = rep["cur"], rep["prev"]
    e = html.escape
    span = f"{he_date(cur[0].astimezone(tz))}–{he_date((cur[1] - dt.timedelta(seconds=1)).astimezone(tz))}"
    td = "padding:10px 6px;border-bottom:1px solid #e5e7eb;font-size:17px;vertical-align:top;"
    num = td + "text-align:center;white-space:nowrap;font-weight:700;"
    out = []
    a = out.append
    a('<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">'
      '<meta name="viewport" content="width=device-width,initial-scale=1">'
      f'<title>הדוח השבועי {e(span)}</title></head>'
      '<body style="margin:0;padding:0;background:#f3f4f6;" dir="rtl">'
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">'
      '<tr><td align="center" style="padding:20px 10px;">'
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" '
      'style="max-width:640px;background:#ffffff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;'
      'color:#111827;text-align:right;">')
    a('<tr><td style="padding:24px 20px 8px;">'
      f'<div style="font-size:15px;color:#6b7280;">{e(BRAND_NAME)} ארה"ב · דוח שבועי</div>'
      f'<h1 style="margin:6px 0 4px;font-size:26px;line-height:1.3;">השבוע שלך: <span dir="ltr">{e(span)}</span></h1>'
      '<div style="font-size:15px;color:#6b7280;">כל מספר מושווה לשבוע שלפניו. ▲ עלייה, ▼ ירידה.</div>'
      '</td></tr>')
    a('<tr><td style="padding:12px 20px;"><div style="background:#eef2ff;border-radius:10px;padding:14px 16px;'
      f'font-size:18px;line-height:1.6;">{e(summary_line(rep))}</div></td></tr>')

    def section_title(t):
        a(f'<tr><td style="padding:18px 20px 4px;"><h2 style="margin:0;font-size:20px;">{e(t)}</h2></td></tr>')

    def table_open():
        a('<tr><td style="padding:0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
          'dir="rtl" style="border-collapse:collapse;">'
          f'<tr><th style="{td}text-align:right;color:#6b7280;font-size:14px;font-weight:400;">מה</th>'
          f'<th style="{td}text-align:center;color:#6b7280;font-size:14px;font-weight:400;">השבוע</th>'
          f'<th style="{td}text-align:center;color:#6b7280;font-size:14px;font-weight:400;">שבוע שעבר</th>'
          f'<th style="{td}text-align:center;color:#6b7280;font-size:14px;font-weight:400;">שינוי</th></tr>')

    def row(label, hint, c, p, money, lower_better):
        sym, color, txt = trend(c, p, money)
        if lower_better and sym in ("▲", "▼"):
            color = "#b91c1c" if sym == "▲" else "#15803d"
        hint_html = f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">{e(hint)}</div>' if hint else ""
        a(f'<tr><td style="{td}">{e(label)}{hint_html}</td>'
          f'<td style="{num}"><span dir="ltr">{e(fmt(c, money))}</span></td>'
          f'<td style="{num}font-weight:400;color:#4b5563;"><span dir="ltr">{e(fmt(p, money))}</span></td>'
          f'<td style="{td}text-align:center;color:{color};font-size:15px;"><span dir="ltr">{e(txt)}</span></td></tr>')

    for title, rows in metric_rows(rep):
        section_title(title)
        table_open()
        for r in rows:
            row(*r)
        if title == "קו הטלפון והודעות" and rep.get("db"):
            for t in rep["db"]["tenants"]:
                st = {"sandbox": "דמו", "live": "פעיל", "paused": "מושהה"}.get(t["status"], t["status"] or "")
                row(f"שיחות שנענו: {t['name']}", f"קו {st}", *t["answered"], False, False)
        if title == "פייסבוק":
            fb = rep.get("fb") or {}
            a(f'<tr><td style="{td}">עוקבים בדף<div style="font-size:13px;color:#6b7280;">סה"כ כרגע</div></td>'
              f'<td style="{num}">{e(fmt(fb.get("followers")))}</td><td style="{td}"></td><td style="{td}"></td></tr>')
            a(f'<tr><td style="{td}">לייקים לדף<div style="font-size:13px;color:#6b7280;">סה"כ כרגע</div></td>'
              f'<td style="{num}">{e(fmt(fb.get("likes")))}</td><td style="{td}"></td><td style="{td}"></td></tr>')
        if title == "עלויות":
            tw = rep.get("twilio")
            bal = f"${tw['balance']:,.2f}" if tw else NA
            a(f'<tr><td style="{td}">יתרה בחשבון Twilio<div style="font-size:13px;color:#6b7280;">'
              f'כמה כסף נשאר לשיחות ו-SMS</div></td><td style="{num}"><span dir="ltr">{e(bal)}</span></td>'
              f'<td style="{td}"></td><td style="{td}"></td></tr>')
        a('</table></td></tr>')

    # Upwork
    up = rep.get("upwork") or {}
    section_title("Upwork")
    a(f'<tr><td style="padding:6px 20px;font-size:17px;line-height:1.7;">{e(upwork_line(up))}</td></tr>')

    # health
    section_title("מצב המערכת")
    h = rep.get("health")
    if h is None:
        msg, color = "לא הצלחתי לבדוק את השרת השבוע.", "#b45309"
    elif h["ok"]:
        msg, color = f"השרת שעונה לטלפון תקין (כל {h['count']} הבדיקות עברו).", "#15803d"
    else:
        msg, color = "יש תקלה בשרת. בדיקות שנכשלו: " + ", ".join(h["bad"]), "#b91c1c"
    a(f'<tr><td style="padding:6px 20px;font-size:17px;color:{color};font-weight:700;">{e(msg)}</td></tr>')

    # next actions
    nxt = (rep.get("next") or {}).get("items") or []
    if nxt:
        section_title("הצעדים הבאים")
        a('<tr><td style="padding:4px 20px;"><ol style="margin:0;padding-right:22px;padding-left:0;font-size:17px;'
          'line-height:1.7;">')
        for it in nxt:
            who = it.get("owner")
            who_html = f' <span style="color:#6b7280;font-size:14px;">({e(who)})</span>' if who else ""
            text = re.sub(r"(\+?\d[\d\- ()]{7,}\d)", r'<span dir="ltr">\1</span>', e(it.get("text", "")))
            a(f'<li style="margin-bottom:6px;">{text}{who_html}</li>')
        a('</ol></td></tr>')

    if rep["errors"]:
        a('<tr><td style="padding:14px 20px 0;font-size:14px;color:#6b7280;">חלק מהנתונים לא נקראו השבוע: '
          + e(", ".join(SOURCE_HE.get(k, k) for k in rep["errors"])) + '.</td></tr>')
    a('<tr><td style="padding:18px 20px 24px;font-size:13px;color:#9ca3af;line-height:1.6;">'
      'נשלח אוטומטית בכל יום ראשון ב-08:00. הסיכום היומי ממשיך להגיע כרגיל.</td></tr>')
    a('</table></td></tr></table></body></html>')
    return "".join(out)


SOURCE_HE = {"db": "מסד הנתונים", "health": "בדיקת השרת", "twilio": "Twilio", "fb": "פייסבוק"}


def upwork_line(up):
    if not up:
        return "אין עדכון."
    yn = lambda v: "כן" if v is True else ("לא" if v is False else str(v))  # noqa: E731
    bits = []
    if up.get("status_text"):
        bits.append(up["status_text"])
    bits.append(f"אימות זהות: {yn(up.get('verified'))}")
    bits.append(f"מפתח API: {yn(up.get('api_key'))}")
    bits.append(f"הצעות שנשלחו: {up.get('proposals_sent', 0)}")
    bits.append(f"תשובות: {up.get('replies', 0)}")
    if up.get("updated"):
        bits.append(f"עודכן {up['updated']}")
    return " · ".join(bits)


def render_text(rep):
    tz = ZoneInfo("Asia/Jerusalem")
    cur = rep["cur"]
    lines = [f"{BRAND_NAME} ארה\"ב: הדוח השבועי {he_date(cur[0].astimezone(tz))}–"
             f"{he_date((cur[1] - dt.timedelta(seconds=1)).astimezone(tz))}", "", summary_line(rep), ""]
    for title, rows in metric_rows(rep):
        lines.append(f"== {title} ==")
        for label, _hint, c, p, money, _lb in rows:
            lines.append(f"- {label}: {fmt(c, money)} (שבוע שעבר {fmt(p, money)}) {trend(c, p, money)[2]}".rstrip())
        if title == "קו הטלפון והודעות" and rep.get("db"):
            for t in rep["db"]["tenants"]:
                lines.append(f"- שיחות שנענו, {t['name']}: {t['answered'][0]} (שבוע שעבר {t['answered'][1]})")
        if title == "פייסבוק":
            fb = rep.get("fb") or {}
            lines.append(f"- עוקבים: {fmt(fb.get('followers'))} · לייקים: {fmt(fb.get('likes'))}")
        if title == "עלויות":
            tw = rep.get("twilio")
            lines.append(f"- יתרה ב-Twilio: {'$%.2f' % tw['balance'] if tw else NA}")
        lines.append("")
    lines += ["== Upwork ==", upwork_line(rep.get("upwork") or {}), ""]
    h = rep.get("health")
    lines.append("== מצב המערכת ==")
    lines.append(NA if h is None else ("תקין" if h["ok"] else "תקלה: " + ", ".join(h["bad"])))
    nxt = (rep.get("next") or {}).get("items") or []
    if nxt:
        lines += ["", "== הצעדים הבאים =="]
        lines += [f"{i}. {it.get('text', '')}" + (f" ({it['owner']})" if it.get("owner") else "")
                  for i, it in enumerate(nxt, 1)]
    if rep["errors"]:
        lines += ["", "לא נקראו השבוע: " + ", ".join(SOURCE_HE.get(k, k) for k in rep["errors"])]
    return "\n".join(lines) + "\n"


# ------------------------------------------------------------------ send
def send(cfg, subject, html_body, text_body):
    key = cfg.get("RESEND_API_KEY")
    if not key:
        raise RuntimeError("RESEND_API_KEY חסר")
    brand = load_json(BRAND_JSON, {})
    sender = (brand.get("senders") or {}).get("transactional")
    to = (brand.get("owner") or {}).get("admin_email")
    if not sender or not to:
        raise RuntimeError("config/brand.json: senders.transactional / owner.admin_email חסרים")
    body = {"from": sender, "to": [to], "subject": subject, "html": html_body, "text": text_body}
    reply_to = (brand.get("senders") or {}).get("reply_to")
    if reply_to:
        body["reply_to"] = reply_to
    _, res = http("POST", "https://api.resend.com/emails", {"Authorization": "Bearer " + key}, body)
    return (res or {}).get("id")


def subject_for(rep):
    tz = ZoneInfo("Asia/Jerusalem")
    return f"הדוח השבועי של {BRAND_NAME} ארה\"ב: {he_date(rep['now'].astimezone(tz))}"


# ------------------------------------------------------------------ self-test
def self_test():
    now = dt.datetime(2026, 10, 18, 5, 0, tzinfo=dt.timezone.utc)
    cur, prev = periods(now)
    rep = {"now": now, "cur": cur, "prev": prev, "errors": {"fb": "x"}, "fb": None,
           "db": {k: (3, 1) for k in ("leads", "q_started", "q_submitted", "quotes_drafted", "quotes_sent",
                                      "quotes_accepted", "calls_total", "calls_answered", "bookings", "sms_sent",
                                      "sms_in", "consent", "consent_yes", "optouts")}
           | {"sent_value": (1234.0, 0.0), "accepted_value": (0.0, 0.0), "accepted_monthly": (0.0, 0.0),
              "call_minutes": (2.5, 0.0), "call_cost": (0.4, 0.4),
              "tenants": [{"name": "Demo <b>", "status": "sandbox", "answered": (2, 0)}]},
           "health": {"ok": False, "bad": ["claude"], "count": 9},
           "twilio": {"balance": 12.5, "cost": (1.2, 0.0)},
           "upwork": {"verified": False, "proposals_sent": 0}, "next": {"items": [{"text": "a & b", "owner": "מאיר"}]}}
    h = render_html(rep)
    t = render_text(rep)
    assert 'dir="rtl"' in h and "Demo &lt;b&gt;" in h and "a &amp; b" in h, "escaping/RTL"
    assert "▲" in h and "$1,234" in h and "claude" in h and "פייסבוק" in t and NA in t
    assert trend(2, 2)[0] == "=" and trend(1, 3)[0] == "▼" and trend(None, 1)[0] == ""
    assert within("2026-10-17T00:00:00Z", cur) and not within("2026-10-10T00:00:00Z", cur)
    s = Scrub.__new__(Scrub)
    s.vals = ["supersecretvalue123"]
    assert "supersecret" not in s("x supersecretvalue123 re_abcdefghij")
    print("weekly_report self-test: OK")


# ------------------------------------------------------------------ main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--send", action="store_true")
    g.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    cfg = Cfg()
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    rep = gather(cfg, now)
    html_body, text_body = render_html(rep), render_text(rep)
    if rep["errors"]:
        for k, v in rep["errors"].items():
            print(f"[warn] {k}: {v}", file=sys.stderr)
    if args.dry_run:
        os.makedirs(OUT_DIR, exist_ok=True)
        path = os.path.join(OUT_DIR, now.astimezone(ZoneInfo("Asia/Jerusalem")).date().isoformat() + ".html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(html_body)
        print(text_body)
        print(f"HTML: {os.path.relpath(path, ROOT)}")
        return 0
    try:
        mid = send(cfg, subject_for(rep), html_body, text_body)
    except Exception as e:  # noqa: BLE001
        print("❌ השליחה נכשלה: " + Scrub(cfg)(e)[:300], file=sys.stderr)
        return 1
    print(f"✅ הדוח השבועי נשלח (Resend id {mid}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
