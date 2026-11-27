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
`TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL`, `OAUTH_BASE_URL` (optional: calendar OAuth connect link + redirect URI on our own domain, e.g. `https://rt.ailabpro.co`, needed for Google verification; empty = `PUBLIC_BASE_URL`), `CRED_KEY` (base64 32 bytes), `BRAIN_MODE` (mock|replay|record|live), `GLOBAL_DAILY_BUDGET_USD`,
`VOICE_MODE` (stream = ConversationRelay, production default | gather = turn-based fallback), `VOICE_SILENCE_SECONDS` (7),
`VOICE_TTS_WPS` (2.5), `TWILIO_ACCOUNT_SID` (outbound SMS + Lookup), `RUNTIME_ADMIN_TOKEN` (Bearer for the single cron `POST /jobs/tick`: SMS jobs + delivery queue + reports; `JOBS_TOKEN` accepted as alias), `JOBS_LOOP_SECONDS` (optional in-process SMS jobs, 0 = off), `SMS_ENABLED` (master switch, **off by default in production**, on in the simulator: off = no outbound SMS at all, no texting-consent question or text promise on calls, owner alerts by e-mail only, inbound texts logged + opt-outs recorded but never answered; `/health` shows `sms_enabled`), `SMS_BOOKING_REPLIES` (0 = off until 10DLC: booking texts ask for C/R/X replies, see `app/appointments.py`), `WEEKLY_REPORT` (0 = off: weekly results e-mail to owners), `VOICE_RELAY_GRACE_SECONDS` (20).

Voice/SMS routes: `/voice/incoming|turn|dial-result|status|fallback|relay-end`, WebSocket `/voice/relay`, `/sms/incoming|status`; cron `/jobs/tick` (B6 routes).
ADD-DISPATCH (on-call dispatcher, `app/dispatch.py`, tenant config `dispatch`): urgent call while closed (or `daytime_too`) ->
first name + ZIP -> warm transfer `<Dial><Number url=/voice/dispatch/whisper>` (brief + press 1), up to 3 numbers, 75 s cap ->
call-back promise + staff alerts (voice call `/voice/dispatch/alert`, press 1 = connect to the caller), repeated once after 5 min
(Outbound job, needs `/jobs/tick` at least every 5 min or `JOBS_LOOP_SECONDS`). Staff SMS alerts only with `DISPATCH_SMS_ALERTS=1`
(default off, waits for A2P 10DLC) AND `dispatch.sms_alerts`; "1" by SMS acknowledges. Log: table `dispatch_events`. Needs
`PUBLIC_BASE_URL` for the alert calls. 911 line for life-safety words stays first.
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
Consent rules (legal v1.1, SA §8; `tests/test_legal_v11.py`, scenarios 46-49; AI wording + SMS switch + objection data:
`tests/test_launch_fixes_2026_11_27.py`): every greeting carries `guard.disclosure(sms)` ("You're speaking with an AI assistant. ..."; the texting clause "and we may
text you about it" only while `SMS_ENABLED` is on, `tests/test_disclosure_sms_switch.py`; the text-back consent row stores the
variant heard, version `2026-11-27` or `2026-11-27-nosms`; a custom greeting missing any part, the AI wording included, gets it appended; stream mode discards caller speech said over the greeting and asks again once it has ended, `VOICE_GREETING_HOLD`);
after a booking the assistant asks before texting (confirmation + reminder only on "yes"); a recording objection ends the call
with `calls.transcript_withheld` and keeps only name + phone (webhooks/Zapier/CRM get those plus `recording_declined: true`); opt-outs by keyword, sentence or voice; texting window in the business AND caller (area-code)
zone; locked SMS templates; every decision in `sms_consent` (5 years, `supabase/migrations/20261012100000_us_sms_consent.sql`).
B5/B6 hooks used by voice/SMS: `app/_stubs_b56.py` (`get_provider`, `owner_alert`, `emit`).
Model and brand name come from `app/brand.json` (synced from `config/brand.json`).
FirstRing monthly plans (2026-11-25; `app/plans.py`, `app/usage.py`, `app/message_mode.py`, `app/provisioning.py`, `app/golive.py`):
`config.plan` (written only by the database from `public.subscriptions`) carries plan code, status, period and service mode; minutes,
trial cap and features (Spanish, website chat, dispatch, CRM) come from the price book `plans` by code. Usage is metered per billing
period (`usage:<tenant>:p<period start>:voice_minutes`); 80%/100% e-mails go to the customer with the upgrade link + a Hebrew note to
Meir (not gated by `CLIENT_EMAILS_ENABLED`). Message mode (`/voice/message-mode`; SMS/chat one fixed reply; owner gets each message as
a lead alert; no AI, no booking): trial ended unpaid, cancelled, past due beyond grace, paused, and `USAGE_CAP_MODE=message` (default;
`keep` = full answering past 100%) once the trial's 100 minutes or the plan's minutes are used (until the trial ends / the plan starts,
or the next billing period / an upgrade). Calls record Twilio `ForwardedFrom` in `calls.forwarded_from` (forwarding test).
`POST /jobs/tick` also runs `provisioning_jobs`: `number` = buy a US local number near the client's area code with the 4 webhooks
(**only with `TWILIO_PROVISION_LIVE=1`**; unset = dry run: sim/`TWILIO_PROVISION_DRY_WRITE=1` writes a fictional 555-01xx number,
production holds the job and e-mails Meir), `golive_sim` = the go-live simulator checks on the real config (mock model, temp store).
`POST /admin/sim-run/{slug}` (Bearer) runs the same checks on demand. Failures: 3 tries, then `failed` + Hebrew e-mail to Meir.
FirstRing phase 2 (2026-11-25; `supabase/migrations/*_us_firstring_p2.sql`, tests `tests/test_firstring_p2.py`):
- Number release: the database schedules `number_releases` (service ended = cancelled after the paid month, or the trial ended
  unpaid; release 30 days later, warning 7 days before; a resubscribe cancels). `POST /jobs/tick` sends the customer's 7-day
  warning e-mail (once), re-checks the subscription, and releases the number **only with `TWILIO_RELEASE_LIVE=1`**; unset = dry run
  (row `held` + Hebrew note to Meir with the number). Admin: postpone / release now in the "מנויים" tab.
- Live AI check before go-live (**`GOLIVE_LIVE_AI_CHECK=1`**, default off): one scripted ~5-turn conversation on the real model
  through the live-call engine (voice prompt, text only). Fail -> job `failed`, client stays in testing, Hebrew e-mail with the
  transcript. Model error / timeout: `GOLIVE_AI_RETRIES` (2) retries of `GOLIVE_AI_TIMEOUT_S` (90) each, then the job is `held`
  for manual approval. Token use and the cost estimate are logged and kept in the job result (`ai_check`).
- Spanish: on for plans with the `spanish` feature unless the customer switched it off in the portal (`voice.spanish_off`,
  remembered across plan changes; the database trigger `tenants_plan_spanish` and `app.plans.apply` say the same).
