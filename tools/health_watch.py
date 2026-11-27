"""Outage watch for the live system. Stdlib only. Run every few minutes by .github/workflows/health-watch.yml,
on GitHub's machines, so it keeps working when the call server (Railway) or the database (Supabase) is down.

What it checks (addresses come from config/brand.json):
  call_server   GET <runtime_url>/health          -> 200, ok and store_ok are true
  site          GET <site_url>/start/             -> 200
  voice_backup  GET <site_url>/voice-fallback.xml -> 200 and a <Response> document (the static voice fallback)
  database      GET <supabase_url>/auth/v1/health -> any answer below 500 (optional: only when SUPABASE_URL is set)
Each check is tried 3 times, 15 seconds apart, so a deploy restart is not reported as an outage.

E-mails (Resend, sender = brand.json senders.alerts, to ALERT_TO or brand.json support_email), in English like every
admin e-mail:
  DOWN        the first failed run
  STILL DOWN  once an hour while it stays down
  RECOVERED   the first good run after an outage
The state between runs is one small JSON file (--state), kept by the workflow in the Actions cache.

usage:
  python3 tools/health_watch.py --state /path/state.json     needs RESEND_API_KEY to send e-mail
  python3 tools/health_watch.py --dry-run                    checks only, prints, sends nothing
  python3 tools/health_watch.py --self-test
Exit 1 only when something is down AND the e-mail could not be sent (GitHub then mails the failed run instead).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMIND_EVERY = timedelta(minutes=60)
UA = "ailabpro-health-watch/1.0"


def brand():
    with open(os.path.join(ROOT, "config", "brand.json"), encoding="utf-8") as f:
        return json.load(f)


def find(obj, key):
    """First value stored under `key` anywhere in the brand file (runtime_url sits in a nested block)."""
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = find(v, key)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find(v, key)
            if r is not None:
                return r
    return None


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(20000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001 - DNS, TLS, timeout: all mean "not reachable"
        return 0, type(e).__name__


def check_call_server(get, base):
    code, body = get(base.rstrip("/") + "/health")
    if code != 200:
        return False, f"HTTP {code or 'no answer'} {body if not code else ''}".strip()
    try:
        j = json.loads(body)
    except ValueError:
        return False, "answer is not JSON"
    if not j.get("ok") or not j.get("store_ok"):
        return False, f"ok={j.get('ok')} store_ok={j.get('store_ok')}"
    return True, ""


def check_page(get, url):
    code, body = get(url)
    return (True, "") if code == 200 else (False, f"HTTP {code or 'no answer'} {body if not code else ''}".strip())


def check_voice_backup(get, url):
    code, body = get(url)
    if code != 200:
        return False, f"HTTP {code or 'no answer'}"
    return (True, "") if "<Response>" in body and "<Say" in body else (False, "not a TwiML document")


def check_database(get, base):
    code, body = get(base.rstrip("/") + "/auth/v1/health")
    return (True, "") if 0 < code < 500 else (False, f"HTTP {code or 'no answer'} {body if not code else ''}".strip())


def run_checks(b, get=fetch, tries=3, pause=15, sleep=time.sleep, supabase_url=""):
    site, rt = (b.get("site_url") or "").rstrip("/"), find(b, "runtime_url") or ""
    checks = [("call_server", lambda: check_call_server(get, rt)),
              ("site", lambda: check_page(get, site + "/start/")),
              ("voice_backup", lambda: check_voice_backup(get, site + "/voice-fallback.xml"))]
    if supabase_url:
        checks.append(("database", lambda: check_database(get, supabase_url)))
    out = {}
    for name, fn in checks:
        ok, detail = False, ""
        for i in range(tries):
            ok, detail = fn()
            if ok:
                break
            if i < tries - 1:
                sleep(pause)
        out[name] = {"ok": ok, "detail": detail}
    return out


LABEL = {"call_server": "Call server (answers the phone)", "site": "Website and client portal",
         "voice_backup": "Backup voice message file", "database": "Database"}


def decide(state, results, now):
    """-> (kind | None, new_state). kind: 'down' | 'still_down' | 'recovered'."""
    failing = sorted(k for k, v in results.items() if not v["ok"])
    was_down = bool(state.get("down"))
    if failing:
        if not was_down:
            return "down", {"down": True, "since": now.isoformat(), "last_alert": now.isoformat(), "failing": failing}
        last = datetime.fromisoformat(state.get("last_alert") or state.get("since") or now.isoformat())
        new = {**state, "failing": failing}
        if now - last >= REMIND_EVERY or failing != sorted(state.get("failing") or []):
            return "still_down", {**new, "last_alert": now.isoformat()}
        return None, new
    if was_down:
        return "recovered", {"down": False, "recovered_at": now.isoformat()}
    return None, {"down": False}


def compose(kind, state_before, results, now):
    failing = [k for k, v in results.items() if not v["ok"]]
    names = ", ".join(LABEL.get(k, k) for k in failing)
    since = state_before.get("since") if kind != "down" else now.isoformat()
    lines = []
    if kind == "recovered":
        subject = "RECOVERED: AI Lab Pro is back up"
        lines.append(f"Everything answers again. The outage started at {since} (UTC).")
    else:
        subject = ("DOWN: " if kind == "down" else "STILL DOWN: ") + names
        lines.append(f"Not answering since {since} (UTC), checked 3 times:")
        lines += [f"- {LABEL.get(k, k)}: {results[k]['detail'] or 'failed'}" for k in failing]
        if "call_server" in failing:
            lines += ["", "While the call server is down, callers hear the backup message and no call is logged.",
                      "First step: open the Railway project, service 'runtime', and look at the latest deployment and its logs."]
        lines += ["", "You get a reminder every hour until it is back, then one RECOVERED e-mail."]
    lines += ["", "Checks now:"] + [f"- {LABEL.get(k, k)}: {'ok' if v['ok'] else 'FAILED'}" for k, v in results.items()]
    return subject, "\n".join(lines)


def send(b, subject, text, key, to, post=None):
    payload = {"from": (b.get("senders") or {}).get("alerts") or b.get("smtp_from"), "to": [to],
               "subject": subject, "text": text}
    if post:
        return post(payload)
    req = urllib.request.Request("https://api.resend.com/emails", data=json.dumps(payload).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return 200 <= r.status < 300


def self_test():
    b = {"site_url": "https://s.example", "x": {"runtime_url": "https://r.example"}, "senders": {"alerts": "A <a@s.example>"},
         "support_email": "me@s.example"}
    good = {"https://r.example/health": (200, '{"ok": true, "store_ok": true}'), "https://s.example/start/": (200, "<html>"),
            "https://s.example/voice-fallback.xml": (200, "<Response><Say>x</Say></Response>")}
    ok = run_checks(b, get=lambda u: good.get(u, (0, "x")), sleep=lambda s: None)
    assert all(v["ok"] for v in ok.values()) and list(ok) == ["call_server", "site", "voice_backup"], ok
    calls = []
    bad = dict(good); bad["https://r.example/health"] = (502, "")
    r = run_checks(b, get=lambda u: (calls.append(u), bad.get(u, (0, "x")))[1], sleep=lambda s: None)
    assert not r["call_server"]["ok"] and r["site"]["ok"] and calls.count("https://r.example/health") == 3
    half = dict(good); half["https://r.example/health"] = (200, '{"ok": true, "store_ok": false}')
    assert run_checks(b, get=lambda u: half[u], sleep=lambda s: None)["call_server"]["detail"] == "ok=True store_ok=False"
    flaky = iter([(0, "Timeout"), (200, '{"ok": true, "store_ok": true}')])   # a restart during a deploy is not an outage
    r_flaky = run_checks(b, get=lambda u: next(flaky) if "health" in u else good[u], sleep=lambda s: None)
    assert r_flaky["call_server"]["ok"]
    db = run_checks(b, get=lambda u: (401, "") if "auth/v1" in u else good[u], sleep=lambda s: None, supabase_url="https://d.example")
    assert db["database"]["ok"]
    t0 = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)
    k, s = decide({}, r, t0)
    assert k == "down" and s["down"] and s["failing"] == ["call_server"]
    k2, s2 = decide(s, r, t0 + timedelta(minutes=5))
    assert k2 is None and s2["last_alert"] == s["last_alert"]
    k3, s3 = decide(s2, r, t0 + timedelta(minutes=61))
    assert k3 == "still_down" and s3["last_alert"] != s["last_alert"]
    r2 = {**r, "site": {"ok": False, "detail": "HTTP 500"}}
    assert decide(s2, r2, t0 + timedelta(minutes=10))[0] == "still_down"       # something else broke: tell at once
    k4, s4 = decide(s3, ok, t0 + timedelta(minutes=70))
    assert k4 == "recovered" and not s4["down"] and decide(s4, ok, t0)[0] is None and decide({}, ok, t0)[0] is None
    subj, text = compose("down", {}, r, t0)
    assert subj == "DOWN: Call server (answers the phone)" and "Railway" in text and "HTTP 502" in text
    assert compose("recovered", s3, ok, t0)[0].startswith("RECOVERED")
    sent = []
    assert send(b, subj, text, "k", "me@s.example", post=lambda p: (sent.append(p), True)[1]) and sent[0]["from"] == "A <a@s.example>"
    print("health_watch self-test: ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    b = brand()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    results = run_checks(b, supabase_url=os.environ.get("SUPABASE_URL", "").strip())
    for k, v in results.items():
        print(f"{k}: {'ok' if v['ok'] else 'FAILED ' + v['detail']}")
    if a.dry_run:
        return 0
    state = {}
    if a.state and os.path.exists(a.state):
        try:
            with open(a.state, encoding="utf-8") as f:
                state = json.load(f)
        except (ValueError, OSError):
            state = {}
    kind, new = decide(state, results, now)
    rc = 0
    if kind:
        subject, text = compose(kind, state, results, now)
        key, to = os.environ.get("RESEND_API_KEY", ""), os.environ.get("ALERT_TO", "").strip() or b.get("support_email")
        try:
            sent = bool(key) and send(b, subject, text, key, to)
        except Exception as e:  # noqa: BLE001
            print(f"e-mail failed: {type(e).__name__}")
            sent = False
        print(f"{kind}: e-mail {'sent' if sent else 'NOT sent'}: {subject}")
        if not sent:
            new = state if kind != "recovered" else new   # try the same alert again on the next run
            rc = 1 if kind != "recovered" else 0
    if a.state:
        os.makedirs(os.path.dirname(os.path.abspath(a.state)), exist_ok=True)
        with open(a.state, "w", encoding="utf-8") as f:
            json.dump(new, f)
    return rc


if __name__ == "__main__":
    sys.exit(main() or 0)
