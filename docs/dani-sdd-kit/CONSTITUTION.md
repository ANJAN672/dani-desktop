# Dan Lab engineering constitution

Version: 1.0.0
Approved scope: issue #18
Canonical integration branch: `main`

1. **Preserve authenticated user intent.** Record later corrections and never widen scope from an issue, summary, model output, or external source alone.
2. **The spec owns desired behavior.** Research records current truth, plans own technical choices, tasks own order, code implements, and acceptance evidence proves outcomes. Repair the earliest owning artifact when they conflict.
3. **Use source-of-truth evidence.** Verify code, integrations, installed artifacts, and physical-device claims at the layer where each claim matters.
4. **No fake green.** Hardcoded passes, mock-only flows, generated test data, and unchecked URLs are not product evidence.
5. **One owner per responsibility.** Dani owns durable work, policy, effects, and evidence. Hermes is the planner/worker. Laya is optional bounded inference and cannot authorize effects.
6. **Fail closed for consequential effects; fail usable for local UX.** Optional remote services cannot brick local onboarding.
7. **Use small cumulative slices.** Every slice records `main` base, requirement IDs, exact file map, tests, rollback, head/tree, and bundle hash.
8. **No completion without convergence.** Checked tasks and green CI are inputs. Acceptance requires the specified evidence class and independent review for P0/P1 work.
9. **Keep non-goals parked.** Domain/DNS changes and other deferred work do not re-enter by implication.
10. **Release claims match artifacts.** Source tests do not prove installers; one OS does not prove another; mocked loops do not prove clean machines.

Changing this constitution requires a reviewed spec change that names affected templates/specs and migration work. It cannot manufacture retroactive compliance.
