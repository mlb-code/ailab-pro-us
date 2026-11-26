"""Per-customer go-live check (`/admin/sim-run`, and the `golive_sim` provisioning job): simulator conversations run
against the customer's REAL tenant config before the line is switched live.

Everything runs in an isolated, throw-away environment: a temporary JSON store holding a copy of the tenant, the mock
model (deterministic, no API credit), the fake calendar and no Twilio client. Nothing is sent, booked or written to the
production store. Two checks read the production store (read-only): the tenant has a number, and the calendar
credential exists when the client chose to book by Google Calendar or Calendly.

What is checked (each check passes, fails or is skipped when it does not apply):
  config_valid, number_assigned, greeting (business name + the full call notice, Spanish notice with ADD-ES),
  alerts_reach_owner (an e-mail address), calendar_connected, booking (a caller books a slot) or no_booking
  (messages-only clients: nothing is booked), out_of_area, emergency_keyword, life_safety (911 first), ai_honesty,
  faq_answer, pricing (listed prices only / never a price), stop_keyword.
The mock model checks the deterministic layers (guard, tools, calendar rules, config); it does not judge wording.
With GOLIVE_LIVE_AI_CHECK=1 (default off; costs API credit) one more check, `live_ai`, runs ONE short scripted conversation on
the REAL model through the same engine and prompt a live call uses (see live_ai_check below).
"""
from __future__ import annotations

import copy
import logging
import re
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from . import settings as settings_mod
from .tenants import DAYS, TenantConfigError, load_record

log = logging.getLogger("rt.golive")

CALLER = "+12025550147"
SIM_NUMBER = "+15005550006"
# Admin-facing check labels. The result key stays `label_he` (stored results + the admin read it); the text is English.
CHECK_LABELS = {
    "config_valid": "Config is valid", "number_assigned": "Phone number assigned", "greeting": "Greeting with business name and recording notice",
    "alerts_reach_owner": "Alerts reach the business owner", "calendar_connected": "Calendar connected", "booking": "Caller books a visit",
    "no_booking": "No bookings (messages only)", "out_of_area": "Outside the service area", "emergency_keyword": "Emergency keyword",
    "life_safety": "Life safety: 911 first", "ai_honesty": "Honestly says it's an AI", "faq_answer": "Answer from the FAQ",
    "pricing": "Prices only from the list", "stop_keyword": "STOP works", "live_ai": "One test call with the real model"}


def _open_time(cfg: Any, now: datetime) -> datetime:
    """A moment inside opening hours (next open day, one hour after opening), so booking is offered."""
    tz = ZoneInfo(cfg.business.timezone)
    local = now.astimezone(tz)
    for add in range(1, 9):
        day = (local + timedelta(days=add)).date()
        span = getattr(cfg.hours, DAYS[day.weekday()])
        if span:
            h, m = map(int, span[0].split(":"))
            start = datetime(day.year, day.month, day.day, h, m, tzinfo=tz) + timedelta(hours=1)
            close_h, close_m = map(int, span[1].split(":"))
            close = datetime(day.year, day.month, day.day, close_h, close_m, tzinfo=tz)
            return min(start, close - timedelta(minutes=30))
    return local + timedelta(days=1)


