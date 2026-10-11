"""Fixes from the B1/B2 review: outbound rate cap, reply checks, tenant isolation, emergencies,
usage metering, persisted state, niche list."""
from __future__ import annotations

import json
import typing
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest

from app import guard, settings as settings_mod
from app.conversation import Engine
from app.llm import LLMClient
from app.store import JsonStore, StateStore, StoreError, SupabaseStore
from app.tenants import Business, load_record
from app.usage import UsageMeter, included_usage
from sim import harness
from sim.fake_calendar import FakeCalendar

MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("America/Chicago"))


def _engine(tmp_path, demo_raw, store=None, **cfg_patch):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"].update(cfg_patch)
    settings = harness.sim_settings(tmp_path)
    store = store or JsonStore(tmp_path)
    tenant = store.upsert_tenant(load_record(raw))
    return Engine(store, LLMClient(settings, mode="mock"), FakeCalendar(), settings), tenant


# --- 1. every outbound reply counts against the per-number cap (STOP excepted) -------------------

FLOODS = {
    "mms": ("photo", 1), "empty": ("", 0), "long": ("x" * 700, 0), "robot": ("are you a robot?", 0),
    "help": ("HELP", 0), "spanish": ("Hola, necesito ayuda", 0), "start": ("START", 0), "text": ("hello there", 0),
}


@pytest.mark.parametrize("kind", list(FLOODS))
def test_flood_of_50_messages_gets_at_most_cap_plus_one_reply(tmp_path, demo_raw, kind):
    eng, t = _engine(tmp_path, demo_raw)
    body, media = FLOODS[kind]
    replies = 0
    for i in range(50):
        r = eng.handle(t, "sms", harness.CALLER, body, "flood", MON_9 + timedelta(seconds=i), num_media=media)
        replies += bool(r.reply)
    cap = t.config.guard.max_replies_10min
    assert replies <= cap + 1, f"{kind}: {replies} replies"
    assert eng.llm.calls <= cap * 4


def test_stop_flood_confirms_once(tmp_path, demo_raw):
    eng, t = _engine(tmp_path, demo_raw)
    replies = [eng.handle(t, "sms", harness.CALLER, "STOP", "s", MON_9 + timedelta(seconds=i)).reply for i in range(50)]
    assert sum(bool(r) for r in replies) == 1 and "unsubscribed" in replies[0]


def test_stop_is_never_rate_limited(tmp_path, demo_raw):
    eng, t = _engine(tmp_path, demo_raw)
    for i in range(20):
        eng.handle(t, "sms", harness.CALLER, "hi", "s", MON_9 + timedelta(seconds=i))
    r = eng.handle(t, "sms", harness.CALLER, "STOP", "s", MON_9 + timedelta(seconds=30))
    assert "unsubscribed" in r.reply


def test_start_opts_in_even_when_limited(tmp_path, demo_raw):
    eng, t = _engine(tmp_path, demo_raw)
    ts = eng.store.for_tenant(t.id)
    ts.opt_out(harness.CALLER)
    st = guard.LimitState(muted_until=MON_9 + timedelta(hours=5))
    eng.save_limit_state(t, harness.CALLER, st)
    r = eng.handle(t, "sms", harness.CALLER, "START", "s", MON_9)
    assert r.reply == "" and not ts.is_opted_out(harness.CALLER)


# --- 2. reply checks ------------------------------------------------------------------------------

@pytest.mark.parametrize("text,violation", [
    ("Sure, it's free of charge, no discount needed", "discount"),
    ("For you, half price on the visit.", "discount"),
    ("We can do it at no charge.", "discount"),
    ("You're all set! A technician will be at your place tomorrow at 9am.", "unbooked_commitment"),
    ("Your appointment is confirmed for Tuesday.", "unbooked_commitment"),
    ("Our tech will arrive by noon.", "unbooked_commitment"),
    ("We can be there within the hour.", "unbooked_commitment"),
    ("A technician will be there by 3.", "unbooked_commitment"),
    ("Good news, a tech is on the way!", "unbooked_commitment"),
    ("Someone can come by in 30 minutes.", "unbooked_commitment"),
    ("A tech will be out in 30 minutes.", "unbooked_commitment"),
    ("We'll have a tech there today by 3.", "unbooked_commitment"),
    ("Expect us tomorrow by noon.", "unbooked_commitment"),
    ("Our crew can start in 2 hours.", "unbooked_commitment"),
    ("I cancelled all of tomorrow's appointments.", "unbacked_action"),
    ("Your booking has been rescheduled to Friday.", "unbacked_action"),
])
def test_check_reply_blocks(demo_raw, text, violation):
    cfg = load_record(demo_raw).config
    assert violation in guard.check_reply(text, cfg, "sms").violations


