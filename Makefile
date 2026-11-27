# AI Lab Pro (US) — dev + QA entry points. Run from the repo root.
#   make install   npm dev deps (Playwright + Puppeteer, no browser download)
#   make serve     static site on http://localhost:8787 (site/ + /__fixture__/)
#   make assets    re-stamp ?v=<content hash> on every local script/stylesheet + JS asset maps (after editing site JS/CSS/JSON)
#   make qa-fast   static checks only (no browsers): secrets, hard-coded values, config sync, price book,
#                  us_setup self-test, generated pages/fixtures up to date, asset ?v= hashes current, sign-in helper unit tests, SQL lint, video VO length. CI runs this.
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

assets:
	$(PY) tools/asset_version.py

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
	$(PY) tools/asset_version.py --check
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

# FirstRing monthly plans (2026-11-25): sign-up -> automatic setup -> checklist into the live config -> forwarding test via the
# business line -> automatic go-live -> Billing minutes / upgrade / cancel -> message mode -> admin "מנויים" (mock backend).
# SHOTS_DIR=<dir> also saves screenshots (usage meter, message mode, admin) at 1440 and 390.
qa-subscription:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_subscription.mjs

# Monthly-plan sign-up + Paddle (2026-11-26): /start/?plan=FR_X -> your business (plan switch, consent) -> your card (demo box
# with Paddle off; with brand.json served ON, Paddle.js FAKED locally) -> portal; one trial per phone; Paddle billing actions;
# admin Paddle ids + 30-day refund. SHOTS_DIR=<dir> saves screenshots. The webhook + API side: qa-deno (paddle_test.ts), qa-sql.
qa-signup:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_signup.mjs

# FirstRing phase 2 (2026-11-25): "Answer in Spanish too" by plan (remembered choice), number release after the service
# ended (admin postpone / release now, dry-run tick, resubscribe cancels), go-live live AI check result in the admin (mock).
# SHOTS_DIR=<dir> also saves p2-* screenshots at 1440 and 390. Phase 3 (2026-11-25): the customer's Billing card and home status
# show the date the number is kept until (client_billing.number_release), gone after the restart (p3-portal-release-*).
qa-firstring-p2:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_firstring_p2.mjs

# Card / PayPal checkout on the mock backend with brand.json payments.paypal served ON and PayPal's SDK faked locally (nothing
# reaches paypal.com): the portal's final payment + the admin refund. The quote page's PayPal step is in tools/e2e_quote.mjs.
qa-paypal:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_paypal_portal.mjs

# ---------- runtime (Python): pytest + the simulator scenarios (replay) ----------
qa-runtime:
	cd runtime && .venv/bin/python -m pytest -q
	cd runtime && .venv/bin/python -m sim run --all

# ---------- Deno + offline Postgres ----------
qa-deno:
	cd supabase/functions && $(DENO) test -A --node-modules-dir=none .

qa-sql:
	$(DENO_RUN) supabase/tests/offline/run.ts
	$(DENO_RUN) supabase/tests/offline/quote_engine_run.ts
	$(DENO_RUN) supabase/tests/offline/email_events_run.ts
	$(DENO_RUN) supabase/tests/offline/paypal_run.ts
	$(DENO_RUN) supabase/tests/offline/dispatch_run.ts
	$(DENO_RUN) supabase/tests/offline/questionnaire_utm_run.ts
	$(DENO_RUN) supabase/tests/offline/subscriptions_run.ts
	$(DENO_RUN) supabase/tests/offline/paddle_run.ts
	$(DENO_RUN) supabase/tests/offline/onboarding_parity_run.ts
	$(DENO_RUN) supabase/tests/offline/firstring_p2_run.ts
	$(DENO_RUN) supabase/tests/offline/firstring_p3_run.ts
	$(DENO_RUN) supabase/tests/offline/questionnaire_web_only_run.ts
	$(DENO_RUN) supabase/tests/offline/subscription_emails_run.ts
	$(DENO_RUN) supabase/tests/offline/retention_runtime_state_run.ts

# Measurement (2026-10-25): no tag loads with empty IDs; with IDs served (mock) GA4 + Clarity + Meta Pixel load, events fire,
# GPC/DNT blocks everything, Clarity masks forms, the pixel maps funnel events and stays off the quote page, first-touch UTM
# reaches the questionnaire. Nothing reaches Google, Microsoft or Meta.
qa-measure:
	E2E_PORT=$(FREE) $(NODE) tools/e2e_measure.mjs

qa: qa-fast qa-deno qa-sql qa-browser qa-demo qa-start qa-signin qa-admin qa-portal-b7 qa-dispatch qa-appointments qa-phase-a qa-paypal qa-measure qa-subscription qa-firstring-p2 qa-signup qa-runtime
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
