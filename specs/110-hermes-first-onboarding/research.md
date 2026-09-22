# Research - Hermes-first seamless onboarding

Baseline: `d0a456ba85b0359c90d742d67d89890e0e27bbc5`, tree `143bada9b2a078256997bae8cdd5e7f1365e55a4`.

## Verified code map

- `src/components/Onboarding.tsx` renders the engine matrix and optional `PhoneSetupFlow`.
- `src/components/EngineSetup.tsx` renders external install commands and setup links.
- `src/components/ModelPicker.tsx`, `ChatView.tsx`, and `SettingsPanel.tsx` expose model/setup surfaces.
- `server/drivers/acp/hermes.ts` pins Hermes but currently probes an external CLI and advertises shell installers.
- `server/dani-default-runtime.ts` selects Hermes and fails closed rather than choosing another harness.
- `server/laya/service.ts` needs a nonblocking real-model verification lane; Laya remains default-off.

## Decisions and unknowns

The approved architecture is bundled payload plus verified atomic first-launch activation and later verified update. Runtime-ready and model-ready are separate. Actual Hermes/OpenCode redistributable artifacts, license obligations, per-target size, and protocol probes remain blocking inputs to R-BOOT-001; no placeholder artifact is permitted.
