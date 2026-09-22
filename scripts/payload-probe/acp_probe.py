#!/usr/bin/env python3
"""ACP initialize probe for a Hermes runtime payload.

Usage: python3 acp_probe.py <payload-root>
Spawns <payload-root>/bin/hermes-acp (.cmd on Windows), performs the ACP
JSON-RPC initialize handshake over stdio, and exits 0 iff the agent answers
with agentInfo.version == 0.21.4. Stdout must be JSON-RPC only. State goes
to a temp HERMES_HOME so the payload dir stays pristine. Cross-platform
(no select on pipes): watchdog timer enforces the timeout.
"""
import json, os, subprocess, sys, tempfile, threading

EXPECTED_VERSION = "0.21.4"
TIMEOUT_S = 90

def fail(msg):
    print(f"PROBE RESULT: FAIL ({msg})")
    sys.exit(1)

def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
    exe = os.path.join(root, "bin", "hermes-acp.cmd" if os.name == "nt" else "hermes-acp")
    if not os.path.exists(exe):
        fail(f"no executable at {exe}")
    env = dict(os.environ, HERMES_HOME=tempfile.mkdtemp(prefix="hermes-probe-home-"))
    proc = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, text=True, bufsize=1)
    watchdog = threading.Timer(TIMEOUT_S, proc.kill)
    watchdog.start()
    try:
        req = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
               "params": {"protocolVersion": 1,
                          "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                                 "terminal": False}}}
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        for line in proc.stdout:      # blocks until EOF; watchdog caps the wait
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                fail(f"non-JSON stdout: {line[:200]!r}")
            if msg.get("id") != 1:
                continue
            if "error" in msg:
                fail(f"JSON-RPC error {msg['error']}")
            info = msg.get("result", {}).get("agentInfo", {})
            print(json.dumps(msg, indent=2))
            if info.get("name") == "hermes-agent" and info.get("version") == EXPECTED_VERSION:
                print(f"PROBE RESULT: PASS (hermes-agent {EXPECTED_VERSION}, ACP initialize)")
                return
            fail(f"unexpected agentInfo {info}")
        fail("agent closed stdout without answering initialize")
    finally:
        watchdog.cancel()
        proc.kill()

if __name__ == "__main__":
    main()
