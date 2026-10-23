"""Reports for the client portal and e-mail (task B6, TASKS Addendum 2).

- `daily_summary`: per tenant, at `notify.daily_summary` (default 19:00) in the tenant's timezone.
  Covers everything since the previous summary (or local midnight), so nothing falls between days.
- `monthly_roi`: per tenant, for the previous calendar month, from the 1st at 09:00 tenant time:
  calls answered (and after hours), jobs booked, messages, urgent, text-backs, usage vs. included,
  estimated value of booked jobs (= bookings x the average job value the client sets; omitted
  until set) and that value as a multiple of the RCP monthly fee (read from pricebook.json).
- `admin_daily`: 08:00 in the admin timezone (brand.json owner.timezone), Hebrew, to Meir: per tenant calls / bookings / leads, Claude and
  Twilio cost, usage %, flags (needs_addon_approval, calendar reconnect, Zapier dead letters),
  plus notices that were held overnight.
Every report is stored as an `events` row (`report.daily_summary` / `report.monthly_roi`,
client_visible) so the portal renders it; e-mail goes through the Notifier.
`Reporter.run_due(now)` is idempotent and is what `POST /jobs/tick` calls (every 5-15 minutes).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .notify import templates as T
from .notify.calllog import twilio_cost_key
from .notify.core import Notifier
from .store import StateStore, Store, StoreError
from .tenants import DAYS, TenantConfigError, TenantRecord, load_record
from .usage import KINDS, included_usage

log = logging.getLogger("rt.reports")

ANSWERED = ("booked", "message", "handoff", "emergency")
# A moved booking counts once, in the period it was first made (its replacement row has `rescheduled_from_id`);
# a no-show was still a booking. Cancelled bookings are not counted as booked.
BOOKED_STATUSES = ("booked", "confirmed", "completed", "rescheduled", "no_show")
CALLBACK_OUTCOMES = ("message",)  # calls that ended with a message (no booking): candidates to call back
CALLBACK_LIMIT = 10
MONTHLY_HOUR = 9


def _dt(v: Any) -> datetime | None:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _tz(tenant: TenantRecord) -> ZoneInfo:
    return ZoneInfo(tenant.config.business.timezone)


def _in(v: Any, start: datetime, end: datetime) -> bool:
    d = _dt(v)
    return d is not None and start <= d < end


def is_after_hours(tenant: TenantRecord, when: datetime) -> bool:
    local = when.astimezone(_tz(tenant))
    span = getattr(tenant.config.hours, DAYS[local.weekday()])
    if span is None:
        return True
    return not (time.fromisoformat(span[0]) <= local.time() < time.fromisoformat(span[1]))


def avg_job_value_key(tenant_id: str) -> str:
    return f"roi:{tenant_id}:avg_job_value_usd"


def rcp_monthly_usd() -> float | None:
    cents = T.pricebook_item("RCP").get("monthly_cents")
    return cents / 100 if cents else None


def activity(store: Store, tenant: TenantRecord, start: datetime, end: datetime) -> dict[str, Any]:
    """Counts for [start, end) from calls, sms_messages and bookings (tenant-scoped reads)."""
    ts = store.for_tenant(tenant.id)
    tz = _tz(tenant)
    calls = [c for c in ts.select("calls") if _in(c.get("started_at") or c.get("created_at"), start, end)]
    sms = [m for m in ts.select("sms_messages") if _in(m.get("created_at"), start, end)]
    all_bookings = ts.select("bookings")
    bookings = [b for b in all_bookings if _in(b.get("created_at"), start, end) and b.get("status") in BOOKED_STATUSES
                and not b.get("rescheduled_from_id")]
    answered = [c for c in calls if c.get("outcome") in ANSWERED]
    leads = []
    for b in bookings:
        leads.append({"when": (_dt(b["created_at"]) or start).astimezone(tz).strftime("%I:%M %p").lstrip("0"),
                      "name": b.get("customer_name") or "Customer", "job_type": b.get("job_type") or "-",
                      "outcome": "booked"})
    for c in answered:
        if c.get("outcome") == "booked":
            continue
        tail = (c.get("from_e164") or "")[-4:]
        leads.append({"when": (_dt(c.get("started_at")) or start).astimezone(tz).strftime("%I:%M %p").lstrip("0"),
                      "name": f"Caller ending {tail}" if tail else "Caller", "job_type": "-",
                      "outcome": {"message": "message taken", "handoff": "transferred",
                                  "emergency": "urgent"}.get(c["outcome"], c["outcome"])})
    return {
        "calls_answered": len(answered),
        "after_hours_calls": sum(1 for c in answered if is_after_hours(tenant, _dt(c.get("started_at")) or start)),
        "booked": len(bookings),
        "messages": sum(1 for c in calls if c.get("outcome") in ("message", "handoff")),
        "urgent": sum(1 for c in calls if c.get("outcome") == "emergency"),
        "text_backs": sum(1 for c in calls if c.get("outcome") == "abandoned"),
        "sms_threads": len({m.get("contact_e164") for m in sms if m.get("direction") == "inbound"}),
        "spam": sum(1 for c in calls if c.get("outcome") == "spam"),
        "leads": leads,
        **appointment_counts(ts, all_bookings, start, end),
    }


def appointment_counts(ts: Any, bookings: list[dict[str, Any]], start: datetime, end: datetime) -> dict[str, int]:
    """Appointment manager: customer confirmations, moves and cancellations in [start, end) (logged as
    `appointment.*` events by the engine), and no-shows the client marked for visits in the period."""
    evs = [e for e in ts.select("events") if str(e.get("type") or "").startswith("appointment.")
           and _in(e.get("created_at"), start, end)]
    return {
        "confirmations": sum(1 for b in bookings if _in(b.get("confirmed_at"), start, end)),
        "reschedules": sum(1 for e in evs if e["type"] == "appointment.rescheduled"),
        "cancellations": sum(1 for e in evs if e["type"] == "appointment.cancelled"),
        "no_shows": sum(1 for b in bookings if b.get("status") == "no_show" and _in(b.get("start_at"), start, end)),
    }


def worth_calling_back(store: Store, tenant: TenantRecord, start: datetime, end: datetime,
                       limit: int = CALLBACK_LIMIT) -> list[dict[str, Any]]:
    """Calls in [start, end) that ended with a message (not a booking), with a job type, and from a number that has
    not booked since: the owner's best call-backs ("Second Chance Leads"). Newest first."""
    ts = store.for_tenant(tenant.id)
    tz = _tz(tenant)
    later: dict[str, list[datetime]] = {}
    for b in ts.select("bookings"):
        when = _dt(b.get("created_at"))
        if b.get("contact_e164") and when:
            later.setdefault(b["contact_e164"], []).append(when)
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    calls = sorted((c for c in ts.select("calls") if _in(c.get("started_at") or c.get("created_at"), start, end)),
                   key=lambda c: str(c.get("started_at") or c.get("created_at")), reverse=True)
    for c in calls:
        num, when = c.get("from_e164") or "", _dt(c.get("started_at") or c.get("created_at"))
        if c.get("outcome") not in CALLBACK_OUTCOMES or not c.get("job_type") or not num or num in seen or when is None:
            continue
        seen.add(num)
        if any(t > when for t in later.get(num, [])):
            continue
        out.append({"when": when.astimezone(tz).strftime("%a %b %d, %I:%M %p").replace(" 0", " "), "at": when.isoformat(),
                    "phone": num, "job_type": c["job_type"], "summary": (c.get("summary") or "")[:200]})
        if len(out) >= limit:
            break
    return out


