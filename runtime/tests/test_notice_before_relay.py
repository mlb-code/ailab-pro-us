"""Legal decisions 2026-11-27, items 1-3: nothing the caller says is transcribed or sent to the AI before the call notice
ends, every call row records the notice heard and when it ended, and a Spanish line plays the Spanish notice before any
answer.

Stream mode plays the notice with TwiML <Say> BEFORE <Connect><ConversationRelay>: Twilio runs the verbs in order, so
the relay (and Deepgram speech-to-text) starts only once the <Say> has finished. The relay's welcomeGreeting is only the
closing question. The discard of a prompt said over that question stays as a second line of defense (test_legal_v11).
"""
from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app import guard
from app.message_mode import OPTIONAL_CALL_COLUMNS, insert_call, notice_completed
from app.store import StoreError
from app.tenants import load_record
from app.voice import ASK, greeting, notice_then_ask
from sim import harness
from sim.fake_twilio import parse_twiml

TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
DISCLOSURE = guard.DISCLOSURE_SMS  # the simulator runs with SMS_ENABLED on


def build(tmp_path, mode="stream", **env):
    clock = harness.FakeClock(MON_9)
    return harness.build(tmp_path, clock=clock, VOICE_MODE=mode, **env), clock


def incoming(sim, slug="demo-hvac", call_sid="CA" + "7" * 32, caller=harness.CALLER):
    _, r = sim.twilio.start_call(sim.tenant(slug).twilio_number, caller, call_sid)
    assert r.status_code == 200
    return ET.fromstring(r.text)


def call_row(sim, call_sid):
    return sim.store.select("calls", call_sid=call_sid)[0]


# --- 1. the notice is a <Say> before the relay starts ------------------------------------------------------------------
def test_stream_twiml_plays_the_whole_notice_before_the_relay_and_the_relay_only_asks(tmp_path):
    sim, _ = build(tmp_path)
    root = incoming(sim)
    assert [el.tag for el in root] == ["Say", "Connect"]          # Twilio runs <Say> to the end, then opens the relay
    say, relay = root.find("Say"), root.find("Connect/ConversationRelay")
    assert say.text == f"Thanks for calling Cool Breeze HVAC. {DISCLOSURE}" and say.get("voice") == "Polly.Joanna-Neural"
    assert relay.get("welcomeGreeting") == "How can I help?" == ASK
    assert relay.get("welcomeGreetingInterruptible") == "none" and relay.get("interruptible") == "speech"
    # nothing of the notice is left for the relay to say (the relay is where speech-to-text runs)
    welcome = relay.get("welcomeGreeting")
    assert not any(p in welcome.lower() for p in ("recorded", "transcribed", "service provider", "ai assistant"))
    # the words the caller hears are the greeting, unchanged; the stored greeting (proof of the notice) too
    assert parse_twiml(ET.tostring(root, encoding="unicode")).text == greeting(sim.tenant("demo-hvac"), sms=True)
    convo = sim.rt.engine.find_convo(sim.tenant("demo-hvac"), "voice", "CA" + "7" * 32)
    assert convo.transcript[0] == {"who": "assistant", "text": greeting(sim.tenant("demo-hvac"), sms=True)}


def test_real_estate_keeps_its_own_closing_question(tmp_path):
    sim, _ = build(tmp_path)
    root = incoming(sim, "demo-realty")
    say, relay = root.find("Say").text, root.find("Connect/ConversationRelay").get("welcomeGreeting")
    assert relay == "What are you calling about?" and "Jenna Harper's assistant" in say and DISCLOSURE in say
    assert f"{say} {relay}" == greeting(sim.tenant("demo-realty"), sms=True)


@pytest.mark.parametrize("custom", ["Hello from Cool Breeze.", "Hi, thanks for calling Cool Breeze, how can we help?"])
def test_custom_greeting_is_played_whole_and_the_relay_asks_how_can_i_help(tmp_path, demo_raw, custom):
    demo_raw["config"]["voice"]["greeting"] = custom
    sim, _ = build(tmp_path)
    sim.store.upsert_tenant(demo_raw)
    root = incoming(sim)
    assert root.find("Say").text == f"{custom} {DISCLOSURE}"   # the notice is appended, and all of it is in the <Say>
    assert root.find("Connect/ConversationRelay").get("welcomeGreeting") == ASK


def test_a_greeting_whose_last_question_holds_the_notice_is_never_split(demo_raw):
    demo_raw["config"]["voice"]["greeting"] = (f"Thanks for calling Cool Breeze. You're speaking with an AI assistant. "
                                               "This call may be recorded and transcribed by us and our service "
                                               "providers, and we may text you about it, ok?")
    en, es, ask = notice_then_ask(load_record(demo_raw), sms=True)
    assert ask == ASK and en == greeting(load_record(demo_raw), sms=True) and es == ""


