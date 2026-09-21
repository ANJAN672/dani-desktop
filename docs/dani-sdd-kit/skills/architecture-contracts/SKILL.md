---
name: architecture-contracts
description: "Use when selecting runtime boundaries, protocol integrations, IPC, job ownership, subprocesses, ADRs and failure isolation for DANI."
---

# Procedure
1. Draw **responsibility graph**, **request sequence**, **effect path** and **crash/recovery** separately. Identify exactly one owner for job ledger, agent session, model gateway and external effects.
2. Verify Hermes installed protocol capabilities experimentally: sessions, streams, cancellation, approvals and CUA; do not infer HTTP/API/JSON-RPC feature equivalence.
3. Three execution strategies: exact deterministic control; validated Laya advisory decision; Hermes default for arbitrary intent. All side effects use one broker. `dani-free` belongs under Hermes model provider.
4. Minimize process count and dependencies; no model in runtime process; warm Hermes, optional warm shared Laya; no per-job workers unless isolation requires it.
5. Create ADR with options, attack surface, start/idle resources, scalability, platform differences, version pin and rollback.
6. Write typed interfaces and contract tests before refactoring. Verify no accidental second scheduler, queue, login or persistence owner.
**Stop gate:** If broker can be bypassed, block unattended high-impact actions and document limitation.
