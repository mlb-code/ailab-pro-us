"""B3: voice flow - streaming (ConversationRelay) + turn-based fallback, caps, dial, status, usage."""
from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from starlette.websockets import WebSocketDisconnect

from app import voice
from app.tenants import load_file
from app.voice_stream import ws_base
from sim import harness
from sim.fake_twilio import parse_twiml

MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=ZoneInfo("America/Chicago"))
MODES = ["stream", "gather"]


def build(tmp_path, mode="stream", now=MON_9, **env):
    clock = harness.FakeClock(now)
    return harness.build(tmp_path, clock=clock, VOICE_MODE=mode, **env), clock


def valid_xml(text: str) -> ET.Element:
    root = ET.fromstring(text)
    assert root.tag == "Response"
    return root


def events(sim, type_):
    return [e for e in sim.store.select("events") if e["type"] == type_]


def alerts(sim):
    """Alert kinds the runtime handed to the notifier (B6 decides how they are delivered)."""
    return [a["kind"] for a in sim.rt.alert_log]


# --- TwiML snapshots: every branch is valid XML -------------------------------------------------

def test_twiml_branches_are_valid_xml():
    t = load_file(harness.TENANTS_DIR / "demo-hvac.json")
    for xml in (voice.twiml_gather("Hi there", "Polly.Joanna-Neural"), voice.twiml_say_hangup("Bye"),
                voice.twiml_say_hangup(""), voice.twiml_dial("Connecting", "Polly.Joanna-Neural", "+17135550111"),
                voice.twiml_reject(), voice.twiml_for(voice.VoiceTurn("x"), t),
                voice.twiml_for(voice.VoiceTurn("x", end=True), t), voice.twiml_for(voice.VoiceTurn("x", dial="+17135550111"), t)):
        valid_xml(xml)
    g = valid_xml(voice.twiml_gather("Hi", "Polly.Joanna-Neural")).find("Gather")
    assert g.get("speechModel") == "phone_call" and g.get("speechTimeout") == "auto"
    assert g.get("actionOnEmptyResult") == "true" and g.find("Say").get("voice") == "Polly.Joanna-Neural"
    d = valid_xml(voice.twiml_dial("", "v", "+17135550111")).find("Dial")
    assert d.get("timeout") == "20" and d.get("action") == "/voice/dial-result"


def test_relay_twiml(tmp_path):
    sim, _ = build(tmp_path)
    _, r = sim.twilio.start_call(sim.tenant("demo-hvac").twilio_number, harness.CALLER, "CA" + "1" * 32)
    root = valid_xml(r.text)
    relay = root.find("Connect/ConversationRelay")
    assert root.find("Connect").get("action") == "/voice/relay-end"
    assert relay.get("ttsProvider") == "Amazon" and relay.get("voice") == "Joanna-Neural"
    assert "transcribed" in relay.get("welcomeGreeting") and relay.get("welcomeGreetingInterruptible") == "none"
    assert relay.get("url").startswith("ws://testserver/voice/relay?t=")


@pytest.mark.parametrize("mode", MODES)
def test_unknown_paused_blocklisted(tmp_path, demo_raw, mode):
    sim, _ = build(tmp_path, mode)
    _, r = sim.twilio.start_call("+19995550000", harness.CALLER)
    valid_xml(r.text)
    assert "not in service" in parse_twiml(r.text).text
    _, r = sim.twilio.start_call(sim.tenant("demo-hvac").twilio_number, "+17135550666")
    assert parse_twiml(r.text).rejected
    demo_raw["config"]["paused"] = True
    sim.store.upsert_tenant(demo_raw)
    _, r = sim.twilio.start_call(demo_raw["twilio_number"], harness.CALLER)
    assert "can't take your call" in parse_twiml(r.text).text


