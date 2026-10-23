# AI Lab Pro (US) — dev + QA entry points. Run from the repo root.
#   make install   npm dev deps (Playwright + Puppeteer, no browser download)
#   make serve     static site on http://localhost:8787 (site/ + /__fixture__/)
#   make qa-fast   static checks only (no browsers): secrets, hard-coded values, config sync, price book,
#                  us_setup self-test, generated pages/fixtures up to date, sign-in helper unit tests, SQL lint, video VO length. CI runs this.
#   make qa        EVERYTHING: qa-fast + browsers (3 engines) + Deno tests + offline Postgres (PGlite) suites.
#                  Every browser suite gets its own server on a free port (no port clashes). Prefer serial `make qa`:
#                  under heavy CPU load `-j` causes Playwright launch/click timeouts.
PY ?= python3
NODE ?= node
DENO ?= deno
PORT ?= 8787
FREE = $$($(PY) tools/free_port.py)
DENO_RUN = $(DENO) run -A --node-modules-dir=none


install:
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund
	@echo "Browsers: Playwright 1.63 browsers must be in the cache; if not, run: npx playwright install chromium webkit firefox"

serve:
	PORT=$(PORT) sh tools/serve.sh

secrets:
	$(PY) tools/check_secrets.py --self-test >/dev/null
	$(PY) tools/check_secrets.py .

# ---------- static (no browser) ----------
qa-fast: secrets
	$(PY) tools/check_hardcoded.py --self-test >/dev/null
	$(PY) tools/check_hardcoded.py
	$(PY) tools/sync_config.py --check
	$(PY) tools/pricebook_test.py
	$(PY) tools/us_setup.py --self-test
	$(PY) tools/build_landing.py --check
	$(PY) tools/landing_test.py >/dev/null
	$(NODE) tools/signin_test.mjs >/dev/null
	$(DENO_RUN) tools/build_quote_fixtures.ts --check
	$(PY) tools/sql_lint.py supabase/migrations
	$(PY) videos/vo_length.py


# ---------- browsers ----------
# overflow gate self-test + landing pages, legal, quote fixtures, demo website, styleguide (3 engines x 4 widths)
qa-browser:
	$(NODE) tools/overflow.mjs --self-test
	sh tools/with_server.sh 'node tools/overflow.mjs $$(sed "s#^http://localhost:8787#$$BASE#" tools/urls-landing.txt) $$(sed "s#^/#$$BASE/#" tools/urls-extra.txt)'

# scripted chat demo: every path in every engine
qa-demo:
	sh tools/with_server.sh 'for e in chromium webkit firefox; do node tools/demo_test.mjs "$$BASE" --engine $$e || exit 1; done'

qa-start:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_start.mjs
	E2E_PORT=$(FREE) $(NODE) tools/overflow_start.mjs

# Sign-in screen with Google / Apple mocked (order, wording, errors, one-person-one-account, Apple relay e-mail)
qa-signin:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_signin.mjs

qa-admin:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_admin.mjs
	E2E_PORT=$(FREE) $(NODE) tools/overflow_admin.mjs

# Portal phase B (B7): E2E + overflow on the mock backend, and the B7 SQL test (PGlite, offline).
# ADD-DISPATCH portal section (on-call editor + urgent call log) on the mock backend
qa-dispatch:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_dispatch.mjs

qa-portal-b7:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_portal_b7.mjs
	E2E_PORT=$(FREE) $(NODE) tools/overflow_portal_b7.mjs
	$(DENO_RUN) supabase/tests/offline/portal_b7_run.ts

# Appointment manager (2026-10-23): portal Results tab E2E on the mock backend + the SQL test (PGlite, offline).
qa-appointments:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_appointments.mjs
	$(DENO_RUN) supabase/tests/offline/appointments_run.ts

# Phase-A gate (A10): the whole sale journey on the mock backend at 390 + 1280 (landing -> sign-in -> RCP questionnaire ->
# admin draft/send -> quote page accept -> deposit -> checklist -> go-live), plus WEB and real-estate paths; quote page E2E.
qa-phase-a:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_phase_a.mjs
	PORT=$(FREE) $(NODE) tools/e2e_quote.mjs

# Card / PayPal checkout on the mock backend with brand.json payments.paypal served ON and PayPal's SDK faked locally (nothing
# reaches paypal.com): the portal's final payment + the admin refund. The quote page's PayPal step is in tools/e2e_quote.mjs.
qa-paypal:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_paypal_portal.mjs

# ---------- Deno + offline Postgres ----------
qa-deno:
	cd supabase/functions && $(DENO) test -A --node-modules-dir=none .

qa-sql:
	$(DENO_RUN) supabase/tests/offline/run.ts
	$(DENO_RUN) supabase/tests/offline/quote_engine_run.ts
	$(DENO_RUN) supabase/tests/offline/email_events_run.ts
	$(DENO_RUN) supabase/tests/offline/paypal_run.ts
	$(DENO_RUN) supabase/tests/offline/dispatch_run.ts

qa: qa-fast qa-deno qa-sql qa-browser qa-demo qa-start qa-signin qa-admin qa-portal-b7 qa-dispatch qa-appointments qa-phase-a qa-paypal
	@echo "make qa: all checks passed"

# ---------- social (Facebook post bank, social/bank/) ----------
# social-status / social-dry read the real page (needs META_ACCESS_TOKEN or the local meta-ads/.env) and never post.
.PHONY: social-status social-dry social-cards social-check
social-status:
	$(PY) social/fb_post.py --status --dry-run
social-dry:
	$(PY) social/fb_post.py --dry-run
social-cards:
	$(PY) social/bank/render.py
social-check:
	$(PY) social/bank/render.py --check