def test_check_reply_allows_confirmation_after_real_booking(demo_raw):
    cfg = load_record(demo_raw).config
    r = guard.check_reply("You're all set for Monday Oct 12, 12 PM to 4 PM.", cfg, "sms", booked=True)
    assert r.violations == []
    assert guard.check_reply("I can't offer a discount, sorry.", cfg, "sms").violations == []


# --- 3. tenant isolation in the store -------------------------------------------------------------

@pytest.fixture(params=["json", "supabase"])
def any_store(request, tmp_path, postgrest):
    if request.param == "json":
        return JsonStore(tmp_path)
    return SupabaseStore("https://x.supabase.co", "k", transport=httpx.MockTransport(postgrest.handler))


def test_tenant_a_cannot_touch_tenant_b(any_store):
    a, b = any_store.for_tenant("tenant-a"), any_store.for_tenant("tenant-b")
    row_b = b.insert("bookings", {"customer_name": "Bea", "contact_e164": "+15550000002"})
    a.insert("bookings", {"customer_name": "Al", "contact_e164": "+15550000001"})
    assert [r["customer_name"] for r in a.select("bookings")] == ["Al"]
    assert a.select("bookings", id=row_b["id"]) == []
    with pytest.raises(StoreError, match="cross-tenant"):
        a.select("bookings", tenant_id="tenant-b")
    with pytest.raises(StoreError, match="cross-tenant"):
        a.insert("bookings", {"tenant_id": "tenant-b", "customer_name": "X"})
    with pytest.raises(StoreError, match="cross-tenant"):
        a.update("bookings", row_b["id"], {"tenant_id": "tenant-c"})
    assert a.update("bookings", row_b["id"], {"tenant_id": "tenant-a"}) is None   # can't adopt B's row
    assert a.update("bookings", row_b["id"], {"customer_name": "hacked"}) is None
    assert b.select("bookings")[0]["customer_name"] == "Bea"
    assert a.delete("bookings", contact_e164="+15550000002") == 0
    assert len(b.select("bookings")) == 1
    with pytest.raises(StoreError, match="without a filter"):
        a.delete("bookings")
    with pytest.raises(StoreError, match="without a filter"):
        any_store.delete("bookings")
    with pytest.raises(StoreError, match="not created"):
        a.insert("tenants", {"slug": "x"})
    # events are scoped by entity_id, credentials by tenant id
    a.log_event("x.test", {"n": 1})
    b.log_event("x.test", {"n": 2})
    assert [e["payload"]["n"] for e in a.select("events", type="x.test")] == [1]
    a.put_credential("google", "v1.a")
    assert b.get_credential("google") is None and a.get_credential("google") == "v1.a"
    # opt-outs are per tenant
    a.opt_out("+15550000009")
    assert a.is_opted_out("+15550000009") and not b.is_opted_out("+15550000009")
    with pytest.raises(StoreError):
        any_store.for_tenant("")


def test_engine_writes_only_through_tenant_scope(tmp_path, demo_raw):
    eng, t = _engine(tmp_path, demo_raw)
    for text in ("my ac is broken, 77005", "the first one", "I'm Dana Miller", "2100 Rice Blvd Houston 77005"):
        eng.handle(t, "sms", harness.CALLER, text, "c1", MON_9)
    rows = eng.store.select("bookings")
    assert len(rows) == 1 and rows[0]["tenant_id"] == t.id
    assert all(e["entity_id"] == t.id for e in eng.store.select("events"))


# --- 5. usage metering + persisted state ---------------------------------------------------------

def test_included_usage_comes_from_pricebook():
    assert included_usage() == {"voice_minutes": 400.0, "sms_segments": 1000.0}


def test_usage_alerts_at_80_and_100_without_blocking(tmp_path, demo_raw):
    eng, t = _engine(tmp_path, demo_raw)
    meter = eng.usage
    assert meter.record(t, "voice", 0, MON_9) == []
    assert meter.record(t, "voice", 300, MON_9) == []
    a80 = meter.record(t, "voice", 30, MON_9)
    assert [a["kind"] for a in a80] == ["usage_80"]
    assert meter.record(t, "voice", 10, MON_9) == []
    a100 = meter.record(t, "voice", 100, MON_9)
    assert [a["kind"] for a in a100] == ["usage_100"] and meter.needs_addon_approval(t, MON_9)
    assert meter.used(t, "voice", MON_9) == 440
    # next month starts clean
    assert meter.used(t, "voice", MON_9 + timedelta(days=31)) == 0
    assert not meter.needs_addon_approval(t, MON_9 + timedelta(days=31))


def test_sms_usage_counted_and_service_continues_past_100(tmp_path, demo_raw):
    eng, t = _engine(tmp_path, demo_raw)
    eng.state.put(eng.usage.key(t, "sms", MON_9), 999.0, t.id)
    r = eng.handle(t, "sms", harness.CALLER, "hello", "c1", MON_9)
    kinds = [a.get("kind") for a in r.actions]
    assert "usage_100" in kinds and r.reply  # alert, but still answering
    assert eng.usage.used(t, "sms", MON_9) >= 1001
    assert eng.store.select("events", type="usage_threshold")


