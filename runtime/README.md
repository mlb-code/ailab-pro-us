# runtime/ — שירות Python (FastAPI) רב-לקוחות ב-Railway: Twilio קול+SMS ↔ Claude ↔ Google Calendar/Calendly/Zapier, כולל סימולטור מקומי.

Setup (once): `uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e '.[dev]'`

| Command (from `runtime/`) | What |
|---|---|
| `.venv/bin/python -m pytest -q` | all tests, offline (Claude mocked/replayed) |
| `.venv/bin/python -m pytest -q tests/test_guard.py tests/test_scenarios.py tests/test_review_fixes.py --cov=app.guard --cov-branch --cov-fail-under=100` | guard branch coverage gate (all three files are needed for 100%) |
| `.venv/bin/python -m sim selftest` | offline smoke checks |
| `.venv/bin/python -m sim serve --port 8000` | run locally with fake Twilio token + JSON store |
| `.venv/bin/python -m sim run --all [--mode mock]` | the scenarios in `sim/scenarios/` (default: replay) |
| `.venv/bin/python -m sim sms --text "my ac is broken"` / `sim call --say ...` | talk to the demo tenant |
| `.venv/bin/python -m sim validate FILE.json` | validate a tenant config |
| `.venv/bin/python -m sim record --all --source mock` | refresh `sim/replays/` (`--source live --yes` spends API credit) |
| `.venv/bin/python -m app.tenants --write-schema` | regenerate `app/tenant_schema.json` from the model |

Env: `RUNTIME_MODE` (prod|sim), `STORE_BACKEND` (json|supabase), `DATA_DIR`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`TWILIO_AUTH_TOKEN`, `PUBLIC_BASE_URL`, `CRED_KEY` (base64 32 bytes), `BRAIN_MODE` (mock|replay|record|live), `GLOBAL_DAILY_BUDGET_USD`.
Model and brand name come from `app/brand.json` (synced from `config/brand.json`).
