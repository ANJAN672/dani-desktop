# DANI unified runtime and Goal Autopilot

Status: architecture specification, not an implementation claim. Baseline: `main` at `956e10590b6541fbe6eb320e94637346d84b128d` (2026-09-06). Owner: DANI. Date: 2026-09-20.

## Problem and scope

Today the application contains a harness registry and event bus that launch external provider-owned agent processes. Its normalized `RuntimeEvent` contract and UI are valuable; a driver that invokes Claude/Codex/Grok is not itself a model-independent DANI reasoning/tool loop. Separately, `RoutineManager` owns scheduled jobs and `group-goal-run.ts` implements bounded, conversation-led team goals. Neither makes an independently persisted outcome continuously actionable across many wakes. The user should see one DANI runtime and choose only a permitted inference/account connection.

In scope: native DANI execution loop, BYOK, optional authorized account-backed specialist execution, tool/permission/skill portability, durable goals, event ingestion, scheduling, audit/evidence, outcome verification, and proactivity evaluation. Out of scope: voice, computer-use driver, implementation of the separate DANI-Free proxy, generic Claude/ChatGPT subscription token extraction, copying Hermes/OpenClaw whole runtimes, and any release claim without tests.

## Architectural decisions

1. DANI owns exactly one task lifecycle, conversation store, tool registry, permission broker, event stream, and runtime API. The UI never selects a harness. Internally, `InferenceBackend` and `DelegatedSpecialist` are separate typed contracts; the latter is not misrepresented as native inference.
2. Implement the native agent loop before removing old driver code. Keep a migration flag and test both paths with the same external behavior. Cut callers to the new runtime, then delete dead driver UI, provider-owned orchestration and unused code. Preserve histories, approvals, computer, messaging, and connectors.
3. BYOK must work with no `danlab/dani-free` configured. Support API-key based, officially supported inference endpoints with explicit tool/streaming/capability detection and redacted logs. The separate proxy plugs into this exact interface later. Failure to connect one provider must not disable others. No automatic paid fallback.
4. Codex account login is supported only through a documented, permitted Codex runtime/SDK integration. It is a delegated specialist because Codex owns its own nested loop; it must not replace the DANI main runtime. ChatGPT login is not a general API credential. For Claude, Claude API BYOK is the native path; any subscription-based Claude Code integration must remain within the provider's explicitly permitted surfaces and commercial conditions, and must not reroute third-party traffic through subscription limits or harvest tokens. If permission cannot be established, mark it unsupported instead of fabricating compatibility.
5. Reuse existing `server/harness/bus.ts`, `server/harness/registry.ts` and `server/contracts.ts` as migration seams. Retain `server/routines.ts` as schedule/run compatibility while gradually moving ownership to one durable job service; never run two competing schedulers for one commitment. Retain bounded room-goal coordination only as an execution primitive, not the durable source of goal truth.
6. All asynchronous work references a persistent `Goal`, `Commitment`, `Task`, `Wake`, and `ActionReceipt`. A goal is closed on verified criteria or explicit cancellation, not a model's textual claim that its turn is finished. A standing commitment has an owner and recurrence and cannot silently disappear. Separate a provider turn, a task, a workflow run, and a goal.
7. External input is untrusted. Parse provider output at the boundary. Every action is authorized against user, bot, goal, exact tool parameters, destination, expense ceiling, and current grant. Do not automatically approve mail, publishing, payment, destructive filesystem or host actions. Expired/revoked grants fail closed.
8. A durable job engine owns leases, crash reconciliation, per-tenant queues, timeouts, concurrency caps, retry classification, and an outbox. Postgres + DBOS is a candidate for cloud production, pending a spike proving restart recovery, deterministic workflow replay, and deploy burden. Do not require Postgres in a small local-only desktop install without an evaluated reason. Existing scheduler may remain the sole owner for a local first vertical slice.
9. Refix's proactive TypeScript primitives are a candidate for a bounded spike: custom `{name, run(input) => Promise<Transcript>}` adapter, goals, cadence, action governance, and durable store. Compare its production requirements (Postgres + BullMQ/Redis), license, action replay, tenant isolation, failure behavior, and ability to use the existing scheduler. Adopt selectively only if it removes more complexity than it adds.
10. Use Hermes as a reference for standards-based progressive skill disclosure (`skills_list` -> `skill_view` -> references), schedules and learning a reusable skill. Do not bundle its Python runtime or duplicate memory. Import engineering skills through DANI's existing approval-gated, SHA-pinned `SKILL.md` loader. Cursor-specific plugin instructions and model slugs must never be silently presented as executable DANI skills.

## Proposed domain model

```
Goal { id, ownerId, objective, successCriteria[], state, priority, deadline?, privacyScope, budget, createdAt, revision }
Commitment { id, goalId, triggerPolicy, enabled, nextWakeAt?, lastWakeAt?, followUpPolicy, revision }
Task { id, goalId, parentTaskId?, instruction, dependencies[], executionOwner, state, attempt, lease?, checkpoint?, verificationSpec }
Wake { id, commitmentId, triggerId, triggerType, snapshotRevision, state, createdAt }
ActionReceipt { id, taskId, tool, target, argumentsDigest, authorizationId, idempotencyKey, status, externalReference?, evidenceIds[] }
Evidence { id, taskId, kind, source, capturedAt, digest, observation, confidence?, verifiedBy }
Approval { id, taskId, userId, actionDigest, grantedScopes, expiresAt, state }
ModelConnection { id, ownerId, kind: 'inference'|'delegated-specialist', capabilitySet, authReference, status, costPolicy }
```

