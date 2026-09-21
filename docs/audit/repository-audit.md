# Repository audit for DANI SDD integration

Status: evidence snapshot, 2026-09-21. Baseline: `prod` at `11c5f3f3a5f681c4841ae162282fe06075f2f6df`, tree `ef267d9b549a1f9e5ad3230c9629e20185b2eb11`. Repository: `https://github.com/somdipto/dani-desktop`. Main remained `fe6828167d69d3b128b109096ec42e25cf438893` during integration.

| Area | Evidence | State |
|---|---|---|
| Product shell | Electron/React UI, server, companion, Android and iOS trees exist | CONFIRMED_BY_SOURCE |
| Provider harness | `server/contracts.ts`, provider registry and Hermes ACP driver exist | CONFIRMED_BY_SOURCE |
| Hermes default | `server/index.ts` prefers available `hermesAgent`; Hermes adapter tests passed in focused verification | CONFIRMED_BY_TEST |
| Durable DANI ledger | `server/dani-control-plane.ts` persists events, jobs, effects, evidence, grants, approvals and audit in SQLite | CONFIRMED_BY_TEST |
| Typed tool boundary | `shared/dani-runtime.ts`, `server/dani-tools.ts`, `server/dani-tool-bridge.ts` | CONFIRMED_BY_TEST |
| Durable Hermes sessions | `server/dani-kernel/hermes-turn.ts` persists native cursors and interrupt state | CONFIRMED_BY_TEST |
| Delegation | Existing `server/delegations.ts` plus new typed `server/dani-delegations.ts` | CONFIRMED_BY_TEST |
| Memory sidecar | SQLite/FTS, provenance and conflict reconciliation in `server/memory-sidecar.ts` | CONFIRMED_BY_TEST |
| Laya | Shadow recorder only; no execution authority in `server/laya-shadow.ts` | CONFIRMED_BY_TEST |
| Voice | Duplex controller/VAD/barge-in contracts exist; native cross-platform inference is not proven | PARTIAL |
| Proactivity | Trigger, quiet-hours, retry and budget primitives exist; complete event-to-effect vertical slice is not proven | PARTIAL |
| Windows first slice | No captured Windows on-device browser-download/restart proof | UNVERIFIED |
| `danlab/dani-free` | Mentioned by supplied kit; no verified live contract, quota or license evidence in this audit | UNVERIFIED |

The current implementation establishes useful seams but not the complete owner-supplied production gauntlet. The largest gap is integration: the durable job/effect records, Hermes session adapter, tool executor and UI are not yet proven as one restart-safe Windows download workflow with ambiguous-effect reconciliation.
