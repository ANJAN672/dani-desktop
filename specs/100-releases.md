# 100 - Signed, observable, rollback-safe cross-platform releases

Source: https://github.com/somdipto/dani-desktop/issues/14 (EPIC 6/6). Phase P7
(post-demo, specified now so earlier phases never contradict it).

## Status ledger

- Done: CI substrate exists (typecheck/tests/build/Linux packaging/smoke on
  prod); version tags are the intended release gate; legacy release artifacts
  stripped from README.
- Remaining: everything below. Repo has no tags, no Releases, no assets;
  Windows unsigned; macOS signing/notarization secrets not established.

## Requirements (from issue #14)

R1. Provenance/reproducibility: exact commit/tree, lockfile/toolchain, SBOM,
    build runner, artifact hashes recorded; clean clone reproduces build/package;
    branch protection requires security, typed-contract, packaged-smoke and
    migration checks.
R2. Installed-artifact matrix: fresh + upgrade installs on every claimed
    OS/architecture/format; first run, provider setup, ordinary turn, approval,
    browser/computer task, interrupt, restart recovery, update, downgrade,
    uninstall. Voice's physical matrix required only if voice is enabled.
R3. Signing/update trust: Windows code signing + timestamp; macOS hardened
    runtime + signing + notarization; update manifest/signature/HTTPS
    validation; never promote an unsigned artifact publicly; protected release
    secrets.
R4. Observability/ops: redacted structured logs, crash reporting, correlation
    IDs, exportable diagnostics; metrics for crash-free sessions, task success,
    first progress, approval wait, effect failure/duplicate prevention,
    cancellation, restart recovery, provider cost, voice; remote kill switch
    and feature flags for automation/effects/voice; support/incident/rollback
    runbooks with owners and severity rules.
R5. Staged rollout: internal -> 1% -> 10% -> 50% -> 100% with explicit
    thresholds and hold/rollback rules; cohort-only recovery build before broad
    release.

## Acceptance criteria (binary; from issue #14)

- [ ] Clean clone reproduces the exact artifact and emits commit/tree/
      toolchain/SBOM/hash attestation.
- [ ] Installed-artifact tests pass on every claimed OS/architecture.
- [ ] Windows and macOS artifacts verify signing/notarization before promotion.
- [ ] Upgrade migration backs up data; forced failure restores prior
      version/data; downgrade tested.
- [ ] Update and rollback drills succeed without manual file/database surgery.
- [ ] 20 consecutive clean-room runs of the narrow demo path pass across target
      OSes with zero duplicate effects (shared gate with spec 090).
- [ ] Redacted observability traces request -> job -> effect -> evidence via
      correlation ID.
- [ ] Canary thresholds and rollback triggers documented and exercised.
- [ ] Kill switches stop new effects and voice without corrupting active state.
- [ ] Release notes classify WORKING/BROKEN/UNVERIFIED and disclose limitations.
- [ ] Independent security and readiness audits pass the exact artifact
      released.

## Test gates

Signing verification in CI; installed-artifact matrix; migration/rollback
drills; canary drill; independent audits. Artifact upload is not a release.

## Non-goals

- CI does not substitute for signing, installed execution, rollback, or
  live-provider/device gates.

## Dependencies

All prior phases; consumes the spec 090 demo gate as its clean-room evidence.
