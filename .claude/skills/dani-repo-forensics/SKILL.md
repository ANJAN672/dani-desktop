---
name: dani-repo-forensics
description: "Use before making any change to the existing DANI/OpenMausBot-derived repository, to audit code, branch, features, licenses, installed tooling and baseline tests."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Inspect `pwd`, `git status --short --branch`, `git remote -v`, latest commit, tracked directories and CI. Do not reset/overwrite user changes.
2. Identify package manager, executable entrypoints, apps, provider configs, Hermes integration, CUA, memory, voice, OS-specific binaries; create dependency graph from actual imports/processes, not guesswork.
3. Run smallest relevant baseline tests; preserve command/stdout/error evidence; label failures as pre-existing versus unknown.
4. Verify OSS versus separately licensed code, SPDX, NOTICE/SBOM and any restricted upstream directories. Preserve attribution and trademark boundaries.
5. Enumerate existing feature parity with working/tested/partial/missing status. Find actual bottleneck via trace before recommending a rewrite.
6. Produce `docs/audit/` artifacts and a short risk register. Do not modify prod code in audit phase.
**Stop gate:** No branch or license certainty, no destructive edits. Report exact blocker.
