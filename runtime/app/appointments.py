"""Appointment manager (2026-10-23): the caller's own bookings, returning-caller context, text replies C/R/X.

Off by default, per tenant (`booking.self_service`, `booking.recognize_callers`); the text replies also need the
global `SMS_BOOKING_REPLIES=1` (texting is not live before A2P 10DLC approval).

Rules enforced here, in code (the prompt only explains them):
- a caller can see, move or cancel only bookings WE made (rows in `bookings` with a provider event) for the number
  they call from; a booking under another number needs that number AND the name on the booking, and the owner is
  told that the change came from another number;
- the model never sees row ids, addresses or phone numbers: bookings are offered as refs B1/B2 with label, job type
  and ZIP (enough for `get_availability`); the ref -> row map stays in the conversation state;
- the returning-caller fact uses only `bookings` / `calls` rows of the last 90 days (the transcript retention) and
  never a transcript: first name, the next visit and the last job type. Nothing for a blocked or opted-out number;
- CANCEL as a whole text stays an opt-out (CTIA / Twilio keyword); cancelling by text is X only. STOP wins always.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from . import guard
from .calendar.base import label as slot_label
from .store import StoreError, TenantStore
from .tenants import TenantConfig

RETENTION = timedelta(days=90)
MAX_FOUND = 2

CONFIRM_WORDS = {"C", "CONFIRM", "CONFIRMED", "Y", "YES", "YEP", "YEAH", "OK", "OKAY"}
CHANGE_WORDS = {"R", "RESCHEDULE", "CHANGE", "MOVE"}
CANCEL_WORDS = {"X"}  # "CANCEL" is a carrier opt-out keyword: guard.sms_keyword turns it into STOP first


def _dt(v: Any) -> datetime | None:
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def e164(raw: Any) -> str | None:
    """US number as E.164 (+1XXXXXXXXXX) from what a caller said or typed; None if it is not one."""
    s = str(raw or "").strip()
    if re.fullmatch(r"\+[1-9]\d{7,14}", s):
        return s
    digits = re.sub(r"\D", "", s)
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return None


def row_label(row: dict[str, Any], cfg: TenantConfig) -> str:
    tz = ZoneInfo(cfg.business.timezone)
    s, e = _dt(row.get("start_at")), _dt(row.get("end_at"))
    if not s:
        return "your visit"
    return slot_label(s.astimezone(tz), (e or s).astimezone(tz))


def upcoming(ts: TenantStore, contact: str, now: datetime, limit: int = MAX_FOUND) -> list[dict[str, Any]]:
    """The caller's next bookings that we made and that still stand (soonest first)."""
    if not contact:
        return []
    rows = [r for r in ts.select("bookings", contact_e164=contact)
            if r.get("status") == "confirmed" and r.get("provider_event_id") and (_dt(r.get("start_at")) or now) > now]
    return sorted(rows, key=lambda r: str(r.get("start_at")))[:limit]


def _first_name(name: Any) -> str:
    parts = str(name or "").strip().split()
    return parts[0][:40] if parts and parts[0].lower() not in ("customer", "earlier") else ""


def names_match(on_booking: Any, given: Any) -> bool:
    a = re.sub(r"[^a-z ]", "", str(on_booking or "").lower()).split()
    b = re.sub(r"[^a-z ]", "", str(given or "").lower()).split()
    return bool(a and b) and (a == b or a[0] == b[0] or (len(a) > 1 and a[-1] == b[-1] and len(b) > 1))


def known_caller(ts: TenantStore, cfg: TenantConfig, contact: str, now: datetime,
                 current_call_sid: str | None = None) -> dict[str, Any] | None:
    """What we may say about a returning caller, from the last 90 days only; None if nothing (or not allowed)."""
    if not contact or guard.is_blocked(contact, cfg) or ts.is_opted_out(contact):
        return None
    since = now - RETENTION
    books = [b for b in ts.select("bookings", contact_e164=contact)
             if (_dt(b.get("created_at")) or now) >= since or (_dt(b.get("start_at")) or since) >= now]
    calls = [c for c in ts.select("calls", from_e164=contact)
             if c.get("call_sid") != current_call_sid and (_dt(c.get("started_at")) or since) >= since]
    if not books and not calls:
        return None
    latest = sorted(books, key=lambda b: str(b.get("created_at") or ""))[-1] if books else {}
    nxt = upcoming(ts, contact, now, 1)
    return {"name": _first_name(latest.get("customer_name")), "job_type": latest.get("job_type") or "",
            "next": row_label(nxt[0], cfg) if nxt else "", "next_job": (nxt[0].get("job_type") or "") if nxt else "",
            "calls": len(calls), "bookings": len(books)}


def caller_fact(info: dict[str, Any] | None) -> str:
    """One context line for the model (no address, phone or transcript)."""
    if not info or not (info.get("name") or info.get("next")):
        return ""
    bits = []
    if info.get("name"):
        bits.append(f"first name {info['name']}")
    if info.get("next"):
        bits.append(f"next visit {info['next']}" + (f" ({info['next_job']})" if info.get("next_job") else ""))
    elif info.get("job_type"):
        bits.append(f"last job type {info['job_type']}")
    return (" Returning caller (our records of the last 90 days): " + "; ".join(bits) + ". You may greet them by first "
            "name and, if there is a next visit, ask whether they are calling about it. Do not mention any other detail;"
            " if they say they are someone else, ignore this.")


def parse_reply(text: str) -> str | None:
    """'confirm' | 'change' | 'cancel' | None for a reply to a confirmation / reminder text (whole message only)."""
    word = re.sub(r"[^A-Za-z]", "", (text or "").strip()).upper()
    if word in CONFIRM_WORDS:
        return "confirm"
    if word in CHANGE_WORDS:
        return "change"
    if word in CANCEL_WORDS:
        return "cancel"
    return None


def update_row(ts: TenantStore, row_id: str, patch: dict[str, Any]) -> bool:
    try:
        ts.update("bookings", row_id, patch)
        return True
    except StoreError:
        return False


def booking_row(ts: TenantStore, row_id: str) -> dict[str, Any] | None:
    rows = ts.select("bookings", id=row_id) if row_id else []
    return rows[0] if rows else None


def without_own(slots: list[dict[str, Any]], ts: TenantStore, refs: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Slots minus the windows of the bookings being changed (found by find_my_booking in this conversation)."""
    taken = set()
    for ref in refs.values():
        row = booking_row(ts, ref.get("row", ""))
        if row and _dt(row.get("start_at")):
            taken.add(_dt(row["start_at"]))
    return [s for s in slots if _dt(s.get("start")) not in taken]
