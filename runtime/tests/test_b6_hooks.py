"""B5/B6: the real hooks behind app._stubs_b56, the background delivery queue (review fix #1)."""
from __future__ import annotations

import json
import threading
import time

import httpx

from app import _stubs_b56, hooks_b56
from app.notify.queue import BACKOFF_S, DeliveryQueue
from app.store import JsonStore, StateStore
from app.tenants import load_record
from app.zapier import ZapierClient
from sim import harness

HOOK = {"webhook_url": "https://hooks.zapier.com/x", "events": ["lead.created", "booking.created", "call.completed"]}


def _tenant(tmp_path, demo_raw, **cfg):
    raw = json.loads(json.dumps(demo_raw))
    raw["config"].update(cfg)
    store = JsonStore(tmp_path)
    state = StateStore(store, memory_fallback=True)
    hooks_b56.queue_for(store, state, autostart=False)  # tests drain by hand
    return store, state, store.upsert_tenant(load_record(raw))


def _drain(store, state, now=None):
    return hooks_b56.queue_for(store, state).drain(now)


def test_stub_names_now_point_to_the_real_hooks():
    for name in ("owner_alert", "emit", "TenantCalendars", "get_provider", "record_call", "record_sms"):
        assert getattr(_stubs_b56, name) is getattr(hooks_b56, name)


def test_owner_alert_only_enqueues_then_delivers_once(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw)
    a = {"type": "alert", "kind": "lead", "summary": "AC broken", "contact": "+17135550123", "channel": "sms"}
    _stubs_b56.owner_alert(store, state, t, a, "SM1:lead")
    types = [e["type"] for e in store.select("events")]
    assert types == ["alert.pending"]  # nothing sent inside the request
    _drain(store, state)
    _stubs_b56.owner_alert(store, state, t, a, "SM1:lead")
    _drain(store, state)
    types = [e["type"] for e in store.select("events")]
    assert types.count("alert.pending") == 1 and types.count("email.outbox") == 1 and types.count("sms.outbox") == 1
    mail = next(e for e in store.select("events") if e["type"] == "email.outbox")["payload"]
    assert mail["subject"] == "New lead: General inquiry · Unknown caller · -" and mail["to"] == ["owner@example.com"]
    assert hooks_b56.queue_for(store, state).pending() == []


def test_booking_alert_is_enriched_from_the_bookings_row(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw)
    store.for_tenant(t.id).insert("bookings", {"customer_name": "Dana Miller", "contact_e164": "+17135550123",
                                               "address": "2100 Rice Blvd, Houston, TX 77005", "job_type": "AC repair",
                                               "start_at": "2026-10-13T08:00:00-05:00",
                                               "end_at": "2026-10-13T12:00:00-05:00", "status": "confirmed"})
    _stubs_b56.owner_alert(store, state, t, {"type": "alert", "kind": "booking", "summary": "New booking",
                                             "contact": "+17135550123", "channel": "voice"}, "CA1:booking")
    _drain(store, state)
    mail = next(e for e in store.select("events") if e["type"] == "email.outbox")["payload"]
    assert mail["subject"] == "New lead: AC repair · Dana Miller · Houston" and "Tuesday Oct 13" in mail["text"]


def _zap(store, state, handler):
    posts = []

    def h(r):
        posts.append(r)
        return handler(r)
    hooks_b56._zaps[store] = ZapierClient(store, state, "m", http=httpx.Client(transport=httpx.MockTransport(h)))
    return posts


def test_zapier_retries_run_in_the_queue_with_backoff_then_dead_letter(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw, zapier=HOOK)
    posts = _zap(store, state, lambda r: httpx.Response(503))
    q = hooks_b56.queue_for(store, state)
    q.clock = lambda: 1000.0
    _stubs_b56.emit(store, state, t, "lead.created", {"contact": "+1"}, "SM9")
    assert posts == []  # enqueue only
    now, delays = 1000.0, []
    for _ in range(4):
        res = q.drain(now)
        assert len(res) == 1
        if res[0]["result"] == "retry":
            nxt = q.pending()[0]["next_at"]
            delays.append(nxt - now)
            assert q.drain(nxt - 0.5) == []  # not due yet
            now = nxt
    assert delays == list(BACKOFF_S) and len(posts) == 4 and res[0]["result"] == "done"
    assert [e["type"] for e in store.select("events")].count("zapier.dead_letter") == 1 and q.pending() == []


def test_emit_signs_and_sends_once_and_skips_unsubscribed(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw, zapier={**HOOK, "events": ["lead.created"]})
    posts = _zap(store, state, lambda r: httpx.Response(200))
    _stubs_b56.emit(store, state, t, "lead.created", {"contact": "+1"}, "SM9")
    _stubs_b56.emit(store, state, t, "lead.created", {"contact": "+1"}, "SM9")
    _stubs_b56.emit(store, state, t, "call.completed", {"call_sid": "CA1"}, "CA1")  # not subscribed
    _drain(store, state)
    assert len(posts) == 1 and posts[0].headers["X-Signature"].startswith("sha256=")
    assert [e["type"] for e in store.select("events")].count("zapier.pending") == 2


def test_pending_jobs_survive_a_restart(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw, zapier=HOOK)
    _stubs_b56.emit(store, state, t, "lead.created", {"contact": "+1"}, "SMr")
    # "restart": new store object + new state + new queue on the same data directory
    store2 = JsonStore(tmp_path)
    state2 = StateStore(store2)
    posts = _zap(store2, state2, lambda r: httpx.Response(200))
    q2 = hooks_b56.queue_for(store2, state2, autostart=False)
    assert len(q2.pending()) == 1
    assert q2.drain()[0]["result"] == "done" and len(posts) == 1


