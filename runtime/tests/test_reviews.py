"""ADD-REV: post-job review-request SMS, shipped DISABLED. Two switches (env + tenant), consent rule, window,
opt-out, 90-day rule, landline, signed Zapier inbound, template size."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app import guard, settings as settings_mod, sms_outbound
from app.notify.routes import SIM_ADMIN_TOKEN
from app.zapier import SIM_SIGNING_SECRET, sign, tenant_secret
from sim import harness
from sim.fake_twilio import parse_twiml

TZ = ZoneInfo("America/Chicago")
MON_9 = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
URL = "https://g.page/r/example-review/review"
ADMIN = {"Authorization": f"Bearer {SIM_ADMIN_TOKEN}"}
CONSENT_TEXT = "Customer agreed on the job sheet to receive text messages from us about this job."


def build(tmp_path, now=MON_9, env_on=True):
    clock = harness.FakeClock(now)
    env = {"REVIEW_REQUESTS_ENABLED": "1"} if env_on else {}
    return harness.build(tmp_path, clock=clock, **env), clock


def enable(sim, demo_raw, enabled=True, url=URL, delay_hours=2):
    demo_raw["config"]["review_requests"] = {"enabled": enabled, "google_review_url": url, "delay_hours": delay_hours}
    return sim.store.upsert_tenant(demo_raw)


def say_yes(sim, tenant, contact=harness.CALLER):
    sim.store.for_tenant(tenant.id).record_consent(contact, "sms", "booking_texts", "yes", "Yes")


def post(sim, body, slug="demo-hvac", headers=ADMIN):
    return sim.client.post(f"/reviews/{slug}/job-completed", content=json.dumps(body).encode(),
                           headers={"Content-Type": "application/json", **headers})


def events(sim, type_):
    return [e for e in sim.store.select("events") if e["type"] == type_]


def review_jobs(sim, tenant):
    return [j for j in sim.rt.outbound.jobs(tenant) if j["kind"] == "review"]


JOB = {"contact": harness.CALLER, "name": "Dana", "job_type": "AC repair", "job_ref": "J-1001"}


# --- the two switches -----------------------------------------------------------------------------

def test_env_flag_defaults_off_and_is_public():
    s = settings_mod.load({"RUNTIME_MODE": "sim"})
    assert s.review_requests_enabled is False and s.public()["review_requests_enabled"] is False
    assert settings_mod.load({"RUNTIME_MODE": "sim", "REVIEW_REQUESTS_ENABLED": "1"}).review_requests_enabled is True


def test_env_off_is_403_even_when_tenant_on(tmp_path, demo_raw):
    sim, _ = build(tmp_path, env_on=False)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    r = post(sim, JOB)
    assert r.status_code == 403 and r.json() == {"error": "review_requests_disabled"}
    assert review_jobs(sim, t) == [] and events(sim, "review.job_completed") == []


def test_tenant_off_is_403(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw, enabled=False)
    say_yes(sim, t)
    r = post(sim, JOB)
    assert r.status_code == 403 and r.json()["error"] == "review_requests_disabled"
    assert review_jobs(sim, t) == []
    status = sim.client.get("/reviews/demo-hvac/status", headers=ADMIN).json()
    assert status == {"env_enabled": True, "tenant_enabled": False, "url_set": True, "pending_jobs": 0}


def test_unknown_slug_404_and_status_needs_admin(tmp_path):
    sim, _ = build(tmp_path)
    assert post(sim, JOB, slug="nobody").status_code == 404
    assert sim.client.get("/reviews/demo-hvac/status").status_code == 401


# --- consent --------------------------------------------------------------------------------------

def test_both_on_but_no_consent_is_not_queued(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    r = post(sim, JOB)
    assert r.status_code == 200 and r.json() == {"queued": False, "reason": "no_consent"}
    assert review_jobs(sim, t) == []
    assert events(sim, "review.job_completed")[-1]["payload"] == {"job_ref": "J-1001", "job_type": "AC repair",
                                                                   "queued": False, "reason": "no_consent"}


def test_consent_true_without_text_is_not_enough(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    assert post(sim, {**JOB, "consent": True}).json()["reason"] == "no_consent"
    assert sim.store.for_tenant(t.id).consent(harness.CALLER, "booking_texts") == []


def test_booking_texts_yes_queues_sends_in_window_with_link(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    r = post(sim, JOB)
    assert r.status_code == 200 and r.json()["queued"] is True
    [job] = review_jobs(sim, t)
    due = datetime.fromisoformat(job["due"])
    assert due == MON_9 + timedelta(hours=2) and guard.send_window_ok(t.config, due, harness.CALLER, "scheduled")
    assert job["job"] == {"name": "Dana", "job_type": "AC repair", "job_ref": "J-1001"}
    assert sim.client.get("/reviews/demo-hvac/status", headers=ADMIN).json()["pending_jobs"] == 1
    assert sim.tick().json()["sms_jobs"] == 0 and sim.twilio_client.outbox == []   # not yet
    clock.advance(minutes=120)
    assert sim.tick().json()["sms_jobs"] == 1
    [msg] = sim.twilio_client.outbox
    assert msg["to"] == harness.CALLER and URL in msg["body"] and "Reply STOP" in msg["body"]
    assert msg["body"] == sms_outbound.review_text(t, URL)
    assert [e["payload"] for e in events(sim, "sms.review")] == [{"job_ref": "J-1001", "sent": True}]
    assert all("+1713" not in json.dumps(e["payload"]) for e in events(sim, "sms.review"))
    assert sim.store.for_tenant(t.id).select("sms_messages")[-1]["body"] == msg["body"]


def test_attested_consent_is_recorded_and_queues(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    r = post(sim, {**JOB, "consent": True, "consent_text": CONSENT_TEXT})
    assert r.json()["queued"] is True
    [row] = sim.store.for_tenant(t.id).consent(harness.CALLER, "booking_texts")
    assert (row["channel"], row["decision"], row["evidence"], row["prompt_version"]) == \
        ("manual", "yes", CONSENT_TEXT, sms_outbound.REVIEW_CONSENT_VERSION)


def test_same_job_ref_twice_is_one_job(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    assert post(sim, JOB).json()["queued"] is True
    assert post(sim, JOB).json() == {"queued": False, "reason": "duplicate"}
    assert len(review_jobs(sim, t)) == 1


# --- window, opt-out, 90 days, landline ------------------------------------------------------------

def test_quiet_hours_defer_to_the_window(tmp_path, demo_raw):
    sim, clock = build(tmp_path, now=datetime(2026, 10, 12, 20, 30, tzinfo=TZ))  # Monday 20:30 CT
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    assert post(sim, JOB).json()["queued"] is True
    [job] = review_jobs(sim, t)
    due = datetime.fromisoformat(job["due"]).astimezone(TZ)
    assert (due.day, due.hour, due.minute) == (13, 9, 0)                       # Tuesday 09:00, not 22:30
    clock.advance(minutes=60)
    assert sim.tick().json()["sms_jobs"] == 0 and sim.twilio_client.outbox == []
    clock.advance(minutes=12 * 60)                                             # Tuesday 09:30
    assert sim.tick().json()["sms_jobs"] == 1 and len(sim.twilio_client.outbox) == 1


def test_stop_after_queueing_means_never_sent(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    assert post(sim, JOB).json()["queued"] is True
    r = sim.twilio.sms(t.twilio_number, harness.CALLER, "STOP")
    assert "unsubscribed" in parse_twiml(r.text).text
    clock.advance(minutes=130)
    sim.tick()
    assert sim.twilio_client.outbox == []
    assert [e["payload"]["reason"] for e in events(sim, "sms.review")] == ["opted_out"]
    assert post(sim, {**JOB, "job_ref": "J-1002"}).json() == {"queued": False, "reason": "opted_out"}


def test_blocklisted_number_is_refused(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    blocked = t.config.guard.blocklist[0]
    say_yes(sim, t, blocked)
    assert post(sim, {**JOB, "contact": blocked}).json() == {"queued": False, "reason": "blocklist"}


def test_one_review_text_per_contact_per_90_days(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    assert post(sim, JOB).json()["queued"] is True
    clock.advance(minutes=130)
    sim.tick()
    assert len(sim.twilio_client.outbox) == 1
    clock.advance(minutes=60 * 24 * 30)                                        # a month later, another job
    assert post(sim, {**JOB, "job_ref": "J-2000"}).json() == {"queued": False, "reason": "already_asked_90d"}
    clock.advance(minutes=60 * 24 * 61)                                        # > 90 days after the first text
    assert post(sim, {**JOB, "job_ref": "J-3000"}).json()["queued"] is True


def test_landline_is_never_texted(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    sim.twilio_client.landlines.add(harness.CALLER)
    assert post(sim, JOB).json()["queued"] is True
    clock.advance(minutes=130)
    sim.tick()
    assert sim.twilio_client.outbox == []
    assert [e["payload"]["reason"] for e in events(sim, "sms.review")] == ["line_type:landline"]


def test_tenant_switched_off_after_queueing_blocks_the_send(tmp_path, demo_raw):
    sim, clock = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    assert post(sim, JOB).json()["queued"] is True
    enable(sim, demo_raw, enabled=False)
    clock.advance(minutes=130)
    sim.tick()
    assert sim.twilio_client.outbox == []
    assert [e["payload"]["reason"] for e in events(sim, "sms.review")] == ["tenant_disabled"]


# --- Zapier inbound + body validation ---------------------------------------------------------------

def signed(sim, tenant, body: dict, secret: str | None = None):
    raw = json.dumps(body).encode()
    stamp = str(int(sim.clock().timestamp()))
    sig = sign(secret or tenant_secret(SIM_SIGNING_SECRET, tenant.id), stamp, raw)
    return sim.client.post(f"/reviews/{tenant.slug}/job-completed", content=raw,
                           headers={"Content-Type": "application/json", "X-Timestamp": stamp, "X-Signature": sig})


def test_signed_zapier_inbound_is_accepted(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    r = signed(sim, t, JOB)
    assert r.status_code == 200 and r.json()["queued"] is True


def test_bad_or_missing_signature_is_401(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    say_yes(sim, t)
    assert signed(sim, t, JOB, secret="not-the-secret").status_code == 401
    assert post(sim, JOB, headers={}).status_code == 401
    assert post(sim, JOB, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert review_jobs(sim, t) == []


def test_bad_body_is_400(tmp_path, demo_raw):
    sim, _ = build(tmp_path)
    t = enable(sim, demo_raw)
    assert post(sim, {}).status_code == 400
    assert post(sim, {"contact": "713-555-0123"}).status_code == 400
    assert post(sim, {**JOB, "extra": 1}).status_code == 400
    assert post(sim, [JOB]).status_code == 400
    r = sim.client.post("/reviews/demo-hvac/job-completed", content=b"not json",
                        headers={"Content-Type": "application/json", **ADMIN})
    assert r.status_code == 400
    assert review_jobs(sim, t) == []


# --- template ----------------------------------------------------------------------------------------

def test_template_is_one_segment_with_a_20_char_name(demo_raw):
    from app.tenants import load_record
    demo_raw["config"]["business"]["sms_display_name"] = "A" * 20
    t = load_record(demo_raw)
    body = sms_outbound.review_text(t, URL)
    assert body.startswith("A" * 20 + ":") and body.endswith("Reply STOP to opt out.")
    assert guard.sms_segments(body) == 1 and URL in body
    assert "$" not in body and "%" not in body
    assert sms_outbound.WINDOW_OF["review"] == "scheduled"
