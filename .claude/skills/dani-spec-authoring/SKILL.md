---
name: dani-spec-authoring
description: "Use to turn each DANI milestone into unambiguous requirements, Given/When/Then acceptance, traceable tasks, and consistency analysis before implementation."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Read audit, product decisions, constitution, relevant ADR and current behavior. Write WHAT and WHY first; avoid asserting unverified implementation details.
2. Create `specs/NNN-slug/spec.md` using template. Include explicit req IDs, out-of-scope, unhappy paths, privacy, feature parity and performance baseline.
3. Turn each outcome into executable acceptance and negative tests, include idempotency, approval, restart and false-success cases.
4. Specify typed contracts, ownership, versioning, rollout and rollback in design/plan; mark all externally variable details as verification actions.
5. Create dependency-ordered small vertical-slice tasks with exact file locations only after inspecting repo. Map IDs to code/test evidence.
6. Run cross-artifact consistency analysis; reconcile contradictions before writing code. Mark unfinished checkboxes honestly.
**Output:** spec + ADR/design + plan + traceability + reviewer gate.