def test_background_worker_delivers_without_drain(tmp_path, demo_raw):
    store = JsonStore(tmp_path)
    state = StateStore(store)
    done = threading.Event()
    q = DeliveryQueue(store, state, {"x": lambda job: (done.set(), ("done", 0.0))[1]}, idle_s=0.05)
    q.enqueue("x", {})
    assert done.wait(2.0)
    q.stop()


def test_call_webhook_answers_fast_while_zapier_and_email_hang(tmp_path, demo_raw):
    """Review #1: Zapier returning 503 slowly + a slow mail server must not slow down /voice/turn."""
    raw = json.loads(json.dumps(demo_raw))
    raw["config"]["zapier"] = HOOK
    (tmp_path / "t").mkdir()
    (tmp_path / "t" / "demo.json").write_text(json.dumps(raw))
    sim = harness.build(tmp_path / "d")
    sim.store.upsert_tenant(load_record(raw))
    rt_state = sim.client.app.state.rt.state

    def slow_503(_req):
        time.sleep(0.5)
        return httpx.Response(503)
    posts = _zap(sim.store, rt_state, slow_503)

    class SlowEmail:
        name = "slow"

        def send(self, msg, idem):
            time.sleep(0.5)
            return {"ok": False, "error": "timeout"}
    hooks_b56.notifier_for(sim.store, rt_state).email = SlowEmail()
    q = hooks_b56.queue_for(sim.store, rt_state)
    q.autostart = False
    q.stop()
    if q._thread:
        q._thread.join(timeout=3)
    caller = harness.CALLER
    sim.twilio.start_call("+17135550199", caller, "CAfast")
    sim.twilio.say("+17135550199", caller, "CAfast", "hello")  # warm-up
    t0 = time.perf_counter()
    r = sim.twilio.say("+17135550199", caller, "CAfast", "There's a gas smell in my kitchen")
    elapsed = time.perf_counter() - t0
    assert r.status_code == 200 and elapsed < 0.1, elapsed
    assert sim.client.app.state.rt.drain(5)  # B3's hand-off pool only enqueues (fast)
    jobs = q.pending()
    assert posts == [] and any(j["kind"] == "alert" and j["payload"]["alert"]["kind"] == "urgent" for j in jobs)
    t0 = time.perf_counter()
    q.drain()  # the slow work happens here, on the queue side
    assert time.perf_counter() - t0 >= 0.5


# --- never twice: concurrent drains (review follow-up) ----------------------------------------------

def _slow_ok(posts):
    def h(r):
        posts.append(r)
        time.sleep(0.3)
        return httpx.Response(200)
    return h


def _parallel(*fns):
    ts = [threading.Thread(target=f) for f in fns]
    for t in ts:
        t.start()
    for t in ts:
        t.join(5)


def test_worker_and_tick_draining_together_send_once(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw, zapier=HOOK)
    posts = []
    hooks_b56._zaps[store] = ZapierClient(store, state, "m", http=httpx.Client(transport=httpx.MockTransport(_slow_ok(posts))))
    _stubs_b56.emit(store, state, t, "lead.created", {"contact": "+1"}, "SMp")
    _stubs_b56.owner_alert(store, state, t, {"type": "alert", "kind": "lead", "summary": "x"}, "SMp:lead")
    q = hooks_b56.queue_for(store, state)
    _parallel(q.drain, q.drain, q.drain)
    q.drain()
    sms = [e for e in store.select("events") if e["type"] == "sms.outbox"]
    assert len(posts) == 1 and len(sms) == 1 and q.pending() == []


def test_two_queue_objects_on_the_same_data_claim_each_job_once(tmp_path, demo_raw):
    store, state, t = _tenant(tmp_path, demo_raw, zapier=HOOK)
    _stubs_b56.emit(store, state, t, "lead.created", {"contact": "+1"}, "SMq")
    posts = []
    queues = []
    for _ in range(2):  # e.g. the worker of a new process and a cron tick of the old one
        s2 = JsonStore(tmp_path)
        st2 = StateStore(s2)
        hooks_b56._zaps[s2] = ZapierClient(s2, st2, "m", http=httpx.Client(transport=httpx.MockTransport(_slow_ok(posts))))
        queues.append((s2, hooks_b56.queue_for(s2, st2, autostart=False)))
    _parallel(*[q.drain for _, q in queues])
    assert len(posts) == 1


def test_supabase_claim_is_a_conditional_patch(tmp_path):
    """The claim is one PATCH filtered on the current lease: only one of two racers gets a row back."""
    from app.notify.queue import DeliveryQueue
    from app.store import SupabaseStore
    row = {"id": "1", "key": "outq:j1", "tenant_id": None, "value": {"id": "j1", "kind": "x", "lease": "",
                                                                     "lease_until": 0, "next_at": 0, "attempt": 0}}
    seen = []

    def handler(req):
        from urllib.parse import parse_qsl
        params = dict(parse_qsl(req.url.query.decode()))
        if req.method == "PATCH":
            seen.append(params)
            if params.get("value->>lease") == "eq." + (row["value"].get("lease") or ""):
                row["value"] = json.loads(req.content)["value"]
                return httpx.Response(200, json=[row])
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[row] if params.get("key") == "eq.outq:j1" else [])
    store = SupabaseStore("https://x.supabase.co", "service-test", transport=httpx.MockTransport(handler))
    q = DeliveryQueue(store, StateStore(store), {}, autostart=False)
    job = dict(row["value"])
    first, second = q.claim(job, 10.0), q.claim(job, 10.0)
    assert first and second is None and seen[0]["value->>lease"] == "eq."
