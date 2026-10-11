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
| `schema_lite.py` | Tiny JSON Schema subset validator used by the two scripts above. |
| `cdp-shots.mjs` | Headless Chrome screenshots with real mouse-wheel scrolling: `node tools/cdp-shots.mjs <url> qa-shots/x/d 1440 900 0 9333 '[0,900,1800]'` (mobile: `390 844 1`). Exit 1 on console errors. |
| `cdp-eval.mjs` / `cdp-eval-m.mjs` | Load a page (desktop / 390px touch) and print the JSON result of a JS expression. |
| `grid.py` | Tile screenshots into one sheet: `python3 tools/grid.py qa-shots/x/d 3 qa-shots/x/grid.png` (needs Pillow). |

Make targets: `make serve`, `make secrets`, `make qa` (static checks + browser checks; later tasks add their suites).
Chrome binary for the CDP tools: `CHROME_PATH` env or the standard macOS/Linux locations. Screenshots go to `qa-shots/` (gitignored).