class _Env:
    """Isolated engine: temp JSON store + mock model + fake calendar."""

    def __init__(self, row: dict[str, Any]):
        from sim.fake_calendar import FakeCalendar  # simulator package (deployed with the runtime)

        from .conversation import Engine
        from .llm import LLMClient
        from .store import JsonStore
        self.dir = tempfile.mkdtemp(prefix="golive-")
        self.settings = settings_mod.load({"RUNTIME_MODE": "sim", "STORE_BACKEND": "json", "DATA_DIR": self.dir,
                                           "BRAIN_MODE": "mock"})
        self.store = JsonStore(self.dir)
        sim_row = copy.deepcopy(row)
        sim_row["twilio_number"] = SIM_NUMBER
        sim_row["status"] = "sandbox"
        cfg = sim_row["config"]
        cfg.pop("plan", None)  # plan enforcement is tested elsewhere; here: the conversation rules, full service
        cfg["paused"] = False
        self.tenant = self.store.upsert_tenant(sim_row)
        self.engine = Engine(self.store, LLMClient(self.settings, namespace="golive", mode="mock"), FakeCalendar(),
                             self.settings)
        self.n = 0

    def talk(self, lines: list[str], channel: str = "voice", contact: str | None = None, now: datetime | None = None):
        self.n += 1
        contact = contact or f"+1202555{self.n:04d}"  # a new caller per conversation (per-number reply limits)
        convo_id = f"golive-{self.n}"
        now = now or datetime.now(timezone.utc)
        replies, actions = [], []
        for i, line in enumerate(lines):
            res = self.engine.handle(self.tenant, channel, contact, line, convo_id, now + timedelta(minutes=i))
            replies.append(res.reply)
            actions += res.actions
            if res.end:
                break
        c = self.engine.convos.get((self.tenant.id, channel, convo_id))
        return replies, actions, c


def _check(out: list, name: str, fn: Any) -> None:
    try:
        ok, detail = fn()
    except Exception as exc:  # noqa: BLE001 - one broken check must not hide the others
        log.exception("golive check %s crashed", name)
        ok, detail = False, f"error: {type(exc).__name__}"
    out.append({"name": name, "ok": ok if ok is not None else True, "skipped": ok is None, "detail": detail,
                "label_he": CHECK_LABELS.get(name, name)})