def test_custom_greeting_gets_disclosure(tmp_path, demo_raw):
    demo_raw["config"]["voice"]["greeting"] = "Hello from Cool Breeze."
    sim, _ = build(tmp_path, "gather")
    sim.store.upsert_tenant(demo_raw)
    _, r = sim.twilio.start_call(demo_raw["twilio_number"], harness.CALLER)
    assert parse_twiml(r.text).text == ("Hello from Cool Breeze. This call may be recorded and transcribed by us and our "
                                        "service providers, and we may text you about it.")
    # gather mode: the greeting is a <Say> BEFORE <Gather> (no barge-in over the notice)
    assert r.text.index("<Say") < r.text.index("<Gather")


def test_incoming_retry_makes_one_call_row(tmp_path):
    sim, _ = build(tmp_path, "gather")
    t = sim.tenant("demo-hvac")
    sim.twilio.start_call(t.twilio_number, harness.CALLER, "CA" + "2" * 32)
    sim.twilio.start_call(t.twilio_number, harness.CALLER, "CA" + "2" * 32)
    assert len(sim.store.select("calls")) == 1


# --- relay socket security ----------------------------------------------------------------------

def _relay_url(sim, call_sid="CA" + "3" * 32):
    _, r = sim.twilio.start_call(sim.tenant("demo-hvac").twilio_number, harness.CALLER, call_sid)
    return parse_twiml(r.text).relay_url


def test_relay_refuses_unsigned_or_bad_token(tmp_path):
    sim, _ = build(tmp_path)
    url = _relay_url(sim)
    with pytest.raises(WebSocketDisconnect):
        with sim.client.websocket_connect(url) as ws:  # no signature
            ws.receive_text()
    bad = url.split("?t=")[0] + "?t=forged.token"
    with pytest.raises(WebSocketDisconnect):
        with sim.twilio.open_relay(bad) as ws:  # signed, but the token is not ours
            ws.receive_text()
    with pytest.raises(WebSocketDisconnect):
        with sim.client.websocket_connect(url, headers={"X-Twilio-Signature": sim.twilio.sign("/x", {})}) as ws:
            ws.receive_text()


def test_relay_setup_must_match_call(tmp_path):
    sim, _ = build(tmp_path)
    url = _relay_url(sim)
    with pytest.raises(WebSocketDisconnect):
        with sim.twilio.open_relay(url) as ws:
            ws.send_text(json.dumps({"type": "setup", "callSid": "CA" + "9" * 32, "from": harness.CALLER}))
            ws.receive_text()


def test_ws_base_prefers_public_url(tmp_path):
    sim, _ = build(tmp_path, PUBLIC_BASE_URL="https://rt.example.com")
    assert ws_base(sim.rt, None) == "wss://rt.example.com"


# --- conversation behaviour ------------------------------------------------------------------------

@pytest.mark.parametrize("mode", MODES)
def test_turn_cap_12(tmp_path, mode):
    sim, clock = build(tmp_path, mode)
    call = sim.call()
    call.start()
    last = None
    for i in range(13):
        clock.advance(seconds=10)
        last = call.say("are you a robot?")  # answered in code, so the Claude reply limit is not the one hit
        if last.end:
            break
    assert last.end and voice.TURN_CAP_TEXT in last.text and i == 12
    call.hangup()
    assert sim.store.select("calls")[0]["outcome"] == "message" and "lead" in alerts(sim)


@pytest.mark.parametrize("mode", MODES)
def test_six_minute_cap(tmp_path, mode):
    sim, clock = build(tmp_path, mode)
    call = sim.call()
    call.start()
    call.say("Do you service Trane units?")
    clock.advance(minutes=6)
    assert voice.TURN_CAP_TEXT in call.say("Are you licensed and insured?").text


@pytest.mark.parametrize("mode", MODES)
def test_handoff_dial_answered(tmp_path, mode):
    sim, _ = build(tmp_path, mode)
    call = sim.call()
    call.start()
    assert call.say("Can I talk to a real person please").dial == "+17135550111"
    assert call.dial("completed").end
    call.hangup()
    assert sim.store.select("calls")[0]["outcome"] == "handoff"


