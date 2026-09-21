# 002 Hermes adapter

Status: PARTIAL. Owner: Hermes gateway.

## Intent
Make one pinned Hermes ACP integration the default general-purpose reasoning runtime while DANI retains job, policy, effect and verification authority.

## Requirements
- HA-001: persist stable mapping among job, DANI session, thread and provider-native cursor.
- HA-002: support streaming events, interruption, approvals, typed tools and capability discovery.
- HA-003: resume after restart without mutating Hermes's own session database.
- HA-004: deny consequential tools when broker enforcement is absent.
- HA-005: provider metadata includes modality, structured/tool support, context, auth, quota/cost, timeout, retry and circuit state.
- HA-006: unavailable or malformed Hermes responses settle jobs truthfully.
- HA-007: legacy providers remain independently configured; no unverified `dani-free` fallback.
- HA-008: Hermes is pinned to a reviewed version/source with license provenance; install and protocol compatibility are reproducible.
- HA-009: runtime capability metadata comes from observed ACP/provider behavior, not optimistic static claims; unverified Computer MCP remains unavailable.
- HA-010: built-in terminal/filesystem/network paths cannot bypass the DANI ledger for unattended high-impact effects; if enforcement is unavailable, autonomous high-impact mode is blocked.
- HA-011: provider errors are typed for quota, region, auth, capability and retry eligibility; failover never creates unapproved cost.
- HA-012: stop, cancel and status have a deterministic no-model path that remains available when Hermes and Laya are offline.
- HA-013: serving-path wiring, session ownership, delegation and cancellation are durable across restart; library-only modules do not count as integrated.

## Acceptance
- A serving-path test proves the live server imports and invokes the DANI control plane rather than only exercising library fakes.
- Real pinned `hermes acp` tests cover handshake, ordered streaming, model confirmation and mismatch, fail-closed permission selection, cancellation, process-resume cursor and capability discovery. Computer MCP requires a controlled-device result before it is advertised.
- Measure per-turn spawn versus one supervised warm process on the low-resource Windows profile. Record the baseline and decision; do not invent a budget. Concurrent turns remain isolated and orphaned children are reaped after server failure.
- Every registered provider emits an explicit capability record for modality, tool calls, structured output, context, auth, quota/rate-limit state, price class, timeout, retry and failover. Unknown values are unavailable, not silently supported.
- Quota exhaustion cannot auto-route to a paid provider; text-only plus image fails before dispatch; provider loss blocks only the affected task; BYOK works without `dani-free`; legacy local-host aliases remain unchanged.
- Parent cancellation propagates to durable child delegations, depth is bounded and child effects require the same broker authorization.
- Broker-bypass negatives prove Hermes native terminal/filesystem/network tools cannot elevate Auto/Ask into unattended high-impact effects; until then those operations are blocked.
A known request reaches Hermes once, streams correlated progress, survives a DANI restart using its stored cursor, and cannot bypass a denied effect through terminal/browser/network alternatives. Interrupt settles the same job and no other session. Capability mismatch is reported before dispatch.

Current mapping: `server/drivers/acp/hermes.ts`, `server/hermes-runtime.ts`, provider contracts. Missing before DONE: live serving-path wiring, pin/license/protocol record, real ACP tests, warm-instance decision, broker enforcement proof, deterministic no-model controls, durable restart/delegation/cancel E2E, and provider capability/quota contract. `dani-free` is absent and must not be claimed.
