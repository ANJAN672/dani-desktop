---
name: provider-compatibility
description: "Use when configuring danlab/dani-free as Hermes model provider, BYOK, OpenCode/Kilo legacy proxies, model capabilities, costs and quota behavior."
---

# Procedure
1. Inspect current provider configs, aliases, CLI requirements, auth, license/ToS and endpoints. Snapshot legacy tests before changes.
2. Use stable model provider interface inside Hermes; DANI Runtime only supervises/provider health, never a parallel LLM agent.
3. Capability matrix: tool calls, vision, structured output, context limit, quota/rate limit, costs, timeouts, retry/circuit breaker.
4. Keep `opencode-free` and `kilocode-free` independent; `danlab/dani-free` must not overwrite or silently hijack them.
5. Don't assume installed CLI account can be exported as an API. Ask consent before new software installs; no credentials scraping, quota circumvention, hidden billing or surprise paid fallback.
6. Contract tests: existing providers unchanged; vision-required when only text available; quota exhausted; switch failure mid-task; explicit budget consent; BYOK without DANI-Free.
**Done:** real authorized provider smoke test and redacted logs, or mark unavailable honestly.