@pytest.mark.parametrize("mode", MODES)
def test_urgent_dial_no_answer_stays_emergency(tmp_path, mode):
    sim, _ = build(tmp_path, mode)
    call = sim.call()
    call.start()
    turn = call.say("The basement is flooding")
    assert turn.dial == "+17135550111" and "connecting you" in turn.text
    assert "no one could pick up" in call.dial("no-answer").text
    call.hangup()
    assert sim.store.select("calls")[0]["outcome"] == "emergency"
    assert {"urgent", "lead"} <= set(alerts(sim))


@pytest.mark.parametrize("order", ["close_first", "end_first"])
@pytest.mark.parametrize("status", ["failed", "completed"])
def test_relay_loss_continues_with_gather_same_conversation(tmp_path, order, status):
    """Twilio closes the socket (real order: close, then relay-end) while the caller is on the line:
    continue with <Gather> and the same context - no hang-up, no outcome, no text-back."""
    sim, _ = build(tmp_path)
    call = sim.call()
    call.start()
    call.say("My AC is blowing warm air")
    turn = call.relay_failed(order=order, session_status=status)
    assert "say that again" in turn.text and not turn.end and call.mode == "gather-fallback"
    c = sim.rt.engine.find_convo(sim.tenant("demo-hvac"), "voice", call.call_sid)
    assert c.outcome is None and not c.ended and c.meta["relay_resumed"] and "relay_lost" not in c.meta
    assert "Which works better" in call.say("77005").text  # the brain still knows the problem
    assert events(sim, "voice.relay_failed") and not sim.twilio_client.outbox


def test_relay_loss_before_speech_sends_no_textback_mid_call(tmp_path):
    sim, _ = build(tmp_path)
    call = sim.call()
    call.start()
    call.relay_failed()
    import time
    time.sleep(sim.settings.voice_relay_grace_s + 0.3)  # the grace timer must not close a resumed call
    c = sim.rt.engine.find_convo(sim.tenant("demo-hvac"), "voice", call.call_sid)
    assert c.outcome is None and not c.meta.get("finalized") and sim.twilio_client.outbox == []
    assert "technician" in call.say("My AC is blowing warm air").text


def test_relay_lost_without_relay_end_or_status_finalizes_after_grace(tmp_path):
    sim, _ = build(tmp_path)
    call = sim.call()
    call.start()
    call._twilio_closes_socket()  # socket gone, then nothing (no relay-end, no status callback)
    c = sim.rt.engine.find_convo(sim.tenant("demo-hvac"), "voice", call.call_sid)
    assert c.meta.get("relay_lost") and c.outcome is None
    import time
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not sim.twilio_client.outbox:
        time.sleep(0.05)
    assert sim.store.select("calls")[0]["outcome"] == "abandoned" and len(sim.twilio_client.outbox) == 1
    call._close_ws()


def test_interrupt_is_noted(tmp_path):
    sim, _ = build(tmp_path)
    call = sim.call()
    call.start()
    call._ws.send_text(json.dumps({"type": "interrupt", "utteranceUntilInterrupt": "Thanks for", "durationUntilInterruptMs": 900}))
    call._ws.send_text(json.dumps({"type": "dtmf", "digit": "1"}))
    call._ws.send_text(json.dumps({"type": "error", "description": "test"}))
    call._ws.send_text("not json")
    call.say("Do you service Trane units?")
    c = sim.rt.engine.find_convo(sim.tenant("demo-hvac"), "voice", call.call_sid)
    assert c.meta["interrupts"] == 1


def test_caller_hangs_up_mid_conversation_is_a_message(tmp_path):
    sim, _ = build(tmp_path)
    call = sim.call()
    call.start()
    call.say("My AC is blowing warm air")
    call.hangup(40)
    row = sim.store.select("calls")[0]
    assert row["outcome"] == "message" and row["duration_s"] == 40 and "lead" in alerts(sim)
    assert not sim.twilio_client.outbox  # text-back is only for calls with no speech


# --- status callback, minutes, text-back -----------------------------------------------------------

