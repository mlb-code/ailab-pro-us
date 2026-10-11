# runtime/ — שירות Python (FastAPI) רב-לקוחות ב-Railway: Twilio קול+SMS ↔ Claude ↔ Google Calendar/Calendly/Zapier, כולל סימולטור מקומי.

Setup (once): `uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e '.[dev]'`

| Command (from `runtime/`) | What |
|---|---|
| `.venv/bin/python -m pytest -q` | **all tests, one command**, offline (Claude mocked/replayed, Twilio faked) |
| `.venv/bin/python -m pytest -q tests/test_guard.py tests/test_scenarios.py tests/test_review_fixes.py --cov=app.guard --cov-branch --cov-fail-under=100` | guard branch coverage gate (all three files are needed for 100%) |
| `.venv/bin/python -m sim selftest` | offline smoke checks |
| `.venv/bin/python -m sim serve --port 8000` | run locally with fake Twilio token + JSON store |
| `.venv/bin/python -m sim run --all [--mode mock]` | the scenarios in `sim/scenarios/` (default: replay). `kind: flow` scenarios (31+) drive whole calls/threads through HTTP + the relay WebSocket; voice flows run in both voice modes |
| `.venv/bin/python -m sim run --channel voice\|sms [--voice-mode stream\|gather]` | only voice or SMS scenarios |
| `.venv/bin/python -m sim sms --text "my ac is broken"` / `sim call --say ... [--voice-mode gather]` | talk to the demo tenant (call prints per-turn latency and outbound SMS) |
| `.venv/bin/python -m sim validate FILE.json` | validate a tenant config |
| `.venv/bin/python -m sim record --all --source mock` | refresh `sim/replays/` (`--source live --yes` spends API credit) |
| `.venv/bin/python -m app.tenants --write-schema` | regenerate `app/tenant_schema.json` from the model |

Env: `RUNTIME_MODE` (prod|sim), `STORE_BACKEND` (json|supabase), `DATA_DIR`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL`, `CRED_KEY` (base64 32 bytes), `BRAIN_MODE` (mock|replay|record|live), `GLOBAL_DAILY_BUDGET_USD`,
`VOICE_MODE` (stream = ConversationRelay, production default | gather = turn-based fallback), `VOICE_SILENCE_SECONDS` (7),
`VOICE_TTS_WPS` (2.5), `TWILIO_ACCOUNT_SID` (outbound SMS + Lookup), `RUNTIME_ADMIN_TOKEN` (Bearer for the single cron `POST /jobs/tick`: SMS jobs + delivery queue + reports; `JOBS_TOKEN` accepted as alias), `JOBS_LOOP_SECONDS` (optional in-process SMS jobs, 0 = off), `VOICE_RELAY_GRACE_SECONDS` (20).

Voice/SMS routes: `/voice/incoming|turn|dial-result|status|fallback|relay-end`, WebSocket `/voice/relay`, `/sms/incoming|status`; cron `/jobs/tick` (B6 routes).
Latency in the simulator: the runtime records per turn (total ms, Claude ms) from receiving the final transcript to having the
reply ready; event `voice.latency` holds server p50/p95 (= total - Claude) per call, and `FakeCall` measures client-side ms per turn.
Target: server p95 < 150 ms (tested); end-to-end < 1 s needs Claude time, measured in live runs (B12).
Twilio cost estimate per call: `TWILIO_VOICE_USD_PER_MIN` (default 0.0785 = inbound local minute 0.0085 + ConversationRelay
0.07, list prices assumed Oct 2026; 0.0125 when `VOICE_MODE=gather`), billed in whole minutes; SMS `TWILIO_SMS_USD_PER_SEGMENT`.
Invalid tenant config = safe mode (`app/voice_safe.py`): polite sentence + name/number message, SMS text-back, minimal SMS replies
(STOP/HELP still work), event `tenant_config_invalid` + Hebrew admin alert once a day; `/health/deep` lists `tenants_invalid`.
B5/B6 hooks used by voice/SMS: `app/_stubs_b56.py` (`get_provider`, `owner_alert`, `emit`).
Model and brand name come from `app/brand.json` (synced from `config/brand.json`).
