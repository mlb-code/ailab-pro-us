#!/bin/sh
# Run a command against a private static server (site/ + /__fixture__/) on a free port.
#   sh tools/with_server.sh 'node tools/demo_test.mjs "$BASE"'
# BASE (http://localhost:<port>) and PORT are exported to the command; the server is stopped on exit.
cd "$(dirname "$0")/.." || exit 1
PORT=$(python3 tools/free_port.py); BASE="http://localhost:$PORT"; export PORT BASE
SERVE_QUIET=1 python3 tools/serve.py "$PORT" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT INT TERM
i=0; until curl -s -o /dev/null "$BASE/"; do i=$((i+1)); [ $i -gt 50 ] && { echo "with_server: server did not start on $PORT"; exit 1; }; sleep 0.1; done
sh -c "$1"
