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

## E-BOOT-ACTIVATE-001 - trusted activation and recovery

- Requirement: R-BOOT-002, R-RUNTIME-001, R-RUNTIME-002, R-RUNTIME-003
  (partial evidence for AC-BOOT-001).
- Class: UNIT plus REAL_SERVING_PATH on a locally spawned server.
  **Not** PACKAGED and **not** CLEAN_MACHINE.
- Commands: `pnpm exec vitest run server/hermes-runtime.test.ts
  server/hermes-activation.e2e.test.ts scripts/prepare-hermes-payload.test.mjs`.
- Result: 41 passed. Covers the validation list issue 18 names for this
  service: manifest parsing, platform selection, digest and size mismatch,
  archive traversal/symlink/checksum/oversize rejection, interrupted
  activation, lock contention, rollback to the last verified runtime, and
  repair. The end-to-end cases boot a real server and assert it resolves the
  runtime to an absolute managed path, reports a failed verification as its own
  cause, and reports a missing payload as a blocked state offering limited mode.
- The archives are built inside the tests from real gzip and tar bytes, so the
  extractor is exercised rather than stood in for. The executable inside them is
  a placeholder: these tests never assert `ready`, because asserting readiness
  off a placeholder is the fake green criterion 12 forbids.
- What this does NOT prove: that a real Hermes payload exists for any target,
  that a packaged installer carries one, or that a clean machine reaches a
  usable app. No payload is staged in this repository; `dist-native/hermes` is
  empty and a packaged build will truthfully report that it carries no runtime.
  AC-BOOT-001 stays NOT DONE.

## E-UI-VISUAL-001 - first-run preparation screens, rendered

- Requirement: R-UI-001, R-UI-002 (partial evidence for AC-UI-001).
- Class: VISUAL, against the development UI driven in a real browser.
  **Not** PACKAGED, so AC-UI-001 remains NOT DONE.
- Method: a server booted against a throwaway home with a staged payload, the
  Vite UI at 127.0.0.1:5199 proxying `/api` to it, and the onboarding flow
  driven by clicking through it. Two runtime states were captured.
- Observed, digest-mismatch state: heading "Preparing Dani Bot", body "Dani's
  files failed their safety check and were not used.", actions Try again,
  Copy diagnostics, the code `runtime.digest-mismatch`, and Continue anyway.
- Observed, missing-payload state: "This installation is missing the files Dani
  needs. Reinstall Dani Bot to repair it.", no Try again button, code
  `runtime.payload-missing`, and Continue anyway.
- No engine matrix, install command, Terminal action or setup-guide link
  appears on any captured screen.
- Two defects were found by looking rather than by testing, and fixed:
  a blocked state offered a Try again button that could not work, and its
  supporting sentence still said "You can try again" after the button was gone.
- What this does NOT prove: anything about a packaged installer on any target,
  and nothing about the ready path, which needs a real runtime.

## E-UI-FLOW-001 - the whole first run, driven end to end

- Requirement: R-UI-001, R-UI-002, R-UI-003, R-PRIV-001.
- Class: VISUAL and REAL_SERVING_PATH against the development UI.
  **Not** PACKAGED.
- Method: a server booted against a throwaway home with a staged payload whose
  digest was deliberately wrong, the UI driven by clicking through every step.
- Observed, in order:
  1. Welcome step. Name and email typed, then the page reloaded: both came
     back, which is criterion 7's "input survives restart".
  2. Preparation step reported `runtime.digest-mismatch` with retry,
     diagnostics and Continue anyway. Retry re-ran and stayed on the same
     truthful state, because nothing had changed.
  3. The payload digest was then corrected on disk and an owner-authenticated
     repair was issued. It returned `installing` immediately, activated the
     runtime under its digest on disk, and the state moved to
     `runtime.absent`: activation succeeded and the placeholder does not
     answer, so readiness was still not claimed.
  4. Device pairing step present, optional, and stating it can be resumed from
     Settings and Remote access.
  5. Continue anyway reached the normal app in limited mode. The draft was
     cleared once onboarding finished.
- One gap was found and fixed: a settled error never re-checked, so a failure
  resolved elsewhere kept showing. The screen now also re-reads on window
  focus, matching the convention the removed engine step already used.
- What this does NOT prove: the ready path, which needs a real runtime, and
  anything about a packaged installer.

## Open blockers before issue 18 can close

Recorded here so the gap between "this branch is done" and "the issue is done"
stays explicit.

1. No runtime payload exists for any target in this repository, so acceptance
   criteria 1 and 3 cannot be demonstrated. T-BOOT-001 is unfinished: the spike
   reports linux-x64 proven, mac-arm64 and win-x64 built but unproven, and
   mac-x64 degraded.
2. No packaged or clean-machine run exists on any of the five published
   installer targets, which criterion 11 requires with pixel evidence.
3. The separate profile-save defect that criterion 8 requires to be linked has
   not been filed, so there is nothing to link and nothing to cover.
4. T-MODEL-001, T-PRIV-001, T-LAYA-001, T-UI-002, T-SEC-004 and T-CUA-001
   remain open, covering criteria 6, 7, 9 and 10.
5. CI has not run on this branch at all, and the base commit was already failing
   (audit finding AUD-01).

## Known-failing at this base

`pnpm test` fails on this base before any of these changes: `server/secret-store.test.ts`,
`server/cli-probe-guard.test.ts`, `scripts/install-commands.test.mjs` and two Electron
suites (17 failures reproduced on a clean tree at `74807af207498a18329d1627b2e8b3fcc9f955e4`). These are unrelated to spec
110 and remain open; see the issue 18 audit finding AUD-01.
