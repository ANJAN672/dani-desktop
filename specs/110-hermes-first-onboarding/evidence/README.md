# Evidence index

Add immutable commit/tree, command or run URL, artifact hash/version, target OS/device,
verifier, timestamp, failure links, and waiver expiry where applicable. Never commit
secrets or large unredacted logs.

## E-UI-BUNDLE-001 - release renderer bundle carries no harness UI

- Requirement: R-UI-001 (partial evidence for AC-UI-001).
- Class: SOURCE + BUILD ARTIFACT. **Not** PACKAGED and **not** VISUAL.
- Base commit: `74807af207498a18329d1627b2e8b3fcc9f955e4` plus the working change under review.
- Command: `pnpm build && pnpm check:release-ui`.
- Result: 310 bundle files, zero forbidden strings. The check is wired into CI
  directly after the existing production UI build step.
- What this does NOT prove: that an installed app on any of the five published
  targets reaches a usable Dani Bot, that Hermes activates from a verified
  payload, or that any first-run screen renders correctly. AC-UI-001 stays
  NOT DONE until packaged and visual evidence exists.
- Verifier: change author, 2026-09-22. Unwitnessed.

## E-UI-UNIT-001 - first-run copy and readiness gating

- Requirement: R-UI-001, R-UI-002.
- Class: UNIT. Source-level only.
- Command: `pnpm exec vitest run src/components/Onboarding.test.ts server/runtime-bootstrap.test.ts server/dani-default-runtime.test.ts scripts/check-release-ui.test.mjs`.
- Result: 25 passed. Covers: preparation copy contains no harness vocabulary,
  readiness is never announced before the live probe answers, bootstrap state
  mapping including absent/version-mismatch/no-model/blocked, and production
  rejection of a non-Hermes selection.
- What this does NOT prove: real runtime activation or any live serving path.

## E-RUNTIME-LOCK-001 - a locked server refuses another harness over HTTP

- Requirement: R-RUNTIME-004 (partial evidence for AC-RUNTIME-001).
- Class: REAL_SERVING_PATH, on a locally spawned server. **Not** PACKAGED.
- Command: `pnpm exec vitest run server/product-harness-lock.test.ts`.
- Result: 3 passed. A server booted with `DANI_PRODUCT_HARNESS_LOCK=1` rejects a
  bot bound to a non-Hermes instance and an unresolvable instance, and still
  answers `GET /api/runtime/bootstrap` with safe copy.
- Negative control: the existing suite creates non-Hermes bots successfully on
  an unlocked boot, so the rejection is the lock and not a blanket failure.
- What this does NOT prove: behavior of a packaged Electron build, or that
  stale non-Hermes bot selections already on disk migrate. That migration is
  explicitly NOT implemented.

## E-RUNTIME-BOOT-001 - bootstrap contract on a live server

- Requirement: R-UI-002, R-RUNTIME-003.
- Class: REAL_SERVING_PATH, manual, on one Windows host with no Hermes present.
- Commands: `GET` and owner-guarded `POST /api/runtime/bootstrap`.
- Result: both return
  `{"state":"blocked-error","phase":"detect","code":"runtime.absent", ...}` with
  `canRetry` and `canContinueLimited` true. POST is idempotent and is refused
  without the owner header. No command, path or stderr appears in the response.
- This is the truthful state for that host: no Hermes is installed and Hermes
  still has no managed installer, so `blocked-error` is correct, not a defect.
- What this does NOT prove: the `ready` path. Proving it requires a real Hermes
  runtime; a fake Hermes fixture would be exactly the fake-green the
  constitution forbids as product evidence.

## Known-failing at this base

`pnpm test` fails on this base before any of these changes: `server/secret-store.test.ts`,
`server/cli-probe-guard.test.ts`, `scripts/install-commands.test.mjs` and two Electron
suites (17 failures reproduced on a clean tree at `74807af207498a18329d1627b2e8b3fcc9f955e4`). These are unrelated to spec
110 and remain open; see the issue 18 audit finding AUD-01.