def run_checks(row: dict[str, Any], *, store: Any = None, now: datetime | None = None,
               ai: dict[str, Any] | None = None) -> dict[str, Any]:
    """Run every check against a stored tenant row. Returns {passed, checks[], ran_at, slug} (+ ai_check when `ai` is
    given: {model, settings, env} for the live AI check, see live_ai_check)."""
    now = now or datetime.now(timezone.utc)
    checks: list[dict[str, Any]] = []
    slug = row.get("slug")
    try:
        rec = load_record(row)
    except TenantConfigError as exc:
        fields = sorted({p.split(":", 1)[0].strip() for p in exc.problems})[:10]
        checks.append({"name": "config_valid", "ok": False, "skipped": False, "detail": "fields: " + ", ".join(fields),
                       "label_he": CHECK_LABELS["config_valid"]})
        return {"passed": False, "checks": checks, "ran_at": now.isoformat(), "slug": slug, "failed": ["config_valid"]}
    cfg = rec.config
    checks.append({"name": "config_valid", "ok": True, "skipped": False, "detail": "", "label_he": CHECK_LABELS["config_valid"]})
    _check(checks, "number_assigned", lambda: (bool(rec.twilio_number), rec.twilio_number and "ok" or "no number yet"))

    from .voice import greeting, has_disclosure

    def _greeting():
        g = greeting(rec)
        ok = cfg.business.name.lower() in g.lower() and has_disclosure(g)
        return ok, "" if ok else "greeting is missing the business name or the call notice"
    _check(checks, "greeting", _greeting)
    _check(checks, "alerts_reach_owner", lambda: (bool(cfg.notify.email), "" if cfg.notify.email else "no alert e-mail"))

    def _calendar():
        if not cfg.booking.enabled:
            return None, "messages only: no calendar needed"
        if cfg.booking.provider not in ("google", "calendly"):
            return None, f"provider {cfg.booking.provider}"
        if store is None:
            return None, "no store to check"
        return bool(store.get_credential(rec.id, cfg.booking.provider)), cfg.booking.provider
    _check(checks, "calendar_connected", _calendar)

    env = _Env(row)
    t_open = _open_time(cfg, now)
    job = cfg.booking.job_types[0]
    zips = list(cfg.business.service_area_zips)
    zip_ok = zips[0] if zips else "10001"

    def _booking():
        if cfg.business.niche == "real_estate":
            lines = ["Hi, we're starting to look for a house to buy", "In the next 3 months", "Between 450k and 700k",
                     "We're pre-approved", f"No, not working with anyone yet, zip {zip_ok}", "The first one works, this is Chris Kim",
                     "That's all, thanks"]
        else:
            lines = [f"Hi, I need to book an appointment for {job}, my ZIP is {zip_ok}", "The first one works",
                     "My name is Test Caller", f"123 Main St, Springfield {zip_ok}", "That's all, thanks"]
        replies, _a, c = env.talk(lines, channel="sms" if cfg.business.niche == "real_estate" else "voice", now=t_open)
        booked = bool(c and c.booking)
        if cfg.booking.enabled:
            return booked, "booked" if booked else "no booking made: " + (replies[-1] if replies else "")[:120]
        return not booked, "nothing booked (messages only)" if not booked else "a booking was made although booking is off"
    _check(checks, "booking" if cfg.booking.enabled else "no_booking", _booking)

    def _area():
        if not zips:
            return None, "no ZIP restriction"
        outside = next(z for z in ("99950", "00601", "96799", "05901") if z not in zips)
        _r, _a, c = env.talk([f"I need to book an appointment for {job}, my ZIP is {outside}", "The first one works",
                              "My name is Test Caller", f"123 Main St, Springfield {outside}"], now=t_open)
        return not (c and c.booking), f"ZIP {outside} not booked" if not (c and c.booking) else f"ZIP {outside} was booked"
    _check(checks, "out_of_area", _area)

    def _emergency():
        kws = [k for k in cfg.emergency.keywords if k.strip()]
        if not kws:
            return None, "no emergency words"
        _r, actions, c = env.talk([f"We have {kws[0]} at the house right now"], now=t_open)
        ok = any(a.get("kind") == "urgent" for a in actions)
        return ok, kws[0] if ok else f"'{kws[0]}' did not raise an urgent alert"
    _check(checks, "emergency_keyword", _emergency)

    def _life():
        replies, _a, _c = env.talk(["I smell gas in my kitchen"], now=t_open)
        return "911" in (replies[0] if replies else ""), "911 first" if replies and "911" in replies[0] else "no 911 line"
    _check(checks, "life_safety", _life)

    def _ai():
        replies, _a, _c = env.talk(["Wait, am I talking to a real person or a robot?"], now=t_open)
        r = (replies[0] if replies else "").lower()
        ok = "virtual assistant" in r or re.search(r"\bai\b", r) is not None
        return ok, "" if ok else "did not say it is an AI"
    _check(checks, "ai_honesty", _ai)

    def _faq():
        for f in cfg.faq:
            if len({w for w in re.findall(r"[a-z]{4,}", f.q.lower())}) >= 2:
                replies, _a, _c = env.talk([f.q], now=t_open)
                ok = bool(replies) and f.a.strip()[:40].lower() in replies[0].lower()
                return ok, f.q[:60] if ok else f"no answer for '{f.q[:60]}'"
        return None, "no FAQ question to try"
    _check(checks, "faq_answer", _faq)

    def _pricing():
        replies, _a, _c = env.talk([f"How much does {job} cost?"], now=t_open)
        r = replies[0] if replies else ""
        if cfg.pricing.mode == "listed":
            want = {f"${i.price_usd:g}" for i in cfg.pricing.items}
            ok = any(w in r for w in want) and all(m in want for m in re.findall(r"\$\d+(?:\.\d+)?", r))
            return ok, "" if ok else "a price outside the list, or none"
        return "$" not in r, "" if "$" not in r else "said a price although none are listed"
    _check(checks, "pricing", _pricing)

    def _stop():
        env.talk(["STOP"], channel="sms", contact="+12025550148", now=t_open)
        ok = env.store.for_tenant(env.tenant.id).is_opted_out("+12025550148")
        return ok, "" if ok else "STOP did not opt out"
    _check(checks, "stop_keyword", _stop)

    out: dict[str, Any] = {}
    if ai is not None:  # GOLIVE_LIVE_AI_CHECK=1 (the provisioning job passes it): one conversation on the real model
        others = _other_business_names(store, rec.id)
        rep = live_ai_check(row, rec, t_open, model=ai.get("model"), settings=ai.get("settings"), env=ai.get("env"),
                            other_names=others)
        out["ai_check"] = rep
        checks.append({"name": "live_ai", "ok": rep["status"] == "passed", "skipped": False,
                       "detail": "; ".join(rep.get("problems") or []) or rep.get("error") or "",
                       "label_he": CHECK_LABELS["live_ai"]})
    passed = all(c["ok"] for c in checks)
    return {"passed": passed, "checks": checks, "ran_at": now.isoformat(), "slug": slug,
            "failed": [c["name"] for c in checks if not c["ok"]], **out}


