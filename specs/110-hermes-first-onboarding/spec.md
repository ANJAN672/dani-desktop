# 110 - Hermes-first seamless onboarding

Status: APPROVED
Issue: https://github.com/somdipto/dani-desktop/issues/18
Baseline: `d0a456ba85b0359c90d742d67d89890e0e27bbc5`

## Requirements

### R-BOOT-001 - Per-target feasibility before packaging
WHEN a desktop target is prepared, THE SYSTEM SHALL prove pinned Hermes and supporting OpenCode payload availability, redistribution terms, architecture, hashes, executable probe, package-size impact, offline behavior, and supported OS before the target can ship.

### R-BOOT-002 - Trusted atomic activation
WHEN bundled runtimes activate, THE SYSTEM SHALL verify an authenticated manifest, reject unsafe archives and permissions, use a versioned locked atomic install, preserve the last verified runtime, and survive cancellation, crash, disk-full, denied ACL, antivirus, and concurrent launch.

### R-RUNTIME-001 - Offline runtime payloads
WHEN a released installer is installed without network access, THE SYSTEM SHALL contain compatible pinned Hermes and OpenCode runtime payloads for that target.

### R-RUNTIME-002 - Zero-step preparation
WHEN Dani first starts, THE SYSTEM SHALL verify and activate runtimes without Terminal, shell pipelines, administrator access, global PATH mutation, npm, or pip.

### R-RUNTIME-003 - Honest recovery
WHEN activation fails or is interrupted, THE SYSTEM SHALL preserve the prior verified runtime, report a stable safe error, and offer idempotent repair or limited mode.

### R-RUNTIME-004 - One harness
WHEN Dani dispatches a production bot, THE SYSTEM SHALL use Hermes as its sole harness; OpenCode is a supporting model route and never a competing chooser.

### R-UI-001 - No harness choice
WHEN a release user completes onboarding or opens ordinary bot settings, THE SYSTEM SHALL NOT show an engine matrix, manual Hermes install command, Terminal action, or non-Hermes harness choice.

### R-UI-002 - Truthful preparation
WHEN runtime preparation is not ready, THE SYSTEM SHALL show source-grounded progress/error/repair state and SHALL NOT enable a real turn before a live readiness probe succeeds.

### R-UI-003 - Pairing preserved
WHEN onboarding reaches device setup, THE SYSTEM SHALL keep QR pairing optional, skippable, and resumable from Remote access.

### R-MODEL-005 - Free is not ready
WHEN a free/open/local model is considered, THE SYSTEM SHALL independently verify model health, task capability, account/quota, billing class, and current availability; missing free capacity SHALL NOT silently spend or select another harness.

### R-SEC-001 - Write-only on-device credentials and scoped computer use
WHEN the owner saves a provider credential or a bot uses a computer, THE SYSTEM SHALL keep long-lived keys in the trusted on-device credential path, expose status only, and require a scoped brokered computer capability for both Hermes and the optional Laya-routed CUA path.

### R-PRIV-001 - Local profile independent of telemetry
WHEN profile data is saved locally, THE SYSTEM SHALL keep account, waitlist, and telemetry operations separate, consented, retryable, erasable, and nonblocking.

### R-LAYA-005 - Optional nonblocking inference
WHEN Laya is installed or queried, THE SYSTEM SHALL use a supervised bounded worker outside the request-serving event loop and SHALL fall back to Hermes through the same job on unavailable, slow, uncertain, or invalid output.

## Acceptance criteria

- AC-BOOT-001 requires PACKAGED and CLEAN_MACHINE evidence for every published target.
- AC-RUNTIME-001 requires REAL_SERVING_PATH evidence for Dani to managed Hermes readiness.
- AC-UI-001 requires VISUAL and PACKAGED evidence that no harness chooser/manual command remains.
- AC-MODEL-001 requires LIVE_PROVIDER evidence and a no-charge trace.
- AC-PAIR-001 requires PACKAGED QR pairing evidence.
- AC-LAYA-001 requires REAL_SERVING_PATH latency/reliability ablation before default enablement.

## Non-goals

No domain/DNS change, silent Laya weight download, paid fallback, second orchestrator, or claim that runtime-ready means model/task-ready.
