# 010 - Security stop line

Source: https://github.com/somdipto/dani-desktop/issues/9 (EPIC 1/6). Phase P1.

## Status ledger

- Done: nothing landed. The packaged-Electron secure path already in the codebase
  (`safeStorage`-backed `credentials.bin`, legacy plaintext scrubbing, restrictive
  file modes) and the fail-closed-to-Hermes default runtime are existing behavior to
  preserve, not completed criteria.
- Remaining: everything below.

## Requirements

R1. Every renderer and loopback client is treated as untrusted.
R2. Every renderer window runs the secure triad: `sandbox: true`,
    `contextIsolation: true`, `nodeIntegration: false`. The secondary viewer window
    in `electron/main.mjs` (~lines 1280-1297) is the in-repo reference; the main
    window (~lines 1766-1788) currently lacks explicit `sandbox`/`nodeIntegration`.
R3. The preload exposes only capability-specific IPC with runtime request/response
    schemas and origin checks. The current broad `window.ogb` surface contracts to
    classified capabilities.
R4. A per-launch owner capability is required on every state-changing route in
    every mode: packaged, dev, CLI, headless. Read-only health endpoints may be
    classified separately.
R5. A `SecretStore` abstraction replaces persistent plaintext credentials in every
    supported mode: OS keychain/`safeStorage` on desktop; managed backend or
    environment/fd injection (or fail closed) headless; an explicitly named,
    off-by-default, visibly warned insecure local-dev mode may exist.
R6. Legacy plaintext credentials migrate transactionally: import, verify encrypted
    write, scrub config, fsync/atomic replace, rollback preserved.
R7. `/api/cli-test` (~`server/index.ts:11260`) stops accepting caller-supplied
    executable paths. Fixed allowlist of discovered adapters; any custom path
    requires owner auth, canonicalization, explicit user selection, no-shell fixed
    argv.
R8. Provider metadata (`billingClass`, rate source/check timestamp,
    `requiresExplicitSelection`) exists, and the first metered call requires
    explicit provider/model/cost acknowledgement. Credential presence never
    chooses a paid default. The fail-closed-to-Hermes invariant is preserved and
    made explicit for all future providers.

## Design contract

- Implementation map per the issue: `electron/main.mjs`, `electron/preload.cjs`,
  `electron/*.test.mjs` bridge tests, `server/index.ts` request auth + settings
  mutation + `/api/cli-test`, `server/request-auth.ts`, `server/config.ts`,
  `server/dani-default-runtime.ts`, provider catalog/model picker UI, diagnostics
  and log-export redaction paths.
- Slice suggestion (one PR each): (a) window sandbox triad + bridge tests;
  (b) per-launch owner capability + route auth; (c) SecretStore + transactional
  migration; (d) cli-test allowlist; (e) provider metadata + first-metered
  acknowledgement.

## Acceptance criteria (binary; from issue #9)

- [ ] Main window has `sandbox:true`, `contextIsolation:true`,
      `nodeIntegration:false`; all app windows have an explicit policy.
- [ ] Packaged Electron smoke proves the sandboxed preload bridge still works.
- [ ] Every exposed IPC handler has schema validation, origin/window ownership
      checks, and a documented capability classification.
- [ ] A malicious renderer test cannot call raw Electron/Node APIs or invoke an
      unexposed channel.
- [ ] Every state-changing HTTP route requires the per-launch owner capability in
      desktop, dev, CLI, and headless modes.
- [ ] A separate local process cannot invoke `/api/cli-test`, mutate config, start
      work, answer approvals, or trigger effects without that capability.
- [ ] No supported production mode persists provider keys/tokens in
      `~/.danibot/config.json`, logs, diagnostics, argv, renderer state, or model
      context.
- [ ] Migration tests cover success, keychain unavailable, interrupted write,
      rollback, and legacy plaintext removal.
- [ ] Fresh install cannot make a metered provider request until the user
      explicitly chooses provider/model and acknowledges cost class/cap.
- [ ] Secret/cost/security tests run in CI and against an installed artifact.

## Test gates

Focused bridge/auth/secret tests per slice; typecheck; lint; packaged Electron
smoke; installed-artifact security test; Gauntlet critic per slice; independent
security review sign-off on renderer, IPC, loopback, secret, and provider-spend
boundaries before any external test build or production release.

## Non-goals

- No redesign of the full agent runtime.
- Do not claim OS encryption covers headless/dev paths.
- No demo-only authentication bypass.

## Dependencies

None. This spec gates P2's kernel mount (owner capability on mutation routes) and
any external distribution.
