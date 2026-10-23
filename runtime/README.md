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

Env: `RUNTIME_MODE` (prod|sim), `STORE_BACKEND` (json|supabase), `DATA_DIR`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (a Supabase
**secret key**, `sb_secret_…`, made by `tools/us_setup.py --only supabase-keys`; the variable name is historical, the legacy service_role JWT is no longer used),
`TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL`, `CRED_KEY` (base64 32 bytes), `BRAIN_MODE` (mock|replay|record|live), `GLOBAL_DAILY_BUDGET_USD`,
`VOICE_MODE` (stream = ConversationRelay, production default | gather = turn-based fallback), `VOICE_SILENCE_SECONDS` (7),
`VOICE_TTS_WPS` (2.5), `TWILIO_ACCOUNT_SID` (outbound SMS + Lookup), `RUNTIME_ADMIN_TOKEN` (Bearer for the single cron `POST /jobs/tick`: SMS jobs + delivery queue + reports; `JOBS_TOKEN` accepted as alias), `JOBS_LOOP_SECONDS` (optional in-process SMS jobs, 0 = off), `SMS_BOOKING_REPLIES` (0 = off until 10DLC: booking texts ask for C/R/X replies, see `app/appointments.py`), `WEEKLY_REPORT` (0 = off: weekly results e-mail to owners), `VOICE_RELAY_GRACE_SECONDS` (20).

Voice/SMS routes: `/voice/incoming|turn|dial-result|status|fallback|relay-end`, WebSocket `/voice/relay`, `/sms/incoming|status`; cron `/jobs/tick` (B6 routes).
Claude models (brand.json `claude.*`): realtime turns (voice, SMS, web chat) use `claude.voice_model` (Haiku; env `CLAUDE_VOICE_MODEL`),
quotes use `claude.quote_model` (Edge), `claude.model` is the general default. Voice/realtime knobs: `claude.voice.max_tokens`
(`CLAUDE_VOICE_MAX_TOKENS`), `.thinking` disabled|adaptive (`CLAUDE_VOICE_THINKING`), `.prompt_cache` (`CLAUDE_PROMPT_CACHE`, also the
call-start prewarm), `.tool_fillers` (`CLAUDE_VOICE_FILLERS`); per-model prices in `claude.price_usd_per_mtok`.
Voice replies stream sentence by sentence (`app/speech.py`): each sentence passes `guard.check_reply` before it is sent to Twilio; a
blocked sentence is replaced by the safe text and the rest of the turn is muted; gather mode gives the identical reply at the end.
Latency in the simulator: the runtime records per turn (total ms, Claude ms) and, for Claude turns, the time to the first sentence;
event `voice.latency` holds server p50/p95 (= total - Claude) and `first_sentence_*` per call; `FakeCall` measures client-side ms to
the first text frame. Target: server p95 < 150 ms (tested, scenario 45 with a live-like streaming model). Live numbers:
`docs/reports/VOICE-LATENCY.md`.
Twilio cost estimate per call: `TWILIO_VOICE_USD_PER_MIN` (default 0.0785 = inbound local minute 0.0085 + ConversationRelay
0.07, list prices assumed Oct 2026; 0.0125 when `VOICE_MODE=gather`), billed in whole minutes; SMS `TWILIO_SMS_USD_PER_SEGMENT`.
Invalid tenant config = safe mode (`app/voice_safe.py`): polite sentence + name/number message, SMS text-back, minimal SMS replies
(STOP/HELP still work), event `tenant_config_invalid` + Hebrew admin alert once a day; `/health/deep` lists `tenants_invalid`.
Consent rules (legal v1.1, SA §8; `tests/test_legal_v11.py`, scenarios 46-49): every greeting carries `guard.DISCLOSURE` (a custom
greeting missing any part gets it appended; stream mode holds caller speech until the greeting ends, `VOICE_GREETING_HOLD`);
after a booking the assistant asks before texting (confirmation + reminder only on "yes"); a recording objection ends the call
with `calls.transcript_withheld`; opt-outs by keyword, sentence or voice; texting window in the business AND caller (area-code)
zone; locked SMS templates; every decision in `sms_consent` (5 years, `supabase/migrations/20261012100000_us_sms_consent.sql`).
B5/B6 hooks used by voice/SMS: `app/_stubs_b56.py` (`get_provider`, `owner_alert`, `emit`).
Model and brand name come from `app/brand.json` (synced from `config/brand.json`).
