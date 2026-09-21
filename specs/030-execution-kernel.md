# 030 - Crash-safe execution kernel around the real Hermes turn path

Source: https://github.com/somdipto/dani-desktop/issues/11 (EPIC 3/6). Phase P2.

## Status ledger

- LANDED in unified prod `bdb92da` (prerequisite chain verified):
  - Slice 1 `745542a` - versioned SQLite kernel repository: WAL, FULL sync,
    backup-before-migrate, fail-closed downgrade; durable job/effect/approval/
    evidence/event ledgers; idempotency keys; approval state fencing; cancellation
    generations; restart reconciliation; crash tests + runbook. Validation: kernel
    overlap 14/14, adversarial 10/10, typecheck, Electron 137/0/0.
  - Slice 2 `b7449de` - `HermesKernelTurnService` over the real ProviderAdapter
    `sendTurn`/`interruptTurn`/`onEvent` contract: durable generation check before
    launch and on every callback, session cursor resume through the kernel
    boundary, exact-turn timeout interrupt, cancel semantics (generation increment,
    pending rejection, Hermes interrupt, stale completion ignored), provider
    failure/uncertainty never verified. Validation: 70/70 (kernel + Hermes
    boundary + real ACP driver contract suite), typecheck, oxlint clean.
  - Slice 3 `d2a03ee` - adapter execution service: approval/idempotency/generation
    fences, durable dispatch marking before the adapter call, external-reference
    inspection before evidence/completion, ambiguous-failure uncertainty marking
    (suppresses auto-retry), read-only reconciliation that never re-executes.
    Validation: 23/23 kernel tests, typecheck, oxlint clean.
  - Slice 4 `a0a3d4d` - redacted diagnostic projection for UI/diagnostics:
    terminal state, generation, provider correlation, effect/approval/evidence
    digests; omits objective and normalized inputs; critic-verified secret-like
    key redaction. Validation: 25/25 kernel tests, typecheck, oxlint clean.
- Remaining:
  - Mount the kernel behind the typed serving layer (depends on spec 020 seam)
    and delete/retire the dormant shadow control-plane files per spec 020 R7.
  - Slice 5 `c3994d6` landed the `DaniExecutionKernel` application boundary and a 20-clean-profile in-process vertical gate with zero duplicate external writes. The installed-app packaged gate remains.
  - End-to-end structured correlation IDs on the serving path:
    user request -> turn -> job -> effect -> approval -> adapter evidence.
  - Hermes version/protocol/license pinned, documented, contract-tested.
  - Explicit test that memory/context cannot create permission.
  - UI terminal states: completed / failed / cancelled / uncertain, fed by the
    slice-4 diagnostic projection.
  - Redacted structured events/metrics emitted on the serving path (admission,
    first progress, provider call, approval wait, effect attempt, evidence
    inspection, cancellation, recovery, duplicate prevention, terminal state).

## Requirements (domain model, from issue #11)

R1. Job ledger: owner, objective, status, attempt/generation, provider/thread
    cursor, timestamps, cancellation reason.
R2. Effect ledger: stable idempotency key, tool/adapter, normalized input digest,
    risk class, approval provenance, attempt state, external reference,
    inspection evidence.
R3. Approval grant: exact user, scope, resource/audience, limits, expiry,
    originating request, decision.
R4. Evidence: adapter-authored, inspectable, with source timestamp/reference -
    never model-authored prose.
R5. Cancellation: one token/generation fences provider, tools, queued retries,
    stale callbacks, delegated work.
R6. Recovery: running/unknown work reconciled on restart before any retry; an
    uncertain effect is never repeated.
R7. Hermes is a replaceable adapter: it plans and proposes but cannot write
    ledgers, answer approvals, bypass capability checks, or declare verified
    completion.

## Design contract

- Keep/refine: `server/contracts.ts`, provider registry,
  `server/drivers/acp/core.ts`, `server/drivers/acp/hermes.ts`, ordinary
  message/thread persistence, approval cards.
- Kernel modules live behind the typed application layer from spec 020. The
  landed slices 1-5 are that kernel; mounting = wiring the serving routes through
  `HermesKernelTurnService` and the adapter execution service instead of the old
  direct path.
- Vertical slice (required first, from an installed app):
  1. user asks for one browser/computer task;
  2. Hermes proposes a plan/tool request;
  3. Dani admits a durable job and effect;
  4. irreversible action pauses for a clear approval;
  5. approved effect executes exactly once;
  6. adapter inspects result and records evidence;
  7. user can interrupt at any point;
  8. process killed/restarted recovers without duplicate effect;
  9. final answer distinguishes completed, failed, cancelled, uncertain.

## Acceptance criteria (binary; from issue #11, mapped to slices)

- [x] Versioned SQLite migrations, WAL, backup-before-migrate, downgrade/restore
      runbook. (slice 1 - verified on merge)
- [x] Every external effect has a durable idempotency key and approval provenance
      before execution. (slices 1+3 - verified on merge)
- [ ] Memory/context cannot create permission. (explicit test still owed)
- [x] Model/provider cannot mark effects or jobs verified without adapter
      evidence. (slices 2+3)
- [x] Cancellation fences future effects, queued retries, stale callbacks, and
      provider continuation. (slices 1+2+3)
- [x] Crash-point tests cover before dispatch, after dispatch/before persist,
      after external success/before inspect, during retry. (slice 1 crash suite)
- [x] Restart reconciliation never performs an uncertain write twice. (slices 1+3)
- [x] Real Hermes/provider timeout, failure, interruption and session-recovery
      tests exist. (slice 2, real ACP driver contract suite)
- [ ] One packaged-app vertical slice completes 20 consecutive clean-profile runs
      with zero duplicate effects and no manual database surgery.
- [x] Completion exposes inspectable evidence in UI/diagnostics. (slice 4
      projection built; UI wiring verified at mount)
- [ ] Hermes version/protocol/license pinned/documented and contract-tested.

(Checkmarks mark criteria the built slices claim; every one is re-verified on the
merged unified prod before P2 closes.)

## Test gates

Kernel unit/contract suites (already per-slice); crash-point matrix; restart
reconciliation; real ACP driver contract; packaged vertical slice 20-run gate;
typecheck; lint; Gauntlet critic per slice; full repo suite green on the merged
candidate.

## Non-goals

- No multi-agent delegation, Laya routing, background autonomy, or proactive
  triggers until this spec's gates pass (spec 060 depends on P2).
- No second control plane beside the real serving path.

## Dependencies

P0 (merge), spec 020 typed seam for the mount, spec 010 owner capability on
mutation routes.
