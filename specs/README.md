# Dani Bot Spec-Driven Development Kit

One plan, one kit. Every area of the Dani desktop recovery has a numbered spec in this
directory. Any engineer can pick up any spec and execute it without asking for context.

- Audience: the founder and incoming engineers.
- Repo: `somdipto/dani-desktop`. Branch: `prod` only. Never target `main`.
- Source epics: GitHub issues #9-#14, tracker #15. Specs 010-050 and 100 restate those
  epics with landed/remaining ledgers; specs 060-090 are new and fill the gaps the
  epics do not cover (proactive experience, model-only picker, first-run install,
  demo script).
- Master sequencing: `000-master-plan.md`.

## Spec anatomy

Every spec has the same sections:

1. **Status ledger** - what is already done (with commit evidence) and what remains.
2. **Requirements** - numbered, testable statements of what must be true.
3. **Design contract** - the architecture the implementation must conform to.
4. **Acceptance criteria** - binary. Each is either provably true or not done.
5. **Test gates** - the exact checks that must pass before the spec is called complete.
6. **Non-goals** - what this spec explicitly does not do.
7. **Dependencies** - what must be true before this spec can finish.

## Working agreements (apply to every slice of every spec)

- **Branch per slice, PR into `prod`.** Small reviewable slices; no mixed feature work.
- **Commit identity:** all commits authored and committed as
  `Somdipto Nandy <somdiptonandy@gmail.com>`.
- **Delivery:** until a push-capable code route exists, each slice ships as a verified
  git bundle with SHA-256 and prerequisite recorded in tracker issue #15. A user-side
  engineer imports and pushes the named branch; the PR follows immediately.
- **Additive first:** new capability lands as new modules behind existing seams.
  Shared serving-path files are edited only inside the slice's declared map.
- **Gauntlet loop on every slice, no exceptions:**
  1. Builder implements the smallest coherent slice plus focused tests.
  2. Critic adversarially attacks correctness, malformed inputs, legacy data, stale
     callbacks/state, concurrency, security boundary, regression blast radius, and
     whether tests prove the real serving path.
  3. Fix all source-proven findings, rerun the critic and the full relevant matrix.
  4. Record what the builder produced and what the critic found/forced to change in
     the PR body. "Critic found nothing" requires listing the attack cases run.
- **Validation floor per slice:** focused tests, typecheck, lint/diff checks, and the
  relevant packaged/serving-path tests. Full repo suite must run to completion before
  a slice is promoted into the unified prod candidate (see master plan P0 gate).
- **Working product over green tests.** A criterion is done only when evidenced the way
  the criterion says: unit tests for units, the real serving path for serving claims,
  the installed artifact for install claims, physical hardware for audio claims.
  Test counts are never readiness evidence by themselves.

## Status legend

- **LANDED** - merged into the unified prod candidate, with commit ID.
- **BUILT** - slice complete and validated, in consolidation (not yet in unified prod).
- **ACTIVE** - workstream running, no complete slice yet.
- **OPEN** - specified, not started.
- **PARKED** - explicitly deferred by the founder; plan references but never schedules.
