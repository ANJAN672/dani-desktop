#!/bin/sh
# Runs the ACP initialize probe against this payload. Exit 0 = PASS.
PAYLOAD_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$PAYLOAD_ROOT/runtime/bin/python3" "$PAYLOAD_ROOT/probe/acp_probe.py" "$PAYLOAD_ROOT"
