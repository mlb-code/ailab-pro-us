"""Notification texts. Owner (client) messages and admin (Meir) messages: US English, LTR (English-only since 2026-11-29).

Subjects follow SPEC section 5 (`lead_alert`, `daily_summary`, `admin_daily`); urgent and
human-needed leads get a short prefix so they stand out in the inbox. Every customer-supplied
value is HTML-escaped. Brand and prices are read from brand.json / pricebook.json.
"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any

from ..settings import REPO_DIR, brand

SMS_MAX = 320


def esc(v: Any) -> str:
    return html.escape("" if v is None else str(v))


def money(cents_or_usd: float, cents: bool = False) -> str:
    usd = cents_or_usd / 100 if cents else cents_or_usd
    return f"${usd:,.0f}" if float(usd).is_integer() else f"${usd:,.2f}"


def pricebook_item(code: str) -> dict[str, Any]:
    for path in (Path(__file__).resolve().parent.parent / "pricebook.json", REPO_DIR / "config" / "pricebook.json"):
        try:
            items = json.loads(path.read_text(encoding="utf-8")).get("items") or []
        except (OSError, ValueError):
            continue
        for it in items:
            if it.get("code") == code:
                return it
    return {}


def brand_name() -> str:
    return str(brand().get("name") or "Receptionist")


def portal_url() -> str:
    return f"{str(brand().get('site_url') or '').rstrip('/')}/start/"


def city_of(address: str) -> str:
    """'12 Main St, Houston, TX 77002' -> 'Houston'; falls back to the ZIP or '-'."""
    parts = [p.strip() for p in (address or "").split(",") if p.strip()]
    if len(parts) >= 3:
        return parts[-2]
    if len(parts) == 2 and not re.search(r"\d", parts[1].split()[0] if parts[1].split() else ""):
        return parts[1].split()[0]
    m = re.search(r"\b\d{5}\b", address or "")
    return f"ZIP {m.group(0)}" if m else "-"


def _wrap(title: str, body_html: str, lang: str = "en", footer: str = "") -> str:
    rtl = lang == "he"
    font = "Arial,Helvetica,sans-serif"
    return (f'<!doctype html><html lang="{lang}" dir="{"rtl" if rtl else "ltr"}"><body style="margin:0;'
            f'background:#f4f5f7;font-family:{font}"><div style="max-width:600px;margin:0 auto;padding:16px">'
            f'<div style="background:#0F1A26;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;'
            f'font-weight:bold">{esc(title)}</div><div style="background:#fff;padding:18px;border-radius:0 0 8px 8px;'
            f'color:#1b2430;line-height:1.5;text-align:{"right" if rtl else "left"}">{body_html}</div>'
            f'<div style="color:#667;font-size:12px;padding:10px 4px">{footer}</div></div></body></html>')


def _rows(pairs: list[tuple[str, Any]]) -> str:
    cells = "".join(f'<tr><td style="padding:4px 10px 4px 0;color:#667;white-space:nowrap">{esc(k)}</td>'
                    f'<td style="padding:4px 0">{esc(v)}</td></tr>' for k, v in pairs)
    return f'<table style="border-collapse:collapse;width:100%">{cells}</table>'


def _footer_en() -> str:
    addr = brand().get("physical_address") or ""
    return (f'{esc(brand_name())} · Manage alerts and reports in your portal: '
            f'<a href="{esc(portal_url())}">{esc(portal_url())}</a>' + (f" · {esc(addr)}" if addr else ""))


# --- lead alert (owner) -----------------------------------------------------------------
PREFIX = {"urgent": "[URGENT] ", "human_needed": "[HUMAN NEEDED] "}
QUALIFICATION_TITLES = (("intent", "Lead type"), ("area", "Area / property"), ("property_address", "Property address"),
                        ("timeline", "Timeline"), ("price_range", "Price range"), ("pre_approval", "Pre-approval"),
                        ("has_agent", "Working with an agent"))


def lead_alert(business: str, kind: str, lead: dict[str, Any]) -> tuple[str, str, str, str]:
    """(subject, text, html, sms) for the owner."""
    job = lead.get("job_type") or "General inquiry"
    name = lead.get("name") or "Unknown caller"
    city = city_of(lead.get("address") or "")
    q = dict(lead.get("qualification") or {})
    if q.get("intent"):  # real estate: "Buyer · Buyer consultation" / "Seller lead"
        job = f"{str(q['intent']).capitalize()} · {job}" if lead.get("job_type") else f"{str(q['intent']).capitalize()} lead"
    subject = f"{PREFIX.get(kind, '')}{'Booking change' if kind == 'booking_change' else 'New lead'}: {job} · {name} · {city}"
    channel = {"voice": "Phone call", "chat": "Website chat"}.get(lead.get("channel") or "", "Text message")
    pairs = [("Name", name), ("Phone", lead.get("phone") or "-"), ("Job", job),
             ("Urgency", lead.get("urgency") or "normal"), ("Address", lead.get("address") or "-"),
             ("Channel", channel), ("Summary", lead.get("summary") or "-")]
    if lead.get("email"):
        pairs.insert(2, ("Email", lead["email"]))
    if lead.get("booking_label"):
        pairs.insert(3, ("Booked", lead["booking_label"]))
    for key, title in QUALIFICATION_TITLES:  # real-estate screening answers
        if q.get(key):
            pairs.append((title, q[key]))
    text = "\n".join([subject, ""] + [f"{k}: {v}" for k, v in pairs] + ["", f"Portal: {portal_url()}"])
    intro = {"urgent": "An urgent request just came in. Please call the customer back now.",
             "human_needed": "The customer asked for a person. Please call back.",
             "booking": "The AI receptionist booked a job on your calendar.",
             "booking_change": "A customer moved or cancelled a visit the AI receptionist booked. Your calendar is updated."}.get(
        kind, "The AI receptionist took a new lead for you.")
    body = f"<p>{esc(intro)}</p>{_rows(pairs)}"
    if lead.get("transcript"):
        lines = "".join(f"<div><b>{esc(t.get('who', ''))}:</b> {esc(t.get('text', ''))}</div>"
                        for t in lead["transcript"][-12:])
        body += f'<p style="margin-top:16px;color:#667">Transcript (last lines)</p>{lines}'
    html_ = _wrap(f"{business}: {subject}", body, "en", _footer_en())
    head = {"urgent": "URGENT lead", "human_needed": "Call back requested", "booking": "New booking",
            "booking_change": "Booking change"}.get(kind, "New lead")
    sms = f"{head}: {name}, {lead.get('phone') or '-'}, {job}"
    if lead.get("booking_label"):
        sms += f", {lead['booking_label']}"
    brief = [str(q[k]) for k in ("area", "timeline", "pre_approval", "has_agent") if q.get(k)]
    if brief:
        sms += " (" + ", ".join(brief) + ")"
    if lead.get("summary"):
        sms += f". {lead['summary']}"
    sms = sms[: SMS_MAX - 24].rstrip() + " Details: check your email."
    return subject, text, html_, sms


def dispatch_rows(d: dict[str, Any]) -> list[tuple[str, Any]]:
    """ADD-DISPATCH lines for the daily summary / monthly report (only when the add-on is on)."""
    x = d.get("dispatch")
    if not x:
        return []
    rows: list[tuple[str, Any]] = [("Urgent calls sent to your on-call team", x["urgent_transfers"]),
                                   ("  connected to a technician", x["connected"])]
    if x.get("avg_accept_s") is not None:
        rows.append(("  average time to pick up", f"{x['avg_accept_s']} seconds"))
    return rows


# --- daily summary (owner) ----------------------------------------------------------------
def daily_summary(business: str, d: dict[str, Any], sms_enabled: bool = False) -> tuple[str, str, str]:
    """sms_enabled = settings.sms_enabled (SMS_ENABLED master switch, via NotifyPolicy): off = no texting rows, because
    no text is answered or sent and the owner would only see zeros for a feature that is switched off."""
    subject = f"Today: {d['calls_answered']} calls answered, {d['booked']} booked"
    pairs = [("Calls answered", d["calls_answered"]), ("Jobs booked", d["booked"]),
             ("Messages taken", d["messages"]), ("Urgent", d["urgent"])]
    if sms_enabled:
        pairs += [("Text conversations", d["sms_threads"]), ("Missed callers texted back", d["text_backs"])]
    pairs += dispatch_rows(d)
    leads = d.get("leads") or []
    text = "\n".join([subject, f"{business}, {d['date']}", ""] + [f"{k}: {v}" for k, v in pairs]
                     + ([""] + [f"- {x['when']} {x['name']} ({x['job_type']}): {x['outcome']}" for x in leads] if leads else [])
                     + ["", f"Portal: {portal_url()}"])
    items = "".join(f"<li>{esc(x['when'])} · {esc(x['name'])} · {esc(x['job_type'])} · {esc(x['outcome'])}</li>"
                    for x in leads)
    body = _rows(pairs) + (f'<p style="margin-top:14px">Leads today</p><ul>{items}</ul>' if items else
                           '<p style="margin-top:14px;color:#667">No new leads today.</p>')
    return subject, text, _wrap(f"{business} · {d['date']}", body, "en", _footer_en())


# --- monthly ROI report (owner) ------------------------------------------------------------
def monthly_roi(business: str, r: dict[str, Any], sms_enabled: bool = False) -> tuple[str, str, str]:
    """sms_enabled = settings.sms_enabled (SMS_ENABLED, via NotifyPolicy), as in `daily_summary`: off = no texting rows
    ("Missed callers texted back", "SMS segments used"); the other rows, the estimated value and the ROI do not use them.
    FirstRing plan clients (`r["plan"]`, reports.monthly_roi_data): the month's call minutes next to what the plan
    includes per billing period (the trial's total while trialing), no SMS allowance row (plans include none), and the
    value compared with the plan's monthly price only when `roi_multiple` is set (an active, paid plan)."""
    subject = f"Your {r['month_label']} report: {r['calls_answered']} calls answered, {r['booked']} booked"
    pairs = [("Calls answered by the AI receptionist", r["calls_answered"]),
             ("  of them after hours", r["after_hours_calls"]),
             ("Jobs booked", r["booked"]), ("Messages taken for call-back", r["messages"]),
             ("Urgent requests flagged", r["urgent"])]
    if sms_enabled:
        pairs.append(("Missed callers texted back", r["text_backs"]))
    pairs += dispatch_rows(r)
    plan = r.get("plan")
    if plan is None:
        pairs.append(("Voice minutes used", f"{r['usage']['voice_minutes']:g} of {r['included']['voice_minutes']:g}"))
        if sms_enabled:
            pairs.append(("SMS segments used", f"{r['usage']['sms_segments']:g} of {r['included']['sms_segments']:g}"))
    else:
        used, inc = f"{r['usage']['voice_minutes']:,g}", plan.get("included_minutes")
        pairs.append(("Voice minutes used", used if not inc else
                      f"{used} (your free trial includes {inc:,g} minutes in total)" if plan.get("trial") else
                      f"{used} (your {plan['name']} plan includes {inc:,g} minutes each billing period)"))
    if r.get("est_value_usd") is not None:
        pairs.insert(3, ("Estimated value of booked jobs", f"{money(r['est_value_usd'])} "
                                                           f"({r['booked']} x {money(r['avg_job_value_usd'])} average job)"))
    if r.get("roi_multiple") is not None:
        pairs.insert(4, ("Value vs. your monthly fee" if plan is None else
                         f"Value vs. your {plan['name']} plan price ({money(r['monthly_fee_usd'])}/month)",
                         f"{r['roi_multiple']:.1f}x"))
    notes = ["Estimated value uses the average job value you set; it is an estimate, not revenue."
             if r.get("est_value_usd") is not None else
             "Tip: set your average job value in the portal to see the estimated value of booked jobs."]
    if plan is not None:
        minutes_note = "Voice minutes are this month's calls, each rounded up to the next minute."
        if plan.get("included_minutes") and plan.get("trial"):
            minutes_note += (" Your free trial's minutes cover the whole trial; the Billing tab in your portal shows "
                             "how many are left.")
        elif plan.get("included_minutes"):
            minutes_note += (" Your plan's included minutes start over on each billing date; the Billing tab in your "
                             "portal shows the current period.")
        notes.append(minutes_note)
    text = "\n".join([subject, business, ""] + [f"{k.strip()}: {v}" for k, v in pairs] + ["", *notes, f"Portal: {portal_url()}"])
    body = _rows(pairs) + "".join(f'<p style="margin-top:14px;color:#667">{esc(n)}</p>' for n in notes)
    return subject, text, _wrap(f"{business} · {r['month_label']}", body, "en", _footer_en())


def weekly_results(business: str, r: dict[str, Any]) -> tuple[str, str, str]:
    """Weekly results e-mail (WEEKLY_REPORT=1): last week's numbers and the calls worth calling back."""
    subject = f"Your week: {r['calls_answered']} calls answered, {r['booked']} booked"
    prev = r.get("previous") or {}
    pairs = [("Calls answered", f"{r['calls_answered']} (week before: {prev.get('calls_answered', 0)})"),
             ("  of them after hours", r["after_hours_calls"]),
             ("Jobs booked", f"{r['booked']} (week before: {prev.get('booked', 0)})"),
             ("Messages taken", r["messages"]), ("Visits confirmed by the customer", r["confirmations"]),
             ("Visits moved / cancelled by the customer", f"{r['reschedules']} / {r['cancellations']}")]
    if r.get("est_value_usd") is not None:
        pairs.insert(3, ("Estimated value of booked jobs", f"{money(r['est_value_usd'])} "
                                                           f"({r['booked']} x {money(r['avg_job_value_usd'])} average job)"))
    back = r.get("worth_calling_back") or []
    lines = [f"{b['when']}: {b['phone']}, {b['job_type']}" for b in back]
    text = "\n".join([subject, f"{business}, {r['period_label']}", ""] + [f"{k.strip()}: {v}" for k, v in pairs] +
                     (["", "Worth calling back (message taken, no booking since):"] + lines if lines else []) +
                     ["", f"Portal: {portal_url()}"])
    body = _rows(pairs)
    if back:
        body += '<p style="margin-top:16px"><b>Worth calling back</b> (message taken, no booking since)</p>' + _rows(
            [(b["when"], f"{b['phone']} · {b['job_type']}") for b in back])
    return subject, text, _wrap(f"{business} · {r['period_label']}", body, "en", _footer_en())


# --- usage alerts ---------------------------------------------------------------------------
KIND_EN = {"voice_minutes": "voice minutes", "sms_segments": "SMS segments"}


def upgrade_url(plan_code: str | None = None) -> str:
    """The portal's usage card (Billing tab) with the one-click upgrade; `plan` preselects the next plan."""
    return f"{portal_url()}?upgrade={plan_code}#billing" if plan_code else f"{portal_url()}#billing"


def usage_owner_plan(business: str, a: dict[str, Any], sms_business: str | None = None) -> tuple[str, str, str, str]:
    """FirstRing plan clients: minutes only, the upgrade link, never a per-minute charge. Names and minutes come from
    the price book (app.plans); nothing is charged automatically."""
    from .. import plans as plans_mod
    pct = 100 if a["kind"] == "usage_100" else 80
    p = plans_mod.plan(a.get("plan_code")) or {}
    nxt = plans_mod.upgrade_target(a.get("plan_code"))
    name = str(p.get("name") or a.get("plan_code") or "")
    used, inc = f"{a['used']:g}", f"{a['included']:g}"
    nxt_min = ((nxt or {}).get("included_usage") or {}).get("voice_minutes")
    up = (f"Upgrade to {nxt['name']} ({nxt_min:,} minutes a month, {money(nxt['monthly_cents'], cents=True)}/month) with one click: "
          f"{upgrade_url(nxt['code'])}" if nxt and nxt_min and nxt.get("monthly_cents") else
          f"Need more minutes? Reply to this e-mail and we'll work it out with you. Your usage: {upgrade_url()}")
    message = plans_mod.usage_cap_mode() == "message"
    mm = ("Your receptionist still answers every call, in message mode: it takes the caller's name, number and reason "
          "and e-mails them to you. It does not book visits or answer other questions.")
    if a.get("trial"):
        subject = f"You've used {pct}% of your free-trial minutes"
        lines = [f"{business} has used {used} of the {inc} minutes included in the free trial."]
        if pct >= 100:
            lines.append(f"{mm} This lasts until your trial ends or you start your paid plan." if message else
                         "Your receptionist keeps answering as usual.")
            lines.append(f"To get full answering back right away, start your plan now: {upgrade_url(a.get('plan_code'))}")
        else:
            lines.append("We'll let you know again if you reach 100%. Nothing is charged during the trial.")
    else:
        subject = f"You've used {pct}% of this month's {name} minutes"
        lines = [f"{business} has used {used} of the {inc} minutes included in your {name} plan this billing period."]
        if pct >= 100 and message:
            until = f" ({str(a['period_end'])[:10]})" if a.get("period_end") else ""
            lines.append(f"{mm} This lasts until your next billing date{until} or until you upgrade.")
        lines.append("We never charge per minute and never add charges without your yes.")
        if nxt or pct >= 100:
            lines.append(up)
        if pct < 100:
            lines.append("We'll let you know again if you reach 100%.")
    text = "\n\n".join([subject, *lines, f"Portal: {portal_url()}"])
    html_ = _wrap(subject, "".join(f"<p>{esc(x)}</p>" for x in lines), "en", _footer_en())
    sms = f"{sms_business or business}: {pct}% of {'trial' if a.get('trial') else 'included'} minutes used ({used}/{inc}). No extra charge. Details by email."
    return subject, text, html_, sms[:SMS_MAX]


def usage_owner(business: str, a: dict[str, Any], sms_business: str | None = None) -> tuple[str, str, str, str]:
    """`sms_business` = the tenant's SMS display name (`sms_business_name`); the e-mail keeps `business`."""
    if a.get("plan_code"):
        return usage_owner_plan(business, a, sms_business)
    pct = 100 if a["kind"] == "usage_100" else 80
    what = KIND_EN.get(a["usage_kind"], a["usage_kind"])
    block = pricebook_item("ADD-USAGE")
    block_txt = (f" An extra usage block is {money(block['monthly_cents'], cents=True)}/month." if block.get("monthly_cents")
                 else "")
    subject = f"You've used {pct}% of this month's included {what}"
    lines = [f"{business} has used {a['used']:g} of {a['included']:g} included {what} this month.",
             "Nothing changes automatically: your receptionist keeps answering and we never add charges "
             "without your approval.",
             (f"If you expect more volume, reply to this e-mail and we can add an extra usage block.{block_txt}"
              if pct >= 100 else "We'll let you know again if you reach 100%.")]
    text = "\n\n".join([subject, *lines, f"Portal: {portal_url()}"])
    html_ = _wrap(subject, "".join(f"<p>{esc(x)}</p>" for x in lines), "en", _footer_en())
    sms = f"{sms_business or business}: {pct}% of included {what} used this month ({a['used']:g}/{a['included']:g}). Nothing changes automatically. Details by email."
    return subject, text, html_, sms[:SMS_MAX]


def usage_admin(business: str, slug: str, a: dict[str, Any]) -> tuple[str, str, str]:
    pct = 100 if a["kind"] == "usage_100" else 80
    what = KIND_EN.get(a["usage_kind"], a["usage_kind"])
    subject = f"Usage {pct}%: {business} · {what}"
    if a.get("plan_code"):
        trial = " (free trial)" if a.get("trial") else ""
        lines = [f"{business} ({slug}) has used {a['used']:g} of {a['included']:g} {what} on plan {a['plan_code']}{trial}.",
                 "No automatic charge and no per-minute charge. The client got an email with an upgrade button."]
        if pct >= 100:
            lines.append("Calls switch to message mode (name, phone, reason, emailed to the business owner) until the trial ends or the plan starts."
                         if a.get("trial") else
                         "Calls switch to message mode until the next billing date or an upgrade. If this keeps happening, offer the client an upgrade.")
    else:
        lines = [f"{business} ({slug}) has used {a['used']:g} of {a['included']:g} {what} this month.",
                 "No automatic charge. If needed, offer the client an ADD-USAGE block, and only with their OK."]
        if pct >= 100:
            lines.append("This month is flagged needs_addon_approval. The agent keeps answering.")
    return subject, "\n".join(lines), _wrap(subject, "".join(f"<p>{esc(x)}</p>" for x in lines), "en")


# --- calendar reconnect -----------------------------------------------------------------------
def calendar_owner(business: str, provider: str) -> tuple[str, str, str, str]:
    name = "Google Calendar" if provider == "google" else provider.title()
    subject = f"Action needed: reconnect your {name}"
    lines = [f"Your AI receptionist lost access to your {name}, so it can't book jobs right now.",
             "Callers are not turned away: it takes a message and you get a lead alert for each one.",
             f"To fix it, open your portal, go to Setup, and click Connect calendar: {portal_url()}"]
    text = "\n\n".join([subject, *lines])
    sms = f"{business}: your {name} got disconnected, so new calls become messages instead of bookings. Reconnect in your portal."
    return subject, text, _wrap(subject, "".join(f"<p>{esc(x)}</p>" for x in lines), "en", _footer_en()), sms[:SMS_MAX]


# --- admin (Meir, English) -----------------------------------------------------------------------
ADMIN_KIND = {"calendar_reconnect": "Calendar disconnected", "admin_budget": "Daily budget used up",
              "tenant_config_invalid": "Client config invalid, line in safe mode",
              "zapier_dead_letter": "Zapier failed", "notify_failed": "Alert failed to send",
              "provisioning_failed": "Automatic setup failed", "number_dry_run": "Number purchase in test mode",
              "golive_check_failed": "Go-live check failed",
              "golive_ai_manual": "Live AI test call didn't run: manual approval needed",
              "number_release_dry_run": "Number release in test mode", "number_released": "Number released",
              "number_release_failed": "Number release failed", "number_release_warn_failed": "Number release warning not sent"}


def admin_alert(kind: str, business: str, slug: str, summary: str) -> tuple[str, str, str]:
    title = ADMIN_KIND.get(kind, kind)
    subject = f"{title}: {business}"
    lines = [f"Client: {business} ({slug})", f"What happened: {summary}"]
    if kind == "calendar_reconnect":
        lines.append("The agent switched to take_message. The client got an email with steps to reconnect.")
    if kind in ("provisioning_failed", "number_dry_run", "golive_check_failed"):
        lines.append("To fix: in the admin, Subscriptions tab, the 'Retry' button next to the step.")
    if kind in ("number_release_dry_run", "number_release_failed"):
        lines.append("To fix: in the admin, Subscriptions tab, 'Number release': 'Postpone' or 'Release now'.")
    # a summary may carry several lines (e.g. a test-call transcript): each line on its own row, every value escaped
    body = "".join(f"<p>{'<br>'.join(esc(y) for y in x.split(chr(10)))}</p>" for x in lines)
    return subject, "\n".join(lines), _wrap(subject, body, "en")


# --- number release after the service ended (owner, English) -----------------------------------------------------
def number_release_warning(business: str, number: str, release_at: Any) -> tuple[str, str, str]:
    """7 days before the receptionist's number is released (plan ended / trial ended unpaid and not restarted)."""
    m = re.match(r"^\+1(\d{3})(\d{3})(\d{4})$", number or "")
    pretty = f"({m.group(1)}) {m.group(2)}-{m.group(3)}" if m else number
    when = f"{release_at:%B} {release_at.day}, {release_at.year}" if hasattr(release_at, "strftime") else str(release_at)[:10]
    subject = f"Your receptionist's number {pretty} will be released on {when}"
    lines = [f"{business}: your plan has ended, so we're keeping your receptionist's number {pretty} for a little longer, "
             f"until {when}. On that date we release it and it stops working.",
             "Please turn off call forwarding on your business phone before then, so your missed calls go back to your "
             "voicemail instead of a number that no longer answers. The “Forward your missed calls” step in your online "
             "account shows how for your phone provider.",
             f"Want to keep this number? Restart your plan before {when} and the same number keeps working: {upgrade_url()}",
             "Want to take the number with you to another provider? Reply to this e-mail before that date and we'll help "
             "you transfer it where the carrier allows (carrier fees apply)."]
    text = "\n\n".join([subject, *lines, f"Portal: {portal_url()}"])
    return subject, text, _wrap(subject, "".join(f"<p>{esc(x)}</p>" for x in lines), "en", _footer_en())


def _pct(v: Any) -> str:
    """Usage percent in the admin table; None = no allowance to compare with (plan SMS, unknown plan): '-'."""
    return "-" if v is None else f"{v}%"


def admin_daily(d: dict[str, Any]) -> tuple[str, str, str]:
    t = d["totals"]
    subject = (f"Daily summary {d['date']}: {t['leads']} leads, {t['booked']} bookings, "
               f"{t['problems']} problems, cost {money(t['cost_usd'])}")
    rows = "".join(
        f"<tr><td>{esc(x['business'])}</td><td>{x['calls']}</td><td>{x['booked']}</td><td>{x['leads']}</td>"
        f'<td><span dir="ltr">{esc(money(x["claude_usd"]))}</span></td>'
        f'<td><span dir="ltr">{esc(money(x["twilio_usd"]))}</span></td>'
        f"<td>{_pct(x['voice_pct'])} / {_pct(x['sms_pct'])}</td><td>{esc(', '.join(x['flags']) or '-')}</td></tr>"
        for x in d["tenants"])
    head = "".join(f'<th style="text-align:left;padding:4px">{h}</th>' for h in
                   ("Client", "Calls", "Bookings", "Leads", "Claude", "Twilio", "Voice/SMS usage", "Flags"))
    table = f'<table style="border-collapse:collapse;width:100%;font-size:13px"><tr>{head}</tr>{rows}</table>'
    notices = "".join(f"<li>{esc(n)}</li>" for n in d.get("notices") or [])
    body = (table + (f"<p>Notices held for daytime hours:</p><ul>{notices}</ul>" if notices else "")
            + "<p style=\"color:#667\">Website leads and quotes come in the notify function's summary (phase A).</p>")
    text = "\n".join([subject] + [
        f"- {x['business']}: calls {x['calls']}, bookings {x['booked']}, leads {x['leads']}, "
        f"Claude {money(x['claude_usd'])}, Twilio {money(x['twilio_usd'])}, flags: {', '.join(x['flags']) or '-'}"
        for x in d["tenants"]] + [f"* {n}" for n in d.get("notices") or []])
    return subject, text, _wrap(subject, body, "en")
