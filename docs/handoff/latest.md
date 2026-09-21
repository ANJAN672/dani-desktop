# Latest handoff

Branch: `sdd-kit-integration`, replayed after the three infrastructure CI fixes on prod. This slice integrates owner-supplied SDD documentation and local skills only; it changes no production code.

Added: preserved kit under `docs/dani-sdd-kit/` with trust/provenance notice; namespaced project skills under `.claude/skills/dani-*`; repository audit, feature parity, dependency notes, baseline, unknowns, constitution, ADR-001, runtime/Hermes specs and traceability.

## Staged application work

1. RED tests and schema migration for canonical `UNKNOWN`, immutable attempts, full effect digest, precondition hashes, intent-before-dispatch and reconcile-before-retry.
2. Fenced transitions, cancellation checks at admission/lease/dispatch, and one durable physical-desktop lease.
3. Fresh source-linked success verifier, canonical duplicate result, untrusted page/tool/file provenance, broker-only writes and filesystem verification.
4. Workspace and memory isolation, retention/delete, correction/retraction, staleness and procedural-vs-personal memory contracts.
5. Trigger registry/evaluator/scheduler/wake, freshness/dedupe-window authorization, typed initiative levels, novelty/budgets and real quiet-hour/DST/deferred-coalescing enforcement.
6. Wire the control plane into the live serving path; pin and license Hermes; run real ACP handshake/stream/model/permission/cancel/resume tests; measure warm versus per-turn processes; add deterministic no-model stop/status/cancel and durable delegation/crash/orphan handling.
7. Add provider capability/quota/error contracts and broker-bypass negatives. Keep Computer MCP unavailable until controlled-device proof; keep `dani-free` absent from claims; block unattended high-impact Hermes native terminal/filesystem/network effects until broker enforcement is proven.
8. Offline/recovery and controlled Windows WD/EF/PI/DL/EV/FG gauntlets. Keep the Windows slice `IMPLEMENTED_UNVERIFIED` until a real Windows device produces source-linked proof.

Do not claim runtime/effects, memory/proactivity, CUA, provider, Laya or voice compliance until the mapped acceptance gates pass. The next application branch should begin with stages 1-2, preserve the existing skeleton, and avoid infrastructure-owned workflows/build/release paths.