def test_status_is_idempotent_and_minutes_round_up(tmp_path):
    sim, clock = build(tmp_path, "gather")
    t = sim.tenant("demo-hvac")
    call = sim.call()
    call.start()
    call.say("Do you service Trane units?")
    for _ in range(2):
        sim.twilio.status(t.twilio_number, harness.CALLER, call.call_sid, "completed", 61)
    assert sim.rt.engine.usage.used(t, "voice", clock()) == 2
    assert len(events(sim, "voice.latency")) == 1
    assert sim.twilio.status(t.twilio_number, harness.CALLER, call.call_sid, "ringing", 0).status_code == 204
    assert sim.twilio.post("/voice/status", sim.twilio.call_params(t.twilio_number, harness.CALLER, "CAx",
                                                                    CallStatus="completed", CallDuration="abc")).status_code == 204


def test_textback_once_per_day(tmp_path):
    sim, clock = build(tmp_path, "gather")
    for _ in range(2):
        call = sim.call()
        call.start()
        call.hangup(3)
        clock.advance(minutes=30)
    assert len(sim.twilio_client.outbox) == 1
    reasons = [e["payload"].get("reason") for e in events(sim, "sms.textback")]
    assert reasons == [None, "already_texted_today"]


def test_server_time_per_turn_p95_under_150ms(tmp_path):
    """B3 acceptance: p95 server time per turn excluding Claude < 150 ms (measured by the runtime)."""
    sim, clock = build(tmp_path)
    call = sim.call()
    call.start()
    for line in ["My furnace stopped working, I'm in 77019", "Do you service Trane units?",
                 "Are you licensed and insured?", "The afternoon one please, this is Carlos Reyes at 45 Westheimer Rd Houston 77019"]:
        clock.advance(seconds=15)
        call.say(line)
    call.hangup()
    lat = events(sim, "voice.latency")[0]["payload"]
    assert lat["turns"] == 4 and lat["server_ms_p95"] < 150 and lat["mode"] == "stream"


def test_fallback_route_always_answers(tmp_path):
    sim, _ = build(tmp_path)
    t = sim.tenant("demo-hvac")
    r = sim.twilio.post("/voice/fallback", sim.twilio.call_params(t.twilio_number, harness.CALLER, "CA1", ErrorCode="11200"))
    valid_xml(r.text)
    assert "trouble" in parse_twiml(r.text).text and events(sim, "voice.fallback")
    r = sim.twilio.post("/voice/fallback", sim.twilio.call_params("+19995550000", harness.CALLER, "CA2"))
    assert parse_twiml(r.text).hangup


def test_turn_and_dial_for_unknown_number(tmp_path):
    sim, _ = build(tmp_path, "gather")
    assert parse_twiml(sim.twilio.say("+19995550000", harness.CALLER, "CA1", "hi").text).hangup
    assert parse_twiml(sim.twilio.dial_result("+19995550000", harness.CALLER, "CA1", "busy").text).hangup
    t = sim.tenant("demo-hvac")
    assert parse_twiml(sim.twilio.dial_result(t.twilio_number, harness.CALLER, "CA-none", "busy").text).hangup
    r = sim.twilio.relay_end("+19995550000", harness.CALLER, "CA1", "/voice/relay-end", None)
    assert parse_twiml(r.text).hangup
    r = sim.twilio.relay_end(t.twilio_number, harness.CALLER, "CA1", "/voice/relay-end", "not json")
    assert parse_twiml(r.text).hangup


def test_turn_after_call_ended_hangs_up(tmp_path):
    sim, _ = build(tmp_path, "gather")
    call = sim.call()
    call.start()
    call.say("Can I talk to a real person please")
    call.dial("no-answer")
    r = sim.twilio.say(call.to, call.caller, call.call_sid, "hello?")
    assert parse_twiml(r.text).hangup


def test_percentile():
    assert voice.percentile([], 95) == 0.0
    assert voice.percentile([1, 2, 3, 4, 100], 95) == 100 and voice.percentile([5, 1, 3], 50) == 3


