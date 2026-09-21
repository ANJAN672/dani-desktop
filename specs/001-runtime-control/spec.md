# 001 Runtime control

Status: PARTIAL. Owner: DANI Runtime.

## Intent
Admit one versioned event into one durable job, expose exact status/pause/resume/cancel, dispatch typed effects only after policy, and finish only after evidence or explicit unknown reconciliation.

## Requirements
- RC-001: one `job_id`, owner namespace, state and cancellation token per task.
- RC-002: allowed transitions are enforced and audited.
- RC-003: effect intent records tool/resource, argument and precondition digests, approval scope, idempotency key, attempts and verification.
- RC-004: process restart recovers runnable jobs and never duplicates an ambiguous consequential effect.
- RC-005: `stop` prevents new dispatch immediately and requests active cancellation.
- RC-006: terminal states include `SUCCEEDED`, `FAILED`, `CANCELED` and `UNKNOWN`.
- RC-007: quiet hours, freshness, novelty, retry and resource budgets fail closed.
- RC-008: progress and final state are truthful and source-linked.
- RC-009: every consequential attempt persists intent before dispatch, binds approval to the full effect fingerprint, and stores immutable attempt history.
- RC-010: ambiguous dispatched effects enter canonical `UNKNOWN`; recovery reconciles current state before any retry.
- RC-011: admission, lease acquisition and dispatch all re-check cancellation under a fenced transition.
- RC-012: physical desktop work uses one durable fenced lease; page, tool and file output is untrusted provenance and writes cross only the typed broker.
- RC-013: success requires fresh source-linked verification, including filesystem evidence for download effects; evidence presence alone is insufficient.

## Acceptance
- Effect digest includes target, operation, canonical arguments, precondition hashes, approval scope and resource identity. A mismatch is a new effect, never an idempotent replay.
- Duplicate ingress and duplicate effect keys converge on one canonical result. Concurrent workers cannot advance the same fenced transition or physical desktop lease.
- Crash points before intent persistence, after intent/before dispatch, after dispatch/before acknowledgement and during verification produce safe, deterministic recovery. A dispatched but unreconciled consequential effect remains `UNKNOWN`.
- Cancellation is tested at admission, while waiting for a lease, immediately before dispatch and during an active attempt. It prevents every later dispatch while preserving truthful irreversible-effect status.
- The controlled Windows gauntlet covers WD (wrong/unsafe Downloads path), EF (effect failure), PI (process interruption), DL (duplicate launch), EV (evidence verification failure) and FG (fencing/lease conflict).
- Windows Downloads resolution uses the OS known-folder path, rejects unsafe traversal and verifies the final filesystem object from a fresh observation.
- Status vocabulary distinguishes `VERIFIED` from `IMPLEMENTED_UNVERIFIED`; no Windows slice becomes verified without evidence from a real Windows device.
Given a controlled browser-download fixture, when the process restarts after dispatch but before acknowledgement, then the recovered job reconciles file state before retry and records one real download. Given cancel during browsing, no new effect dispatch occurs and the UI distinguishes cancellation from an irreversible submitted effect. Given duplicate ingress, only one job/effect key is actionable.

Current mapping: `server/dani-control-plane.ts`, `server/dani-policy.ts`, `server/dani-tools.ts`. Missing before DONE: explicit `UNKNOWN` job/effect transition, precondition digest, recovery worker, physical-device lease, and end-to-end UI evidence.
