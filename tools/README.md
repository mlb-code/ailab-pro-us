# tools/

QA and build tooling. Run everything from the repo root. Python tools are stdlib-only unless noted;
Node tools need `npm install` once (Playwright 1.63.0 uses the browsers already in `~/Library/Caches/ms-playwright`;
Puppeteer is configured never to download Chrome, see `.puppeteerrc.cjs`).

| Tool | What it does |
|---|---|
| `serve.sh` / `serve.py` | `make serve`: static server on http://localhost:8787 for `site/`, plus `tools/fixtures/` at `/__fixture__/`. |
| `overflow.mjs` | Loads URLs at 375/390/414/1280 in Chromium, WebKit, Firefox. Fails on `scrollWidth > innerWidth` or any console error. `--self-test` proves pass + fail paths with its own server. Options: `--engines`, `--widths`, `--allow-console <regex>`, `--json`. |
| `check_secrets.py` | Secrets scan (Anthropic, Supabase, Resend, Twilio, private keys, …). Masks findings, never opens `.secrets.env`/`.env*`/`*.p8`. `--self-test`. |
| `check_hardcoded.py` | Flags brand values (from `config/brand.json`) and price-book dollar amounts typed into source files. Generated files (`generated-by: tools/` marker) and `.md` only get warnings for amounts not in the price book. Pragma: `hardcoded-ok`. `--self-test`. |
| `sync_config.py` | Validates `config/` and copies `brand.json` + `pricebook.json` to `site/assets/`, `supabase/functions/_shared/`, `runtime/app/`. `--check` = drift report. |
| `pricebook_test.py` | Parses `docs/PRICEBOOK.md` tables and rules, diffs them against `config/pricebook.json`, validates the schema, checks integrations/niches. |
| `landing_test.py` | Reviews rule (in `make qa-fast`): renders the landing pages with 0, 1 and 2 reviews; the "What clients say" section appears only with >= 2 approved (`consent: true`) reviews in `site/_content/reviews.json`; the "What a call sounds like" sample strip always shows; no "your review here" placeholders. |
| `schema_lite.py` | Tiny JSON Schema subset validator used by the two scripts above. |
| `cdp-shots.mjs` | Headless Chrome screenshots with real mouse-wheel scrolling: `node tools/cdp-shots.mjs <url> qa-shots/x/d 1440 900 0 9333 '[0,900,1800]'` (mobile: `390 844 1`). Exit 1 on console errors. |
| `cdp-eval.mjs` / `cdp-eval-m.mjs` | Load a page (desktop / 390px touch) and print the JSON result of a JS expression. |
| `e2e_start.mjs` | Client portal E2E on the mock backend (Puppeteer, own server on `E2E_PORT`, default 8931): sign-in, branches, autosave/resume, submit lock, isolation between clients, portal tabs. |
| `overflow_start.mjs` | Overflow + console gate for every signed-in portal screen and questionnaire step (5 paths) in Chromium/WebKit/Firefox at 375/390/414/1280 (own server, default 8932). |
| `e2e_admin.mjs` | Owner admin (`/start/admin/`, Hebrew RTL) E2E on the mock backend (Puppeteer, default port 8941): access control, quote editing via price-book codes only, FOUNDING, manual-price gate, approve-and-send, clients/payments, retainer queue, notes never reach the client, overflow. |
| `overflow_admin.mjs` | Overflow + console gate for every admin tab and detail in Chromium/WebKit/Firefox at 375/390/414/1280 (default port 8942). |
| `e2e_phase_a.mjs` | A10 phase-A gate (`make qa-phase-a`): full RCP sale journey on the mock backend at 390 + 1280 (landing → sign-in → questionnaire → admin draft/send → quote page accept → deposit → 7-step checklist → go-live gate → final payment), plus WEB (deposit link, no quote) and real-estate branches. Fails on console errors, overflow or any live Supabase/Anthropic/Resend call. Own server on `E2E_PORT` (default: free port). |
| `us_setup.py` | A2: one-command Supabase setup for `ailab-us` (create in a Free org, us-east-1; migrations; remote RLS test; auth; Vault + function secrets; functions; cron; writes `site/assets/config.js`). `--dry-run` (no network), `--plan` (read-only), `--create`, `--ref`, `--org`, `--only a,b`, `--self-test`. Secrets only from `.secrets.env`. Runbook: `docs/runbooks/supabase-us-setup.he.md`. |
| `us_setup_check.py` | Verifies the real project: RLS everywhere, no anon grants, `ping()`, cron jobs, `delete from auth.users` from a pg_cron job. |
| `us_setup_test.py` | Offline tests for both (fake Management API): `python3 tools/us_setup.py --self-test`. |
| `grid.py` | Tile screenshots into one sheet: `python3 tools/grid.py qa-shots/x/d 3 qa-shots/x/grid.png` (needs Pillow). |

Make targets: `make serve`, `make secrets`, `make qa-start`, `make qa` (static checks + browser checks; later tasks add their suites).
Chrome binary for the CDP tools: `CHROME_PATH` env or the standard macOS/Linux locations. Screenshots go to `qa-shots/` (gitignored).