def test_elevenlabs_voice_plays_the_notice_in_the_default_polly_voice(tmp_path, demo_raw):
    demo_raw["config"]["voice"]["tts_voice"] = "UgBBYS2sOqTuMpoF3BR0"
    sim, _ = build(tmp_path)
    sim.store.upsert_tenant(demo_raw)
    root = incoming(sim)
    assert root.find("Say").get("voice") == "Polly.Joanna-Neural"          # <Say> has no ElevenLabs voices
    relay = root.find("Connect/ConversationRelay")
    assert relay.get("ttsProvider") == "ElevenLabs" and relay.get("voice") == "UgBBYS2sOqTuMpoF3BR0"


# --- 3. Spanish line: the Spanish notice, in the Spanish voice, before the relay and any answer ---------------------------
def test_spanish_line_plays_the_spanish_notice_in_the_spanish_voice_before_the_relay(tmp_path, demo_raw):
    demo_raw["config"]["voice"]["languages"] = ["en", "es"]
    sim, _ = build(tmp_path)
    sim.store.upsert_tenant(demo_raw)
    root = incoming(sim)
    assert [el.tag for el in root] == ["Say", "Say", "Connect"]
    en, es = root.findall("Say")
    assert DISCLOSURE in en.text and en.get("language") is None and en.get("voice") == "Polly.Joanna-Neural"
    assert guard.DISCLOSURE_ES_SMS in es.text and guard.SPANISH_INVITE in es.text
    assert es.get("language") == guard.SPANISH_LANG and es.get("voice") == "Polly.Lupe-Neural"
    relay = root.find("Connect/ConversationRelay")
    assert relay.get("welcomeGreeting") == ASK and [l.get("code") for l in relay.findall("Language")] == ["es-US"]


def test_spanish_caller_hears_the_spanish_notice_once_before_the_first_spanish_answer(tmp_path, demo_raw):
    demo_raw["config"]["voice"]["languages"] = ["en", "es"]
    sim, _ = build(tmp_path)
    sim.store.upsert_tenant(demo_raw)
    call = sim.call()
    first = call.start()
    assert guard.DISCLOSURE_ES_SMS in first.text and first.text.endswith(ASK)
    reply = call.say("Hola, mi calefacción no funciona, estoy en 77019")
    assert reply.lang == "es-US" and reply.text and guard.DISCLOSURE_ES_SMS not in reply.text   # once per call
    call.hangup()
    row = call_row(sim, call.call_sid)
    assert row["notice_lang"] == "en+es" and row["notice_completed_at"]
    spoken = " ".join(t["text"] for t in row["transcript"] if t["who"] == "assistant")
    assert spoken.count(guard.DISCLOSURE_ES_SMS) == 1


# --- 2. the notice record on every call row ------------------------------------------------------------------------------
def test_stream_call_records_the_notice_and_when_it_ended(tmp_path):
    sim, clock = build(tmp_path)
    call = sim.call()
    call.start()
    deadline = time.monotonic() + 3
    while not call_row(sim, call.call_sid).get("notice_completed_at") and time.monotonic() < deadline:
        time.sleep(0.01)                                           # stamped when the relay session's setup arrives
    row = call_row(sim, call.call_sid)
    assert (row["notice_version"], row["notice_lang"]) == (guard.DISCLOSURE_VERSION, "en")
    assert row["notice_completed_at"] == MON_9.isoformat()
    clock.advance(seconds=30)
    call.say("My furnace stopped working, I'm in 77019")
    call.hangup()
    assert call_row(sim, call.call_sid)["notice_completed_at"] == MON_9.isoformat()   # set once, never moved


def test_hang_up_during_the_notice_leaves_notice_completed_empty(tmp_path):
    sim, _ = build(tmp_path)
    incoming(sim)                                                 # Twilio is still playing the <Say>: no relay yet
    sim.twilio.status(sim.tenant("demo-hvac").twilio_number, harness.CALLER, "CA" + "7" * 32, "completed", 4)
    row = call_row(sim, "CA" + "7" * 32)
    assert row["notice_version"] == guard.DISCLOSURE_VERSION and not row.get("notice_completed_at")
    assert row["outcome"] == "abandoned"


def test_gather_call_records_the_notice_at_the_first_turn(tmp_path):
    sim, clock = build(tmp_path, mode="gather")
    call = sim.call()
    call.start()
    assert not call_row(sim, call.call_sid).get("notice_completed_at")
    clock.advance(seconds=12)
    call.say("My furnace stopped working, I'm in 77019")
    row = call_row(sim, call.call_sid)
    assert row["notice_completed_at"] == clock().isoformat() and row["notice_lang"] == "en"
    call.hangup()


