"""Notification texts. Owner (client) messages: US English. Admin (Meir) messages: Hebrew, RTL.

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


def lead_alert(business: str, kind: str, lead: dict[str, Any]) -> tuple[str, str, str, str]:
    """(subject, text, html, sms) for the owner."""
    job = lead.get("job_type") or "General inquiry"
    name = lead.get("name") or "Unknown caller"
    city = city_of(lead.get("address") or "")
    subject = f"{PREFIX.get(kind, '')}New lead: {job} · {name} · {city}"
    pairs = [("Name", name), ("Phone", lead.get("phone") or "-"), ("Job", job),
             ("Urgency", lead.get("urgency") or "normal"), ("Address", lead.get("address") or "-"),
             ("Channel", "Phone call" if lead.get("channel") == "voice" else "Text message"),
             ("Summary", lead.get("summary") or "-")]
    if lead.get("booking_label"):
        pairs.insert(3, ("Booked", lead["booking_label"]))
    text = "\n".join([subject, ""] + [f"{k}: {v}" for k, v in pairs] + ["", f"Portal: {portal_url()}"])
    intro = {"urgent": "An urgent request just came in. Please call the customer back now.",
             "human_needed": "The customer asked for a person. Please call back.",
             "booking": "The AI receptionist booked a job on your calendar."}.get(
        kind, "The AI receptionist took a new lead for you.")
    body = f"<p>{esc(intro)}</p>{_rows(pairs)}"
    if lead.get("transcript"):
        lines = "".join(f"<div><b>{esc(t.get('who', ''))}:</b> {esc(t.get('text', ''))}</div>"
                        for t in lead["transcript"][-12:])
        body += f'<p style="margin-top:16px;color:#667">Transcript (last lines)</p>{lines}'
    html_ = _wrap(f"{business}: {subject}", body, "en", _footer_en())
    head = {"urgent": "URGENT lead", "human_needed": "Call back requested", "booking": "New booking"}.get(kind, "New lead")
    sms = f"{head}: {name}, {lead.get('phone') or '-'}, {job}"
    if lead.get("booking_label"):
        sms += f", {lead['booking_label']}"
    if lead.get("summary"):
        sms += f". {lead['summary']}"
    sms = sms[: SMS_MAX - 24].rstrip() + " Details: check your email."
    return subject, text, html_, sms


# --- daily summary (owner) ----------------------------------------------------------------
def daily_summary(business: str, d: dict[str, Any]) -> tuple[str, str, str]:
    subject = f"Today: {d['calls_answered']} calls answered, {d['booked']} booked"
    pairs = [("Calls answered", d["calls_answered"]), ("Jobs booked", d["booked"]),
             ("Messages taken", d["messages"]), ("Urgent", d["urgent"]),
             ("Text conversations", d["sms_threads"]), ("Missed callers texted back", d["text_backs"])]
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
def monthly_roi(business: str, r: dict[str, Any]) -> tuple[str, str, str]:
    subject = f"Your {r['month_label']} report: {r['calls_answered']} calls answered, {r['booked']} booked"
    pairs = [("Calls answered by the AI receptionist", r["calls_answered"]),
             ("  of them after hours", r["after_hours_calls"]),
             ("Jobs booked", r["booked"]), ("Messages taken for call-back", r["messages"]),
             ("Urgent requests flagged", r["urgent"]), ("Missed callers texted back", r["text_backs"]),
             ("Voice minutes used", f"{r['usage']['voice_minutes']:g} of {r['included']['voice_minutes']:g}"),
             ("SMS segments used", f"{r['usage']['sms_segments']:g} of {r['included']['sms_segments']:g}")]
    if r.get("est_value_usd") is not None:
        pairs.insert(3, ("Estimated value of booked jobs", f"{money(r['est_value_usd'])} "
                                                           f"({r['booked']} x {money(r['avg_job_value_usd'])} average job)"))
    if r.get("roi_multiple") is not None:
        pairs.insert(4, ("Value vs. your monthly fee", f"{r['roi_multiple']:.1f}x"))
    note = ("Estimated value uses the average job value you set; it is an estimate, not revenue."
            if r.get("est_value_usd") is not None else
            "Tip: set your average job value in the portal to see the estimated value of booked jobs.")
    text = "\n".join([subject, business, ""] + [f"{k.strip()}: {v}" for k, v in pairs] + ["", note, f"Portal: {portal_url()}"])
    body = _rows(pairs) + f'<p style="margin-top:14px;color:#667">{esc(note)}</p>'
    return subject, text, _wrap(f"{business} · {r['month_label']}", body, "en", _footer_en())


# --- usage alerts ---------------------------------------------------------------------------
KIND_EN = {"voice_minutes": "voice minutes", "sms_segments": "SMS segments"}
KIND_HE = {"voice_minutes": "דקות שיחה", "sms_segments": "מקטעי SMS"}


def usage_owner(business: str, a: dict[str, Any], sms_business: str | None = None) -> tuple[str, str, str, str]:
    """`sms_business` = the tenant's SMS display name (`sms_business_name`); the e-mail keeps `business`."""
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
    what = KIND_HE.get(a["usage_kind"], a["usage_kind"])
    subject = f"שימוש {pct}%: {business} · {what}"
    lines = [f"ללקוח {business} ({slug}) נוצלו {a['used']:g} מתוך {a['included']:g} {what} החודש.",
             "אין חיוב אוטומטי. אם צריך, מציעים ללקוח בלוק ADD-USAGE, ורק באישורו."]
    if pct >= 100:
        lines.append("החודש מסומן needs_addon_approval. הסוכן ממשיך לענות.")
    return subject, "\n".join(lines), _wrap(subject, "".join(f"<p>{esc(x)}</p>" for x in lines), "he")


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


