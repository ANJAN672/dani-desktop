---
name: dani-release-verification
description: "Use after implementation before claiming done, publishing an installer, pushing a PR, or marking an architectural milestone complete."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Read specs, traceability, handoff and all test logs. Run reproducible build, tests, lint/typecheck, dependency/licensing scan and security negatives.
2. Verify real target OS artifact and one end-to-end user workflow; do not infer Windows working from Linux CI or Android client from desktop app.
3. Compare release performance/idle resource budgets with baseline. Record environment, samples and P50/P95; fail gate if unmeasured where required.
4. Test upgrade/downgrade, data migration, rollback, settings/provider preservation, consent and feature flags.
5. Ensure legal attribution/NOTICE, SBOM, signing where appropriate, no leaked tokens, accurate release notes and existing user data migration.
6. Prepare `docs/handoff/latest.md` with exact git revision, commands/results, known blockers, evidence and next task. Push/merge only with actual authorization.
**Done means:** independently reproducible evidence; no unsupported success statement.
