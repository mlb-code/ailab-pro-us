# AI Lab Pro (US) — dev + QA entry points. Run from the repo root.
#   make serve     static site on http://localhost:8787 (site/ + /__fixture__/)
#   make secrets   secrets scan of the whole repo (fails on any finding)
#   make qa        every automated check that exists so far (A10 extends this)
#   make qa-start  client portal E2E + per-step overflow (mock backend)
PY ?= python3
NODE ?= node
PORT ?= 8787

.PHONY: serve secrets qa qa-static qa-browser qa-start install

install:
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund

serve:
	PORT=$(PORT) sh tools/serve.sh

secrets:
	$(PY) tools/check_secrets.py --self-test >/dev/null
	$(PY) tools/check_secrets.py .

qa-static: secrets
	$(PY) tools/check_hardcoded.py --self-test >/dev/null
	$(PY) tools/check_hardcoded.py
	@if [ -f tools/sync_config.py ]; then $(PY) tools/sync_config.py --check; fi
	@if [ -f tools/pricebook_test.py ]; then $(PY) tools/pricebook_test.py; fi

# Browser checks start their own server on PORT if nothing is listening there yet.
qa-browser:
	$(NODE) tools/overflow.mjs --self-test
	@if [ -f site/_styleguide/index.html ]; then \
	  started=; if ! curl -s -o /dev/null http://localhost:$(PORT)/; then SERVE_QUIET=1 PORT=$(PORT) sh tools/serve.sh >/dev/null 2>&1 & started=$$!; sleep 1; fi; \
	  $(NODE) tools/overflow.mjs http://localhost:$(PORT)/_styleguide/; rc=$$?; \
	  [ -n "$$started" ] && kill $$started; exit $$rc; fi

# Client portal (/start/): E2E on the mock backend (Puppeteer) + every screen/step overflow in 3 engines. Own servers.
qa-start:
	$(NODE) tools/e2e_start.mjs
	$(NODE) tools/overflow_start.mjs

qa: qa-static qa-browser qa-start
	@echo "make qa: all checks passed"
