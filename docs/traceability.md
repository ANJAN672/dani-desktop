# DANI requirement traceability

Truth labels: `VERIFIED` requires current test evidence on the named platform; `IMPLEMENTED_UNVERIFIED` means code exists but required acceptance evidence does not; `PARTIAL` and `NOT DONE` are not completion claims.

| Requirement | Design/contract | Current implementation | Required RED-first evidence | State |
|---|---|---|---|---|
| RC-001 durable owner-scoped job | ADR-001, spec 001 | `server/dani-control-plane.ts` | restart + workspace isolation | PARTIAL |
| RC-002 fenced transitions | spec 001 | basic transition checks | concurrent transition/lease race | PARTIAL |
| RC-003 full effect ledger | constitution §2, spec 001 | `server/dani-tools.ts`, bridge | immutable attempts + digest conflict | PARTIAL |
| RC-004 restart safety | spec 001 | incomplete | crash matrix + recovery sweep | NOT DONE |
| RC-005 cancellation | spec 001 | job cancel + Hermes interrupt | admission/lease/pre-dispatch/active attempt | PARTIAL |
| RC-006 canonical `UNKNOWN` | spec 001 | absent | ambiguous dispatch, reconcile-before-retry | NOT DONE |
| RC-007 policy budgets | constitution §5, spec 001 | `server/dani-policy.ts` | quiet-hour DST/coalescing + novelty/retry budgets | PARTIAL |
| RC-008 truthful progress | constitution §3, spec 001 | source links partial | stale-evidence rejection | PARTIAL |
| RC-009 intent + approval binding | spec 001 | incomplete | intent-before-dispatch + full fingerprint mutation | NOT DONE |
| RC-010 duplicate reconciliation | spec 001 | incomplete | one canonical duplicate result, no redispatch | NOT DONE |
| RC-011 cancellation fencing | spec 001 | incomplete | cancellation/dispatch concurrency | NOT DONE |
| RC-012 broker + desktop lease | ADR-001, spec 001 | typed boundary partial | broker bypass + durable fenced physical lease | NOT DONE |
| RC-013 fresh effect verification | constitution §3, spec 001 | evidence presence only | verifier rejects stale/unlinked evidence | NOT DONE |
| HA-001/003 Hermes lifecycle | spec 002 | `server/dani-kernel/hermes-turn.ts` | lifecycle/restart integration | PARTIAL |
| HA-002 typed provider boundary | spec 002 | Hermes ACP + typed bridge | provider contract suite | PARTIAL |
| HA-004 untrusted outputs | constitution §2/9 | quarantine partial | page/tool/file provenance + broker bypass gauntlet | NOT DONE |
| HA-005/007 provider claims | spec 002 | catalog partial | capability/quota/error matrix; no `dani-free` claim | NOT DONE |
| HA-008 pin/license | spec 002 | unpinned installer | reproducible pin + provenance + real ACP suite | NOT DONE |
| HA-009 truthful capabilities | spec 002 | metadata incomplete | observed handshake; controlled Computer MCP proof | NOT DONE |
| HA-010 broker bypass | constitution §2/9, spec 002 | Hermes native tools bypass ledger | unattended high-impact negative tests | NOT DONE |
| HA-011 quota/cost safety | spec 002 | errors mostly generic | typed quota/region/auth + no unapproved paid failover | NOT DONE |
| HA-012 no-model controls | spec 002 | live cancellation is in-memory | Hermes/Laya-offline stop/status/cancel | NOT DONE |
| HA-013 live durability | ADR-001, spec 002 | new runtime is library-only | serving import + restart/orphan/delegation E2E | NOT DONE |
| Memory lifecycle | constitution §6 | `server/memory-sidecar.ts` | isolation, delete/retention, correction/retraction, staleness | PARTIAL |
| Trigger/proactivity control | constitution §5 | skeleton only | registry/evaluator/wake/freshness/dedupe-window authorization | NOT DONE |
| Initiative levels | constitution §5 | absent | silent/inform/prepare/act + novelty/budgets | NOT DONE |
| Laya advisory-only | ADR-001 | `server/laya-shadow.ts` + `server/laya/shadow-scorer.ts` (gated, non-blocking) | measured shadow comparison | PARTIAL |
| Voice barge-in | constitution §4 | `src/lib/duplex-voice.ts` | native cross-platform E2E | IMPLEMENTED_UNVERIFIED |
| Windows controlled download | specs 001/002 | not wired | real-device WD/EF/PI/DL/EV/FG gauntlet + filesystem proof | NOT DONE |
| Offline/recovery | specs 001/002 | incomplete | offline and resumed recovery gauntlet | NOT DONE |
