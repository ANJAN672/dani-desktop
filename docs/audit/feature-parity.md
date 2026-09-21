# Feature parity and preservation matrix

| Existing behavior | Preservation rule | Current evidence | Next proof |
|---|---|---|---|
| Chat, onboarding, settings and accounts | Preserve UI and stored data formats | Existing source and broad platform tests | Visual regression on packaged Windows build |
| Provider/model selection | Keep legacy providers; make Hermes the internal default without deleting choices | Config/Hermes tests | Provider capability matrix and unavailable-state UX |
| Browser and computer surfaces | Route through one authorization/effect contract | Existing browser/CUA plus typed bridge | Controlled download vertical slice |
| Delegation and rooms | Preserve bounded existing flow while mapping new jobs/sessions | Existing and new delegation tests | Crash/restart integration test |
| Routines/proactivity | Preserve schedules; add freshness, novelty and quiet-hours gates | Partial source/tests | Event-to-job-to-verified-effect E2E |
| Memory | Keep transcript source of truth; derived sidecar is revocable and attributed | Sidecar tests | Deletion and contradiction E2E |
| Voice/calls | Preserve current call UX; separate speech interruption from task cancellation | Duplex unit test and existing call tests | Native Windows STT/TTS and echo test |
| Android/iOS companions | Do not claim desktop-runtime parity | Platform CI | Signed client compatibility smoke |