@pytest.mark.parametrize("mode", MODES)
def test_reply_limit_on_voice_never_leaves_dead_air(tmp_path, mode):
    sim, clock = build(tmp_path, mode)
    call = sim.call()
    call.start()
    texts = []
    for _ in range(11):
        clock.advance(seconds=5)
        turn = call.say("Do you service Trane units?")
        texts.append(turn.text)
        if turn.end:
            break
    assert turn.end and turn.text  # over the per-number limit: a closing sentence, then hang up


def test_webhooks_do_not_wait_for_zapier_or_alerts(tmp_path, demo_raw):
    """Zapier answering 503 (with retries) must not slow any Twilio webhook: delivery is queued."""
    import time
    import httpx
    from app import hooks_b56
    from app.zapier import ZapierClient
    demo_raw["config"]["zapier"] = {"webhook_url": "https://hooks.zapier.com/hooks/catch/1/abc/",
                                    "events": ["lead.created", "booking.created", "call.completed"]}
    for mode in MODES:
        sim, clock = build(tmp_path / mode, mode)
        sim.store.upsert_tenant(demo_raw)
        hits = []
        hooks_b56._zaps[sim.store] = ZapierClient(
            sim.store, sim.rt.state, "test-signing-secret",
            http=httpx.Client(transport=httpx.MockTransport(lambda r: hits.append(1) or httpx.Response(503))),
            sleep=lambda s: time.sleep(0.2))
        call = sim.call()
        call.start()
        t0 = time.perf_counter()
        turn = call.say("Can I talk to a real person please")  # lead.created + alerts
        assert (time.perf_counter() - t0) < 0.1 and turn.dial
        t0 = time.perf_counter()
        call.dial("no-answer")
        call.hangup(30)                                          # call.completed + status work
        assert (time.perf_counter() - t0) < 0.1 + (0.0 if mode == "gather" else 0.05)
        t0 = time.perf_counter()
        r = sim.twilio.sms(sim.tenant("demo-hvac").twilio_number, "+17135550124", "Hi, my AC is blowing warm air")
        assert r.status_code == 200 and (time.perf_counter() - t0) < 0.1
        assert sim.rt.drain(10) and hits  # it was delivered (and retried) in the background


def test_cost_hooks_called_for_calls_and_outbound_sms(tmp_path, monkeypatch):
    from app import _stubs_b56
    calls, sms = [], []
    monkeypatch.setattr(_stubs_b56, "record_call", lambda store, state, tenant, **f: calls.append(f))
    monkeypatch.setattr(_stubs_b56, "record_sms", lambda store, state, tenant, **f: sms.append(f))
    sim, _ = build(tmp_path, "gather")
    call = sim.call()
    call.start()
    call.say("Do you service Trane units?")
    call.hangup(95)
    sim.twilio.status(call.to, call.caller, call.call_sid, "completed", 95)  # duplicate callback
    assert len(calls) == 1 and calls[0]["duration_s"] == 95 and calls[0]["outcome"] == "message"
    assert calls[0]["turn_ms"] and "transcript" in calls[0]
    sim.twilio.sms(call.to, harness.CALLER, "Hi, my AC is blowing warm air")
    assert [(x["direction"], x["twilio_sid"] is None) for x in sms] == [("inbound", False), ("outbound", True)]


def test_a_blocking_hook_runs_off_the_webhook(tmp_path, monkeypatch):
    """Whatever hook implementation is plugged in, a slow one never runs inside the Twilio webhook."""
    import time
    from app import _stubs_b56
    seen = []
    monkeypatch.setattr(_stubs_b56, "owner_alert", lambda *a: (time.sleep(0.5), seen.append(a[3]["kind"])))
    monkeypatch.setattr(_stubs_b56, "emit", lambda *a: time.sleep(0.5))
    sim, _ = build(tmp_path, "gather")
    call = sim.call()
    call.start()
    t0 = time.perf_counter()
    assert call.say("Can I talk to a real person please").dial
    assert time.perf_counter() - t0 < 0.1
    assert sim.rt.drain(5) and "human_needed" not in seen  # handoff dial: no alert until the dial result