def daily_summary_data(store: Store, tenant: TenantRecord, start: datetime, end: datetime) -> dict[str, Any]:
    d = activity(store, tenant, start, end)
    d["date"] = end.astimezone(_tz(tenant)).date().isoformat()
    d["period"] = {"start": start.isoformat(), "end": end.isoformat()}
    return d


def month_bounds(tenant: TenantRecord, month: str) -> tuple[datetime, datetime]:
    y, m = (int(x) for x in month.split("-"))
    tz = _tz(tenant)
    start = datetime(y, m, 1, tzinfo=tz)
    end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=tz)
    return start, end


def monthly_roi_data(store: Store, state: StateStore, tenant: TenantRecord, month: str) -> dict[str, Any]:
    start, end = month_bounds(tenant, month)
    r = activity(store, tenant, start, end)
    r.pop("leads")
    r["month"] = month
    r["month_label"] = start.strftime("%B %Y")
    r["included"] = included_usage()
    r["usage"] = {v: float(state.get(f"usage:{tenant.id}:{month}:{v}", 0) or 0) for v in KINDS.values()}
    r["needs_addon_approval"] = bool(state.get(f"usage:{tenant.id}:{month}:needs_addon_approval"))
    avg = state.get(avg_job_value_key(tenant.id))
    fee = rcp_monthly_usd()
    r["avg_job_value_usd"] = float(avg) if avg else None
    r["est_value_usd"] = round(r["booked"] * float(avg), 2) if avg else None
    r["monthly_fee_usd"] = fee
    r["roi_multiple"] = round(r["est_value_usd"] / fee, 2) if (r["est_value_usd"] is not None and fee) else None
    return r