# --- admin (Hebrew) ------------------------------------------------------------------------------
ADMIN_KIND_HE = {"calendar_reconnect": "היומן התנתק", "admin_budget": "תקציב יומי נוצל",
                 "tenant_config_invalid": "קונפיג לקוח לא תקין, הקו במצב חירום",
                 "zapier_dead_letter": "Zapier נכשל", "notify_failed": "שליחת התראה נכשלה"}


def admin_alert(kind: str, business: str, slug: str, summary: str) -> tuple[str, str, str]:
    title = ADMIN_KIND_HE.get(kind, kind)
    subject = f"{title}: {business}"
    lines = [f"לקוח: {business} ({slug})", f"מה קרה: {summary}"]
    if kind == "calendar_reconnect":
        lines.append("הסוכן עבר ל-take_message. הלקוח קיבל מייל עם הוראה לחבר מחדש.")
    return subject, "\n".join(lines), _wrap(subject, "".join(f"<p>{esc(x)}</p>" for x in lines), "he")


def admin_daily(d: dict[str, Any]) -> tuple[str, str, str]:
    t = d["totals"]
    subject = (f"סיכום יומי {d['date']}: {t['leads']} לידים, {t['booked']} הזמנות, "
               f"{t['problems']} תקלות, עלות {money(t['cost_usd'])}")
    rows = "".join(
        f"<tr><td>{esc(x['business'])}</td><td>{x['calls']}</td><td>{x['booked']}</td><td>{x['leads']}</td>"
        f'<td><span dir="ltr">{esc(money(x["claude_usd"]))}</span></td>'
        f'<td><span dir="ltr">{esc(money(x["twilio_usd"]))}</span></td>'
        f"<td>{x['voice_pct']}% / {x['sms_pct']}%</td><td>{esc(', '.join(x['flags']) or '-')}</td></tr>"
        for x in d["tenants"])
    head = "".join(f'<th style="text-align:right;padding:4px">{h}</th>' for h in
                   ("לקוח", "שיחות", "הזמנות", "לידים", "Claude", "Twilio", "שימוש קול/SMS", "דגלים"))
    table = f'<table style="border-collapse:collapse;width:100%;font-size:13px"><tr>{head}</tr>{rows}</table>'
    notices = "".join(f"<li>{esc(n)}</li>" for n in d.get("notices") or [])
    body = (table + (f"<p>הודעות שנדחו לשעות היום:</p><ul>{notices}</ul>" if notices else "")
            + "<p style=\"color:#667\">לידים והצעות מהאתר מגיעים בסיכום של פונקציית notify (שלב A).</p>")
    text = "\n".join([subject] + [
        f"- {x['business']}: שיחות {x['calls']}, הזמנות {x['booked']}, לידים {x['leads']}, "
        f"Claude {money(x['claude_usd'])}, Twilio {money(x['twilio_usd'])}, דגלים: {', '.join(x['flags']) or '-'}"
        for x in d["tenants"]] + [f"* {n}" for n in d.get("notices") or []])
    return subject, text, _wrap(subject, body, "he")
