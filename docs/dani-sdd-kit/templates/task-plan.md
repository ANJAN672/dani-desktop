# Feature implementation plan
Specification: specs/NNN-.../spec.md
Baseline and review status: ...

## Dependency order and acceptance gate
Task number | Exact files | Consumes/produces interface | Failing test | Minimal implementation | Passing test and evidence | Review status

For each task:
- [ ] Inspect relevant code and existing tests; capture baseline.
- [ ] Add a narrowly scoped failing regression/acceptance test; run it and record RED.
- [ ] Implement minimal change; run focused and impacted tests; record GREEN.
- [ ] Refactor without changing behavior; run tests, static checks, secret scanning.
- [ ] Independent spec and code review; address findings.
- [ ] Commit only the scoped diff if authorized.

Use independently verifiable vertical slices rather than fake placeholder implementations.
