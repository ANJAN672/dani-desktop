<!-- One concern per PR. Behavior-changing work requires an approved issue/spec. -->

## What changed and why

## Spec traceability

- Requirements:
- Tasks:
- Acceptance rows and minimum evidence class:
- Baseline `main` SHA/tree:

## Exact file map and rollback

## RED/GREEN and impacted validation

<!-- Commands, exit codes, immutable run URLs, artifact hashes, OS/device. Classify evidence honestly. -->

## Independent critic/review

<!-- Malformed input, stale state, concurrency, restart, legacy data, authorization, platform, and real-serving-path attacks. -->

## Screenshots/video for visual changes

## Checklist

- [ ] `pnpm sdd:check`, `pnpm typecheck`, and impacted tests pass
- [ ] No task introduces behavior absent from the approved spec
- [ ] Server behavior changes have real contract/serving-path tests
- [ ] No `dist-server/` edits or generated/fake production evidence
- [ ] No secrets in logs, responses, events, argv, artifacts, or Hermes config
- [ ] Platform-specific code is gated; no remote shell installer or unsafe string-built command
- [ ] Migration, rollback, residual risks, and claims still UNVERIFIED are explicit
