#!/bin/sh
# Serve site/ on http://localhost:8787 (plus QA fixtures at /__fixture__/).
# Equivalent to `python3 -m http.server 8787 -d site`, with the fixture mount and no-store caching.
cd "$(dirname "$0")/.." || exit 1
exec python3 tools/serve.py "${PORT:-8787}"
