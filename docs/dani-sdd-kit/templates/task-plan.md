# Tasks - Feature title

Baseline `main` SHA/tree:
Approved spec and plan:

```yaml
slice: S-NNN-01
base: <verified-main-sha>
requirements: [R-NNN-001]
files: [exact/allowlist]
blocked_by: []
produces: [observable-outcome]
validation: [focused-test, impacted-test, artifact-gate]
rollback: <reversal-strategy>
```

- [ ] T-NNN-001 [R-NNN-001] Exact task outcome, files, prerequisites, RED/GREEN evidence, critic cases, rollback, and parallel-safety decision.

No task may create behavior absent from the approved spec. No requirement may lack a task or explicit external blocker.