RESULT_KEYS = ("calls_answered", "after_hours_calls", "booked", "messages", "confirmations", "reschedules",
               "cancellations", "no_shows")


def change_pct(now_v: float, before: float) -> int | None:
    """Month-over-month change in whole percent; None when there is nothing to compare with."""
    if not before:
        return None
    return round((now_v - before) * 100 / before)


def results_data(store: Store, state: StateStore, tenant: TenantRecord, month: str) -> dict[str, Any]:
    """The portal "Results" panel and the weekly e-mail: this month's numbers, the previous month, the change in
    percent, the estimated value and the calls worth calling back."""
    r = monthly_roi_data(store, state, tenant, month)
    start, end = month_bounds(tenant, month)
    prev_month = (start - timedelta(days=1)).strftime("%Y-%m")
    p_start, p_end = month_bounds(tenant, prev_month)
    prev = activity(store, tenant, p_start, p_end)
    r["previous"] = {"month": prev_month, **{k: prev[k] for k in RESULT_KEYS}}
    r["change_pct"] = {k: change_pct(r[k], prev[k]) for k in RESULT_KEYS}
    r["worth_calling_back"] = worth_calling_back(store, tenant, start, end)
    return r


def weekly_data(store: Store, state: StateStore, tenant: TenantRecord, end: datetime) -> dict[str, Any]:
    start = end - timedelta(days=7)
    r = activity(store, tenant, start, end)
    r.pop("leads")
    avg = state.get(avg_job_value_key(tenant.id))
    r["avg_job_value_usd"] = float(avg) if avg else None
    r["est_value_usd"] = round(r["booked"] * float(avg), 2) if avg else None
    prev = activity(store, tenant, start - timedelta(days=7), start)
    r["previous"] = {k: prev[k] for k in RESULT_KEYS}
    r["worth_calling_back"] = worth_calling_back(store, tenant, start, end, limit=5)
    tz = _tz(tenant)
    r["period_label"] = f"{start.astimezone(tz):%b} {start.astimezone(tz).day} to {end.astimezone(tz):%b} {end.astimezone(tz).day}"
    return r


def _failed(results: list[dict[str, Any]]) -> bool:
    return any(r.get("status") == "failed" for r in results)


def _tenants(store: Store) -> list[TenantRecord]:
    out = []
    for row in store.select("tenants"):
        try:
            out.append(load_record(row))
        except TenantConfigError:
            log.error("skipping tenant with invalid config in reports")
    return out


WEEKLY_DAY, WEEKLY_HOUR = 0, 9  # Monday 09:00 tenant time


