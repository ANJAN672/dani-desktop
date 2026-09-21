---
name: dani-laya-evaluation
description: "Use when adding Laya as an optional, versioned, locally or remotely hosted fast decision provider for DANI and evaluating whether it helps end-to-end."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Pin exact Laya checkpoint, hash/license and actual API, benchmark platform, CPU/GPU residency, loading cost and memory. General checkpoint performance is NOT evidence of DANI routing accuracy.
2. Define ONE narrowly versioned input schema with enumerated choices, `NONE_OF_THE_ABOVE` and abstention. Never allow decision output to authorize or directly invoke side effects.
3. Collect consented DANI decision traces with expected options, multilingual/OOD and adversarial variants; split development/test, annotate independently and document class distribution.
4. Run shadow inference initially. Report per-class accuracy/confusion, calibration, OOD/abstention quality, warm/cold latency, timeout rate, peak RAM and effect on VERIFIED task completion.
5. Compare against optimized Hermes-only and simpler rule baseline; only selectively enable canary with explicit rollback and safeguards. Model decision validity expires if state changes.
6. If failed/unavailable/stale/low quality, bypass Laya and continue Hermes. No feature should require Laya to ship first vertical slice.
**Done:** measured, narrow improvement, not a flashy ms-only claim.
