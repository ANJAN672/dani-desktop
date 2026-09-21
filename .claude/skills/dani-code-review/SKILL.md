---
name: dani-code-review
description: "Use after each vertical slice to perform separate spec-compliance, security, performance and maintainability reviews before PR or release."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Read approved spec, constitution, ADR and exact diff; do not review against imagined requirements.
2. First pass: spec compliance, unimplemented ACs and accidental feature regressions. Second pass: code clarity, contracts, data ownership, race conditions, error handling and unused abstractions.
3. Security review: shell/net bypass, secrets logging, approval scopes, user isolation, injection. Performance review: new startup dependencies, context inflation, long-lived tasks and per-call model loads.
4. Classify findings BLOCKER/HIGH/MEDIUM/LOW with path/line, reproduction and recommended fix; avoid unsupported opinions.
5. Fix issues in scoped commits, add regression tests and retest. Independent reviewer cannot claim verification if no tests run.
6. Confirm licenses, NOTICE, code provenance and no hidden installs. Provide concise merge/no-merge recommendation based on evidence.
**Gate:** BLOCKER/HIGH unresolved => no production release.