States: goal `active | waiting | blocked | verifying | completed | cancelled`; task `ready | running | waiting_approval | verifying | succeeded | failed | cancelled`; receipt `planned | authorized | dispatched | confirmed | uncertain | denied`. An uncertain externally executed action must be inspected/reconciled, never automatically repeated.

Index tenant + goal + active state, unique `(commitmentId, triggerId)` and `(taskId, idempotencyKey)`. Treat event payloads as immutable evidence with source timestamps. Store credentials only as secrets-store references, never in model context or event logs.

## End-to-end pipeline

```
Authorized sources (webhooks, scheduled deadline, manual, completion)
  -> authenticate and normalize event
  -> durable inbox, dedupe, sequence, correlation to commitments
  -> cheap policy and relevance filter (no LLM for every idle tick)
  -> load goal, last verified state, permissions and pending tasks
  -> select at most one next eligible task (or explicitly bounded parallel tasks)
  -> native DANI loop (inference -> structured tool proposal -> policy -> execute -> observe)
  -> independent result verifier + evidence and action receipts
  -> update goal, plan next action, commit next wake
  -> silence / concise update / approval request as justified
```

The native loop owns context budgeting, prompt injection boundaries, provider/tool-call IDs, streaming, cancellation, tool timeouts, error classification, bounded iterations, and checkpointing. Distinguish `task completed` from `goal completed`. The planner cannot grant permissions or mark external actions confirmed without evidence.

### Failure semantics

* Provider 429: retry/backoff within provider limits, choose alternative only within user-allowed providers and cost policy. Missing provider: mark task blocked, not whole app broken.
* Worker crashes after claimed action: recover durable run and inspect external receipt before continuing. For non-idempotent APIs without native keys, reconcile external state first.
* Duplicate webhook/clock jump/restart: unique trigger ID and single active lease yield one execution.
* Approval expires during sleep: action denied or approval re-requested, never promoted from a previous task.
* Unsupported tool schema/model: fail capability negotiation before execution, not after partial action.
* Notification delivery failure: outbox retries with message deduplication; internal task result does not falsely imply user saw it.
* Private/untrusted skill text or email instructs privilege escalation: reject it at tool boundary and record attempted injection.

## UX and API

Onboarding: `Use DANI-Free` only when proxy available; `Connect API key` works independently; `Connect supported account-backed specialist` shown only when authorized. UI offers model connection and cost settings, NOT harness selection. Chief of Staff is an identity/role using the same runtime as every other bot.

Proposed API: `POST /goals`, `GET /goals`, `PATCH /goals/:id`, `POST /goals/:id/wake`, `GET /goals/:id/activity`, `POST /approvals/:id/decision`, `GET /models/connections`, `POST /models/connections`. Authenticate all routes and enforce per-owner scopes. Reuse existing event SSE contract and add goal/wake/task event variants. Prefer idempotency-key headers on mutations.

Goal UI must show: objective and verifiable done condition, active task, latest evidence, last checked, next scheduled check, allowed actions and budget, pause/cancel, and why a notification was delivered. Default automation is opt-in. Quiet hours and no-change suppression are configurable. Owner can revoke every grant and delete/export goal history.

## Skill integration

Use the bundled skills' `manifest.json` and `SKILL.md` contract. Review source at pinned commit; import disabled by default, show full Markdown, SHA256 and license, and enable after user approval. The current external importer intentionally skips supporting files; never promise full pstack functionality or run Cursor-only `/poteto-mode` inside DANI. Build self-contained DANI-compatible skill adaptations for spec writing, TDD, architecture review, research and verification. Preserve upstream MIT notices for copied material. Engineering skills must never confer execution permissions.

## Testing and rollout

Use the established `docs/verification/README.md` isolated fixture, not real user state. Specifications and acceptance are behavior-level. Tests must include native BYOK-only chat + tool call + streaming and cancellation; invalid credentials; offline proxy; API cost ceilings; role permissions; request/reply IDs; script and tool injection; crash at each action boundary; restart with active goal; dedup across three duplicate webhooks; clock jump; late approval; external success with missing response; independent evidence-based completion; cross-user isolation; concurrent tasks; full audit provenance; provider downtime. No fake success messages.

Benchmark pinned OpenClaw 2.0 v2026.8.1 and an explicit current-stable build in matched isolated environments. Measure goal completion with evidence, duplicate side effects, recovery after kill -9, false proactive alerts, missed meaningful events, time to first action, cost per verified goal and approval-bypass count. Pre-register tasks, randomize order, report trials and confidence intervals; do not claim superiority without measured results.

Milestones with gates: M0 baseline and coverage matrix; M1 native loop + BYOK-only E2E; M2 old-driver cutover with parity and removal; M3 persisted goal/commitment state on existing scheduler; M4 event ingestion + verification + governance; M5 restart proof and optional DBOS/Refix decisions; M6 cloud/desktop continuity, UX, benchmark. Every milestone ends in tests and a working vertical slice. Voice, CUA and proxy remain separate repo integrations and enter later through typed contracts.

## Research and engineering references

Matt Pocock skills, pinned `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`: `to-spec`, `tdd`, `codebase-design`, `setup-matt-pocock-skills`; MIT license. https://github.com/mattpocock/skills

Cursor pstack, pinned repository `032be146865d973682535de75f2287da438550bf`: `architect`, `principle-model-the-domain`, `principle-make-operations-idempotent`, `poteto-mode`; MIT license. https://github.com/cursor/plugins/tree/main/pstack

Hermes skills architecture: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md

Proactivity SDK candidate: https://github.com/refixai/proactivity ; DBOS: https://docs.dbos.dev/typescript/programming-guide ; OpenClaw 2.0 automation baseline: https://docs.openclaw.ai/releases/2026.8.1/automations-and-scheduling

This is a decision specification, not proof that code, upstream skill installations, or benchmarks have run.