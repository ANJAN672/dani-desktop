---
name: dani-test-driven-implementation
description: "Use for every production code change to enforce RED-GREEN-REFACTOR, contract tests, regression tests and reproducible evidence."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Confirm approved spec, exact acceptance ID and baseline; inspect code and test tools before editing.
2. Write meaningful failing test (integration where contract matters); run and capture RED for the intended reason.
3. Implement minimum maintainable behavior with correct error contracts and feature flag. No mock of the very component being validated in the decisive E2E test.
4. Run GREEN focused test, adjacent regressions and static checks; refactor and re-run. Ensure UI and backend both functional where applicable.
5. Check cancellation, timeouts, retries, restart, unsupported provider and unauthorized bypass negative cases.
6. Produce traceability evidence and independent spec-compliance then code-quality review. Commit scoped diffs only when authorized.
**Forbidden:** skipping failing baseline, making tests tautological, swallowing errors, calling mock success production readiness.
