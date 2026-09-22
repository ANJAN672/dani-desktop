#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ "$("$ROOT/bin/opencode" --version)" = 1.18.32 ]
exec python3 "$ROOT/probe/acp_probe.py" "$ROOT"