# ---------------------------------------------------------------------------------------------------------------------
# Live AI check (owner decision 2026-11-25): ONE short scripted conversation against the client's real config on the
# REAL model, through the same engine, prompt and tools a live call uses (voice channel, text only: no Twilio, no audio).
# Off unless GOLIVE_LIVE_AI_CHECK=1. It costs API credit: about 5 caller turns, each 1-2 model calls (estimate in
# `cost_usd` / `tokens` of the report; logged). Checked on what the caller would hear (after the guard):
#   greeting  : the greeting a live call plays names the business (and carries the call notice);
#   details   : the assistant asks for the key details (ZIP / address / name / phone / what is going on);
#   booking   : booking on -> it offers times (real slots from the calendar layer); messages only -> it takes a message
#               and never offers times;
#   forbidden : no price when prices are hidden (only listed prices otherwise), no promises / guarantees / discounts,
#               no other business named or recommended.
# Model error or timeout: retried GOLIVE_AI_RETRIES times (default 2 -> 3 attempts, GOLIVE_AI_TIMEOUT_S each, default
# 90 s), then status "error": the provisioning job is `held` and Meir approves by hand (never blocks forever).
LIVE_AI_ON = ("1", "true", "yes", "on")
PROMISE = re.compile(r"\b(?:i|we)(?: can)? (?:promise|guarantee)\b|\bguaranteed?\b|\bdiscount|\b\d+\s?%\s?off\b|\bfree of charge\b"
                     r"|\b(?:i|we)(?:'ll| will) definitely\b|\bno matter what\b", re.I)
OTHER_BIZ = re.compile(r"\b(?:another|other|a different) (?:company|business|plumber|contractor|provider|technician|agent|"
                       r"realtor|brokerage)\b|\bcompetitor|\btry calling\b", re.I)
DETAIL_Q = re.compile(r"\b(?:zip|address|name|phone|number|where|located|location|timeline|budget|price range|pre-?approved|"
                      r"what(?:'s| is) (?:going on|happening|the (?:problem|issue))|what (?:can|kind))\b", re.I)
MONEY = re.compile(r"\$\s?\d|\b\d+(?:\.\d+)? dollars\b", re.I)
# Plain-words problems for Meir. The result key stays `problems_he` (stored results + the admin read it); the text is English.
_PROBLEM_TEXT = {"greeting": "The greeting doesn't include the business name",
                 "details": "The agent didn't ask for the key details (ZIP / address / name / phone)",
                 "booking": "The agent didn't offer a time for a visit", "message": "The agent didn't take a message (messages-only mode)",
                 "offered_times": "The agent offered times even though booking is off", "price": "The agent said a price that isn't on the list",
                 "promise": "The agent made a promise / gave a discount", "other_business": "The agent mentioned another business"}


def live_ai_enabled(env: dict[str, str] | None = None) -> bool:
    import os
    return ((os.environ if env is None else env).get("GOLIVE_LIVE_AI_CHECK") or "").strip().lower() in LIVE_AI_ON


def _other_business_names(store: Any, own_id: str) -> list[str]:
    if store is None:
        return []
    names = []
    try:
        for r in store.select("tenants"):
            n = str((((r.get("config") or {}).get("business") or {}).get("name")) or "").strip()
            if r.get("id") != own_id and len(n) >= 4:
                names.append(n)
    except Exception:  # noqa: BLE001 - the name list is a best-effort extra check
        log.warning("live ai check: could not list other businesses")
    return names[:500]