def test_state_survives_restart(tmp_path, demo_raw):
    eng, t = _engine(tmp_path, demo_raw)
    for i in range(10):
        eng.handle(t, "sms", harness.CALLER, "hi", "c", MON_9 + timedelta(seconds=i))
    spent = eng.tenant_spend(t, "2026-10-12")
    again = Engine(eng.store, LLMClient(eng.settings, mode="mock"), FakeCalendar(), eng.settings)
    assert again.tenant_spend(t, "2026-10-12") == pytest.approx(spent) and spent > 0
    r = again.handle(t, "sms", harness.CALLER, "hi", "c", MON_9 + timedelta(seconds=20))
    assert r.reply == "" and any(g.startswith("rate:") for g in r.guard)


class _BrokenState(JsonStore):
    def select(self, table, **eq):
        if table == "runtime_state":
            raise StoreError("runtime_state missing")
        return super().select(table, **eq)


def test_state_store_memory_fallback_only_in_sim(tmp_path):
    sim_state = StateStore(_BrokenState(tmp_path), memory_fallback=True)
    sim_state.put("k", 1)
    assert sim_state.get("k") == 1 and sim_state.degraded
    assert sim_state.incr("k", 2) == 3
    fresh = StateStore(_BrokenState(tmp_path), memory_fallback=True)
    assert fresh.get("k", "d") == "d" and fresh.degraded
    prod_state = StateStore(_BrokenState(tmp_path), memory_fallback=False)
    with pytest.raises(StoreError):
        prod_state.get("k")
    with pytest.raises(StoreError):
        prod_state.put("k", 1)


def test_state_store_on_supabase(postgrest):
    st = StateStore(SupabaseStore("https://x.supabase.co", "k", transport=httpx.MockTransport(postgrest.handler)))
    st.put("a", {"x": 1}, "t1")
    st.put("a", {"x": 2}, "t1")
    assert st.get("a") == {"x": 2} and len(postgrest.tables["runtime_state"]) == 1


# --- 4. emergencies ------------------------------------------------------------------------------

def test_life_safety_reply_and_confirmation():
    assert guard.life_safety_reply("I smell gas").startswith(guard.LIFE_SAFETY_TEXT)
    assert "llame al 911" in guard.life_safety_reply("huele a gas")
    assert "llame" not in guard.life_safety_reply("I smell gas")
    assert guard.confirms_danger("yes") and guard.confirms_danger("it's getting worse")
    assert not guard.confirms_danger("no, everyone is fine")


@pytest.mark.parametrize("text,level", [
    ("FIRE FIRE just kidding", None), ("I'm on fire today, need a tune-up", None),
    ("there is a fire in the basement, I am not kidding", "life_safety"),
    ("there's a fire in the garage, no joke", "life_safety"), ("my house is on fire, not joking", "life_safety"),
    ("there's a fire in the kitchen jk... seriously it's real", "life_safety"),
    ("smoke coming from the furnace, this isn't a prank", "life_safety"),
    ("I smell gas lol jk", None), ("there's a fire in the attic, just kidding", None),
    ("carbon monoxide detector chirping, battery maybe", "life_safety"),
    ("smoke in the house", "life_safety"), ("the house is full of smoke", "life_safety"),
    ("there is smoke upstairs", "life_safety"), ("not kidding, my kid says there is smoke upstairs", "life_safety"),
    ("smoke detector going off and no reason", "life_safety"),
    ("my smoke detector keeps beeping, I think it's the battery", None),
    ("can you do a smoke test on my ducts?", None), ("the battery in the alarm is low and it chirps", None),
    ("smoke detector chirping, needs a battery", None), ("my house is on fire", "life_safety"),
    ("there's smoke coming from the vents", "life_safety"), ("fuga de gas", "life_safety"),
    ("hay fuego en la cocina", "life_safety"), ("inundación en el sótano", "urgent")])
def test_emergency_precision(demo_raw, text, level):
    assert guard.detect_emergency(text, load_record(demo_raw).config) == level


# --- 6. small ----------------------------------------------------------------------------------

def test_sms_segments():
    assert guard.sms_segments("") == 0
    assert guard.sms_segments("x" * 160) == 1
    assert guard.sms_segments("x" * 161) == 2
    assert guard.sms_segments("é" * 70) == 1 and guard.sms_segments("é" * 71) == 2


def test_niches_match_brand_json():
    literal = typing.get_args(Business.model_fields["niche"].annotation)
    assert sorted(literal) == sorted(n["key"] for n in settings_mod.brand()["niches"])


def test_httpx_loggers_quiet():
    import logging
    assert all(logging.getLogger(n).level >= logging.WARNING for n in ("httpx", "httpx2"))