@dataclass
class Reporter:
    store: Store
    state: StateStore
    notifier: Notifier
    weekly_enabled: bool = False  # settings.weekly_report (WEEKLY_REPORT=1), off until approved

    def _store_report(self, tenant: TenantRecord, type_: str, data: dict[str, Any]) -> None:
        try:
            self.store.for_tenant(tenant.id).insert("events", {"actor": "runtime", "entity": "tenant", "type": type_,
                                                               "payload": data, "client_visible": True})
        except StoreError:
            log.exception("could not store %s", type_)

    # --- per job -------------------------------------------------------------------------------
    def daily(self, tenant: TenantRecord, now: datetime) -> dict[str, Any] | None:
        hhmm = tenant.config.notify.daily_summary
        if not hhmm or not tenant.active:
            return None
        local = now.astimezone(_tz(tenant))
        if local.time() < time.fromisoformat(hhmm):
            return None
        day = local.date().isoformat()
        done_key = f"report:daily:{tenant.id}:{day}"
        if self.state.get(done_key):
            return None
        last = _dt(self.state.get(f"report:daily:{tenant.id}:last_end"))
        start = max(last, now - timedelta(days=2)) if last else datetime.combine(local.date(), time(0), _tz(tenant))
        data = daily_summary_data(self.store, tenant, start, now)
        if not self.state.get(f"{done_key}:stored"):
            self._store_report(tenant, "report.daily_summary", data)
            self.state.put(f"{done_key}:stored", True, tenant.id)
        subject, text, html = T.daily_summary(tenant.config.business.name, data)
        sent = self.notifier.send_owner_report(tenant, "daily_summary", subject, text, html, f"daily:{day}") \
            if tenant.status == "live" else [{"status": "skipped", "reason": "tenant_not_live"}]
        if _failed(sent):  # not marked done: the next tick tries again
            return {"job": "daily_summary", "tenant": tenant.slug, "sent": sent, "retry": True}
        self.state.put(done_key, True, tenant.id)
        self.state.put(f"report:daily:{tenant.id}:last_end", now.isoformat(), tenant.id)
        return {"job": "daily_summary", "tenant": tenant.slug, "sent": sent}

    def monthly(self, tenant: TenantRecord, now: datetime) -> dict[str, Any] | None:
        local = now.astimezone(_tz(tenant))
        if local.day == 1 and local.hour < MONTHLY_HOUR:
            return None
        prev = (local.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
        done_key = f"report:monthly:{tenant.id}:{prev}"
        if self.state.get(done_key):
            return None
        data = monthly_roi_data(self.store, self.state, tenant, prev)
        if not self.state.get(f"{done_key}:stored"):
            self._store_report(tenant, "report.monthly_roi", data)
            self.state.put(f"{done_key}:stored", True, tenant.id)
        subject, text, html = T.monthly_roi(tenant.config.business.name, data)
        idle = not (data["calls_answered"] or data["booked"] or any(data["usage"].values()))
        if tenant.status != "live":
            sent = [{"status": "skipped", "reason": "tenant_not_live"}]
        elif idle:
            sent = [{"status": "skipped", "reason": "no_activity"}]
        else:
            sent = self.notifier.send_owner_report(tenant, "monthly_roi", subject, text, html, f"monthly:{prev}")
        if _failed(sent):
            return {"job": "monthly_roi", "tenant": tenant.slug, "month": prev, "sent": sent, "retry": True}
        self.state.put(done_key, True, tenant.id)
        return {"job": "monthly_roi", "tenant": tenant.slug, "month": prev, "sent": sent}

    def weekly(self, tenant: TenantRecord, now: datetime) -> dict[str, Any] | None:
        """Weekly results e-mail (key `report:weekly:<tenant>:<ISO week>`), Monday 09:00 tenant time, live tenants."""
        if not self.weekly_enabled or not tenant.active or tenant.status != "live":
            return None
        local = now.astimezone(_tz(tenant))
        if local.weekday() != WEEKLY_DAY or local.hour < WEEKLY_HOUR:
            return None
        iso = local.isocalendar()
        week = f"{iso[0]}-W{iso[1]:02d}"
        done_key = f"report:weekly:{tenant.id}:{week}"
        if self.state.get(done_key):
            return None
        end = datetime.combine(local.date(), time(0), _tz(tenant))
        data = weekly_data(self.store, self.state, tenant, end)
        if not (data["calls_answered"] or data["booked"] or data["worth_calling_back"]):
            sent = [{"status": "skipped", "reason": "no_activity"}]
        else:
            subject, text, html = T.weekly_results(tenant.config.business.name, data)
            sent = self.notifier.send_owner_report(tenant, "weekly_results", subject, text, html, f"weekly:{week}")
        if _failed(sent):
            return {"job": "weekly_results", "tenant": tenant.slug, "week": week, "sent": sent, "retry": True}
        self.state.put(done_key, True, tenant.id)
        return {"job": "weekly_results", "tenant": tenant.slug, "week": week, "sent": sent}

    def admin_daily_data(self, tenants: list[TenantRecord], now: datetime) -> dict[str, Any]:
        rows = []
        for t in tenants:
            tz = _tz(t)
            yday = now.astimezone(tz).date() - timedelta(days=1)
            start = datetime.combine(yday, time(0), tz)
            act = activity(self.store, t, start, start + timedelta(days=1))
            month = start.strftime("%Y-%m")
            inc = included_usage()
            used = {v: float(self.state.get(f"usage:{t.id}:{month}:{v}", 0) or 0) for v in KINDS.values()}
            ts = self.store.for_tenant(t.id)
            evs = ts.select("events")
            dead = sum(1 for e in evs if e.get("type") == "zapier.dead_letter" and _in(e.get("created_at"), start, now))
            flags = []
            if self.state.get(f"usage:{t.id}:{month}:needs_addon_approval"):
                flags.append("needs_addon_approval")
            reconnect = self.state.get(f"cal:{t.id}:needs_reconnect")
            if reconnect:
                flags.append(f"calendar_reconnect:{reconnect.get('provider')}")
            if dead:
                flags.append(f"zapier_dead_letter:{dead}")
            if not t.active:
                flags.append("paused")
            rows.append({
                "business": t.config.business.name, "slug": t.slug, "calls": act["calls_answered"],
                "booked": act["booked"], "leads": act["calls_answered"] + act["sms_threads"],
                "claude_usd": round(float(self.state.get(f"spend:{t.id}:{yday.isoformat()}", 0) or 0), 2),
                "twilio_usd": round(float(self.state.get(twilio_cost_key(t.id, yday.isoformat()), 0) or 0), 2),
                "voice_pct": round(100 * used["voice_minutes"] / inc["voice_minutes"]),
                "sms_pct": round(100 * used["sms_segments"] / inc["sms_segments"]),
                "flags": flags})
        totals = {"leads": sum(r["leads"] for r in rows), "booked": sum(r["booked"] for r in rows),
                  "problems": sum(1 for r in rows if any(not f.startswith("paused") for f in r["flags"])),
                  "cost_usd": round(sum(r["claude_usd"] + r["twilio_usd"] for r in rows), 2)}
        il_date = now.astimezone(ZoneInfo(self.notifier.policy.admin_tz)).date().isoformat()
        return {"date": il_date, "tenants": rows, "totals": totals,
                "notices": list(self.state.get("admin:deferred") or [])}

    def admin_daily(self, now: datetime) -> dict[str, Any] | None:
        local = now.astimezone(ZoneInfo(self.notifier.policy.admin_tz))
        if local.hour < 8:
            return None
        key = f"report:admin_daily:{local.date().isoformat()}"
        if self.state.get(key):
            return None
        data = self.admin_daily_data(_tenants(self.store), now)
        subject, text, html = T.admin_daily(data)
        res = self.notifier.send_admin_report(subject, text, html, key)
        if res.get("status") == "failed":
            return {"job": "admin_daily", "date": data["date"], "sent": res, "retry": True}
        self.state.put("admin:deferred", [])
        self.state.put(key, True)
        return {"job": "admin_daily", "date": data["date"], "sent": res}

    def run_due(self, now: datetime | None = None) -> list[dict[str, Any]]:
        now = now or datetime.now(timezone.utc)
        ran: list[dict[str, Any]] = []
        for t in _tenants(self.store):
            for job in (self.daily, self.monthly, self.weekly):
                try:
                    r = job(t, now)
                except Exception:  # noqa: BLE001 - one tenant must not stop the others
                    log.exception("report job failed for %s", t.slug)
                    r = {"job": job.__name__, "tenant": t.slug, "error": True}
                if r:
                    ran.append(r)
        try:
            r = self.admin_daily(now)
        except Exception:  # noqa: BLE001
            log.exception("admin_daily failed")
            r = {"job": "admin_daily", "error": True}
        if r:
            ran.append(r)
        return ran


def daily_for_date(store: Store, tenant: TenantRecord, day: date) -> dict[str, Any]:
    """Portal/admin view of one full local day."""
    start = datetime.combine(day, time(0), _tz(tenant))
    return daily_summary_data(store, tenant, start, start + timedelta(days=1))
