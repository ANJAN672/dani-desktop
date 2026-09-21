# 040 - Truthful providers: setup, connectivity, cost, migrations, errors

Source: https://github.com/somdipto/dani-desktop/issues/12 (EPIC 4/6). Phase P5.

## Status ledger

- Done: partially addressed in current work (exact landed scope to be reconciled
  against tracker #15 before P5 starts). Existing behavior to preserve: the
  default runtime correctly fails closed to Hermes; no silent paid fallback.
- Remaining (verified defects from the issue):
  - `EngineSetup.tsx` classifies via `snapshot.state !== "available"`;
    `ModelPicker.tsx` renders failures as "Not installed"; sign-in/error
    distinctions unreachable or misleading.
  - API key, voice/transcription and VPS surfaces infer "Connected" from a
    stored value/alias instead of live verification.
  - `server/index.ts` dereferences `bot.modelSelection.instanceId` where
    `modelSelection` can be absent: two intended 409 paths can throw TypeError
    and become 500.
  - Persistence/schema evolution needs versioned migration/read-path handling.

## Requirements

R1. One typed health/connectivity contract shared by server and UI, with states:
    `absent | saved-unverified | verifying | healthy | degraded | invalid |
    expired`, plus `checkedAt`, safe user-facing reason, retry action, credential
    source (never value), and capability/model catalog freshness.
R2. "Connected" is reserved for a recent successful verification appropriate to
    the dependency.
R3. Provider errors map into install, authentication, authorization,
    quota/billing, network, protocol/version, unknown.
R4. Per-bot explicit provider/model selection showing local/free/metered class
    and current source/check time for any pricing note.
R5. Fail-closed preserved: an unavailable chosen provider never silently falls
    back to another paid provider; expose why no model is available.
R6. Versioned bot/config migrations normalize every readable bot record's
    `modelSelection` to `selected`, `unconfigured`, or migration error.
R7. Both missing-selection 500s fixed; all record dereferences audited for
    legacy data.
R8. Standard errors: stable code, HTTP status, safe message, retryability,
    correlation ID.

## Acceptance criteria (binary; from issue #12)

- [ ] No UI displays "Connected" solely because a key, alias or config object
      exists.
- [ ] Health states include last verification time and distinguish absent, auth,
      quota, network and version failures.
- [ ] Engine setup never labels an auth/API/network failure "Not installed".
- [ ] Sign-in-required and install-required paths are both reachable and tested.
- [ ] No metered provider is selected implicitly; first metered use requires
      explicit consent (spec 010 R8).
- [ ] Legacy/malformed bot records cannot cause 500s; deterministic migration or
      4xx recovery guidance.
- [ ] Missing `modelSelection` tests cover both known dereference sites plus
      persisted legacy fixtures.
- [ ] Connectivity tests use real adapter contract fixtures and at least one
      live staging verification per supported provider before release.
- [ ] Settings changes invalidate/reverify health; no stale "healthy" state.
- [ ] User-visible errors include actionable recovery without leaking
      credentials/provider internals.

## Test gates

Contract fixtures per provider; migration fixture suite (legacy/malformed
records); UI state-rendering tests per connectivity state; one live staging
verification per supported provider; typecheck; lint; Gauntlet critic per slice.

## Non-goals

- A green stored-config flag is not verification.
- No provider fallback logic.

## Dependencies

Spec 010 R8 (metered consent) for the consent flow; feeds spec 070 (the picker
renders these truthful states) and spec 090 (no fake "Connected" in the demo).