class _Metered:
    """Wraps the model client: counts calls, tokens and the cost estimate of this check."""

    def __init__(self, inner: Any):
        self.inner = inner
        self.model = getattr(inner, "model", "")
        self.tokens = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        self.cost_usd = 0.0
        self.calls = 0
        self.texts: list[str] = []  # what the model itself wrote (before the guard), judged too

    def create(self, *a: Any, **kw: Any) -> dict[str, Any]:
        resp = self.inner.create(*a, **kw)
        self.calls += 1
        self.texts += [b.get("text", "") for b in resp.get("content") or [] if b.get("type") == "text" and b.get("text")]
        for k in self.tokens:
            self.tokens[k] += int((resp.get("usage") or {}).get(k) or 0)
        self.cost_usd += float(resp.get("cost_usd") or 0)
        return resp

    def prewarm(self, *a: Any, **kw: Any) -> Any:
        return None  # no call-start warm-up here: every token of the check is a counted turn


class _ModelError(RuntimeError):
    pass


def _script(cfg: Any, zip_ok: str) -> list[tuple[str, str]]:
    """(step, caller line). Short on purpose: about 5 turns."""
    job = cfg.booking.job_types[0]
    if cfg.business.niche == "real_estate":
        return [("open", "Hi, we're starting to look for a house to buy in the area"), ("details", "In the next 3 months, between 450k and 700k"),
                ("details2", f"We're pre-approved and not working with an agent yet, zip {zip_ok}"),
                ("price", "And how much do you charge for that?"), ("bye", "Okay, that's all, thanks")]
    return [("open", f"Hi, I need someone to come out and take a look, it's about {job.lower()}"),
            ("details", f"The ZIP is {zip_ok}, I'm at 123 Main St, Springfield, my name is Test Caller"),
            ("price", "How much is that going to cost me?"), ("choose", "The first time works for me"),
            ("bye", "That's all, thanks")]


def _converse(row: dict[str, Any], rec: Any, at: datetime, model: Any, zip_ok: str) -> dict[str, Any]:
    from sim.fake_calendar import FakeCalendar

    from .conversation import Engine
    env = _Env(row)
    env.engine = Engine(env.store, model, FakeCalendar(), env.settings)
    from .voice import greeting
    hello = greeting(env.tenant)
    transcript = [{"who": "assistant", "text": hello}]
    replies: dict[str, str] = {}
    tools: list[str] = []
    convo_id, contact = "golive-ai-1", "+12025550199"
    raw_all: list[str] = []
    for i, (step, line) in enumerate(_script(rec.config, zip_ok)):
        k = len(model.texts)
        res = env.engine.handle(env.tenant, "voice", contact, line, convo_id, at + timedelta(minutes=i))
        if any(str(n).startswith("fallback:") for n in res.guard or []):
            raise _ModelError(next(str(n) for n in res.guard if str(n).startswith("fallback:"))[:120])
        raw = " ".join(model.texts[k:]).strip()
        turn: dict[str, Any] = {"who": "assistant", "text": res.reply}
        fixed = [str(n) for n in res.guard or [] if str(n).startswith("reply:")]
        if raw and fixed:  # the guard changed what the model wrote: keep both, Meir sees what the model tried
            turn.update(model_text=raw[:600], guard=fixed)
        transcript += [{"who": "customer", "text": line}, turn]
        raw_all.append(raw)
        replies[step] = res.reply
        tools += [t.get("name", "") for t in res.tool_calls or []]
        if res.end:
            break
    c = env.engine.convos.get((env.tenant.id, "voice", convo_id))
    return {"greeting": hello, "transcript": transcript, "replies": replies, "tools": tools, "raw": raw_all,
            "offered": bool(c and c.offered), "booked": bool(c and c.booking), "message": bool(c and c.message)}