def test_texting_off_records_the_no_sms_notice_version(tmp_path):
    sim, _ = build(tmp_path, SMS_ENABLED="0")
    root = incoming(sim)
    assert guard.DISCLOSURE_NO_SMS in root.find("Say").text and "text" not in root.find("Say").text.split("transcribed")[1]
    assert call_row(sim, "CA" + "7" * 32)["notice_version"] == guard.DISCLOSURE_VERSION_NO_SMS


class _OldSchema:
    """A database without the 2026-11-30 notice columns (migration not applied yet): unknown columns are refused."""

    def __init__(self):
        self.rows: list[dict] = []

    def insert(self, table, row):
        if any(k in row for k in ("notice_version", "notice_lang", "notice_completed_at")):
            raise StoreError("supabase POST /rest/v1/calls -> 400 PGRST204")
        self.rows.append({"id": "r1", **row})
        return self.rows[-1]

    def update(self, table, row_id, patch):
        if "notice_completed_at" in patch:
            raise StoreError("supabase PATCH /rest/v1/calls -> 400 PGRST204")
        return None


def test_a_database_without_the_notice_columns_never_loses_a_call():
    db = _OldSchema()
    row = insert_call(db, {"call_sid": "CA1", "outcome": None, "notice_version": "v", "notice_lang": "en",
                           "forwarded_from": "+17135550100"})
    assert row["call_sid"] == "CA1" and not set(OPTIONAL_CALL_COLUMNS) & set(row)
    notice_completed(db, row, MON_9)                              # refused update: logged, the call goes on


# --- time to first word (item 1: measured) -------------------------------------------------------------------------------
def test_first_word_no_longer_waits_for_the_relay_handshake(tmp_path, capsys):
    """The first spoken word now comes in the /voice/incoming TwiML itself (<Say>); before, it came only after Twilio
    had opened the relay WebSocket and the session was set up (welcomeGreeting). Measured here in process (server side;
    Twilio's own relay start-up time comes on top in production and is not simulated)."""
    sim, _ = build(tmp_path)
    t_in, t_setup = [], []
    for i in range(20):
        sid, caller = f"CA{i:032d}", f"+1713555{i:04d}"            # one caller per call (the per-number call cap)
        t0 = time.perf_counter()
        root = incoming(sim, call_sid=sid, caller=caller)
        t_in.append((time.perf_counter() - t0) * 1000)
        assert root[0].tag == "Say"                                # the first word is in this response
        call = harness.FakeCall(sim.twilio, sim.tenant("demo-hvac").twilio_number, caller, call_sid=sid,
                                settled=sim.settled())
        tw = parse_twiml(ET.tostring(root, encoding="unicode"))
        t1 = time.perf_counter()
        call._open(tw.relay_url)
        while not call_row(sim, sid).get("notice_completed_at"):
            time.sleep(0.001)
        t_setup.append((time.perf_counter() - t1) * 1000)
        call.hangup(5)
    p50 = lambda v: sorted(v)[len(v) // 2]
    with capsys.disabled():
        print(f"\n  time to first word (server side, in process): /voice/incoming p50 {p50(t_in):.1f} ms; "
              f"relay WebSocket + setup p50 {p50(t_setup):.1f} ms, no longer before the first word")
    assert p50(t_in) < 500


def test_every_call_column_the_runtime_writes_is_added_by_a_migration():
    """The notice columns the runtime writes exist in supabase/migrations (20261130100200_us_call_notice_record.sql)."""
    from pathlib import Path
    sql = "\n".join(p.read_text(encoding="utf-8") for p in (Path(__file__).resolve().parents[2] / "supabase" / "migrations").glob("*.sql"))
    for col in (*OPTIONAL_CALL_COLUMNS, "notice_completed_at"):
        assert f"alter table public.calls add column if not exists {col} " in sql, col


def test_the_legal_documents_say_what_the_flow_does():
    """SA §8 and Privacy §3.2 (v2.2) say exactly this, and no longer the 'plays before ... processes' / discard sentence."""
    from pathlib import Path
    legal = Path(__file__).resolve().parents[2] / "site" / "legal"
    for doc in ("service-agreement", "privacy"):
        html = (legal / doc / "index.html").read_text(encoding="utf-8")
        assert "Nothing the caller says is transcribed or sent to the AI before the notice ends." in html, doc
        assert "The notice plays before the assistant processes" not in html and "is still playing is discarded" not in html
