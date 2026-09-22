# Tasks - Hermes-first seamless onboarding

- [ ] T-BOOT-001 [R-BOOT-001] Produce per-target artifact/license/size/probe feasibility evidence; block absent targets.
- [ ] T-BOOT-002 [R-BOOT-002,R-RUNTIME-001,R-RUNTIME-002,R-RUNTIME-003] Implement and adversarially test trusted activation and recovery.
- [x] T-RUNTIME-001 [R-RUNTIME-004] Enforce Hermes-only release selection and migrate stale bot selections. Mutation-boundary rejection and deterministic boot migration landed; PACKAGED evidence still missing.
- [ ] T-MODEL-001 [R-MODEL-005] Implement live free/local capability and billing probes with no paid fallback.
- [x] T-UI-001 [R-UI-001,R-UI-002] Replace onboarding engine choice with the bootstrap status state machine. Bundle-level evidence only; AC-UI-001 still needs PACKAGED + VISUAL.
- [ ] T-UI-002 [R-UI-003] Preserve and verify QR pairing, skip, and resume.
- [ ] T-PRIV-001 [R-PRIV-001] Split local profile persistence from consented remote account/analytics work.
- [ ] T-LAYA-001 [R-LAYA-005] Move install/inference off the serving loop and validate real fallback/ablation.
- [ ] T-SEC-004 [R-SEC-001,R-UI-001] Keep Hermes as the sole default harness and expose separate write-only on-device OpenAI standard and Realtime BYOK credentials; never return long-lived keys to renderer state, logs, or `/api/config`.
- [ ] T-CUA-001 [R-SEC-001] Permit Hermes to use Dani's scoped brokered computer capability; optional/default-off Laya may route bounded computer-use candidates to the same guarded CUA executor, with abstention, OOD, timeout, or changed UI falling back to Hermes.
