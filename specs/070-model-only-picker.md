# 070 - Model-only picker (kill harness selection)

Source: founder directive 2026-09-21: "Remove all the options for choosing a
harness. There should only be the option of choosing a model. Harness we will
decide." Phase P5. NEW SPEC.

## Status ledger

- Done: `9aaa6e4` makes the production default fail closed to Hermes and removes
  the provider rail from the product model picker, leaving model choice only.
- Remaining: audit onboarding/settings/CLI for every residual harness-selection
  surface, migration of legacy persisted harness fields, truthful connectivity
  and metered-consent gates, and serving-bundle dead-code checks.

## Requirements

R1. No harness-selection UI anywhere: settings, setup wizard, bot configuration,
    onboarding, CLI flags exposed to end users. The product offers model choice
    only.
R2. The harness is fixed to Hermes at the product layer. This is a product
    invariant, not a hidden default: code paths that previously branched on a
    harness choice are collapsed to the Hermes path.
R3. The user picks provider + model per bot. The picker renders truthful
    availability using spec 040's connectivity states (no model shown as
    available that is not verified).
R4. Stored harness fields in bot/config records migrate out deterministically:
    versioned migration, no 500s on legacy records (joint with spec 040 R6/R7).
R5. Fail-closed preserved: no model available -> explain why; never silently
    fall back to another paid provider.
R6. First metered use requires explicit consent (spec 010 R8); the picker shows
    local/free/metered class.

## Design contract

- Remove the harness selector components and their state; delete dead branches
  (coordinates with spec 020's dormant-code deletion).
- Settings schema: `modelSelection` is the only engine choice persisted per bot.
- The kernel's Hermes adapter boundary (spec 030) stays replaceable internally -
  this spec removes user-facing choice, not internal modularity.

## Acceptance criteria (binary)

- [ ] No rendered UI surface offers a harness choice (component tests over
      settings, setup, bot config, onboarding).
- [ ] A grep/CI gate finds no live harness-selector code path in the serving
      bundle (dead code deleted, not just hidden).
- [ ] Model selection flows to the provider registry and produces an ordinary
      Hermes turn.
- [ ] Legacy bot records carrying harness fields load deterministically after
      migration (fixtures tested).
- [ ] Unavailable chosen model surfaces the truthful reason; no silent paid
      fallback.
- [ ] Metered model classes are labeled; first metered use asks for explicit
      consent.

## Test gates

UI component tests per surface; migration fixture suite; grep/CI dead-code gate;
typecheck; lint; Gauntlet critic attacks: leftover harness branches, legacy
record shapes, consent bypass, picker state after failed verification.

## Non-goals

- No new provider integrations.
- No Laya surface (Laya remains out of the V1 critical path entirely).

## Dependencies

Spec 040 (truthful connectivity states the picker renders), spec 010 R8
(metered consent), spec 030 (fixed Hermes path the picker drives).
