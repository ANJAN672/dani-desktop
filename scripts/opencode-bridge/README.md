# Hermes to OpenCode free-model bridge

Kernel consumes `server.mjs` and `hermes-config.yaml` after activating the OpenCode managed runtime.

Interface:
- Start: `OPENCODE_BIN=/activated/bin/opencode OPENCODE_FREE_MODEL=opencode/big-pickle node server.mjs`. It binds only to loopback. When `OPENCODE_SERVER_URL` is absent, it owns an `opencode serve --pure` child on loopback port 4100.
- Liveness: `GET /health`. HTTP 200 means the bridge process and owned child are alive. This does not claim the model is ready.
- Readiness: `GET /ready`. HTTP 200 only when OpenCode health responds and the exact configured model is active with input/output/cache costs all zero. HTTP 503 if the limited-time route disappears, changes price, times out, or the child exits. No alternate model is selected.
- OpenAI-compatible API: `GET /v1/models`, `POST /v1/chat/completions` at port 4110 by default. Requests for any model other than the exact configured model are rejected. Upstream completion evidence must report the same provider/model, cost 0, and finish `stop`.
- Stop: send SIGTERM or SIGINT to the bridge. It stops its owned child, closes the HTTP listener, and exits within five seconds. If the kernel supplies `OPENCODE_SERVER_URL`, the external child remains kernel-owned.

Bounds: 1 MiB request body, 200 messages, 256,000 text characters, configurable upstream timeout via `OPENCODE_BRIDGE_TIMEOUT_MS`. Errors expose only status/class, never upstream response bodies. Both listener and upstream must be loopback HTTP.

Hermes merges the included `model` and `providers` keys into its isolated `HERMES_HOME/config.yaml`. The route is `provider: opencode-free`, `base_url: http://127.0.0.1:4110/v1`, `api_mode: chat_completions`, exact model `opencode/big-pickle`. `local-bridge` is a non-secret loopback placeholder key.