def _judge(rec: Any, conv: dict[str, Any], other_names: list[str]) -> list[str]:
    cfg = rec.config
    said = [t["text"] for t in conv["transcript"][1:] if t["who"] == "assistant"]
    every = " ".join(said + list(conv.get("raw") or []))  # forbidden content: what the caller hears AND what the model wrote
    problems: list[str] = []
    if cfg.business.name.lower() not in conv["greeting"].lower():
        problems.append("greeting")
    if not any("?" in s and DETAIL_Q.search(s) for s in said):
        problems.append("details")
    if cfg.booking.enabled:
        if not (conv["offered"] or "get_availability" in conv["tools"]):
            problems.append("booking")
    else:
        if not (conv["message"] or "take_message" in conv["tools"]):
            problems.append("message")
        if conv["offered"]:
            problems.append("offered_times")
    if cfg.pricing.mode == "listed":
        allowed = {f"{i.price_usd:g}" for i in cfg.pricing.items}
        if any(m.replace(",", "") not in allowed for m in re.findall(r"\$\s?(\d[\d,]*(?:\.\d+)?)", every)):
            problems.append("price")
    elif MONEY.search(every):
        problems.append("price")
    if PROMISE.search(every):
        problems.append("promise")
    low = every.lower()
    if OTHER_BIZ.search(every) or any(n.lower() in low for n in other_names if n.lower() != cfg.business.name.lower()):
        problems.append("other_business")
    return problems


def live_ai_check(row: dict[str, Any], rec: Any, at: datetime, *, model: Any = None, settings: Any = None,
                  env: dict[str, str] | None = None, other_names: list[str] | tuple[str, ...] = ()) -> dict[str, Any]:
    """Run the scripted conversation on the real model. Returns {status passed|failed|error, problems, transcript,
    attempts, cost_usd, tokens, model}. Never raises."""
    import os
    from concurrent.futures import ThreadPoolExecutor
    from concurrent.futures import TimeoutError as FutTimeout
    e = os.environ if env is None else env
    retries = max(0, int(e.get("GOLIVE_AI_RETRIES") or 2))
    timeout = float(e.get("GOLIVE_AI_TIMEOUT_S") or 90)
    if model is None:
        from .llm import LLMClient
        s = settings if settings is not None else settings_mod.load()
        model = LLMClient(s, namespace="golive_ai", mode=getattr(s, "brain_mode", "live"))
    zips = list(rec.config.business.service_area_zips)
    zip_ok = zips[0] if zips else "10001"
    meter = _Metered(model)
    rep: dict[str, Any] = {"status": "error", "problems": [], "transcript": [], "attempts": 0, "model": meter.model}
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="golive-ai")
    try:
        for attempt in range(1, retries + 2):
            rep["attempts"] = attempt
            fut = pool.submit(_converse, row, rec, at, meter, zip_ok)
            try:
                conv = fut.result(timeout=timeout)
            except FutTimeout:
                rep["error"] = f"timeout after {timeout:g}s"
                continue
            except _ModelError as exc:
                rep["error"] = f"model error ({exc})"
                continue
            except Exception as exc:  # noqa: BLE001 - any crash = this attempt failed; never block the job
                log.exception("live ai check crashed")
                rep["error"] = f"{type(exc).__name__}"
                continue
            problems = _judge(rec, conv, list(other_names))
            rep.update(status="failed" if problems else "passed", problems=problems,
                       problems_he=[_PROBLEM_TEXT.get(p, p) for p in problems], transcript=conv["transcript"],
                       offered=conv["offered"], booked=conv["booked"], message=conv["message"])
            rep.pop("error", None)
            break
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    rep["cost_usd"] = round(meter.cost_usd, 6)
    rep["tokens"] = dict(meter.tokens)
    rep["model_calls"] = meter.calls
    if rep["status"] == "error" and not rep["transcript"]:
        rep["problems_he"] = []
    log.info("golive live ai check %s: %s, %d model calls, tokens in %d / out %d, cost estimate $%.4f",
             row.get("slug"), rep["status"], meter.calls, meter.tokens["input_tokens"], meter.tokens["output_tokens"],
             rep["cost_usd"])
    return rep
