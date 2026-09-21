---
name: performance-budget
description: "Use to diagnose slowness and set defensible latency, memory, startup and cost budgets for DANI Runtime, Hermes, Laya and adapters."
---

# Procedure
1. Identify actual Windows/desktop hardware and scenario corpus. Instrument ingress, job admission, queue, Hermes init, prefill/first token, reasoning, Laya warm inference, tool dispatch, browser/CUA latency, verification, final display.
2. Measure idle RSS/CPU, cold/warm startup, P50/P95 first useful action and VERIFIED completion; sample size and environment always shown.
3. Locate dominant span BEFORE optimization. Compare persistent Hermes with per-task launch, selective tools with full schema, direct API/DOM with CUA.
4. Keep Laya optional shared warm worker; measure model download size, warm residency and startup separately. Never put weights inside tiny runtime.
5. Set thresholds from empirical baseline and product hardware constraints; failing CI budget gates only after repeatable fixtures and approved tolerances.
6. A/B Hermes-only against selective Laya with matched model/tools/hardware and track correctness. Discard optimization with no end-to-end gain.
**Output:** profile, trace examples, target budgets, benchmark commands, uncertainty and decision.
