# Plan - Hermes-first seamless onboarding

Requirements: R-BOOT-001 R-BOOT-002 R-RUNTIME-001 R-RUNTIME-002 R-RUNTIME-003 R-RUNTIME-004 R-UI-001 R-UI-002 R-UI-003 R-MODEL-005 R-PRIV-001 R-LAYA-005

## Order

1. Prove payload/license/platform feasibility (R-BOOT-001).
2. Build manifest verification, locking, safe extraction, atomic activation, repair, and probe state machine (R-BOOT-002, R-RUNTIME-001..003).
3. Enforce Hermes-only production selection and supporting OpenCode route (R-RUNTIME-004, R-MODEL-005).
4. Replace the engine matrix with the `/api/runtime/bootstrap` product state while preserving limited mode and QR pairing (R-UI-001..003).
5. Separate local profile from account/telemetry and complete Laya's nonblocking lane (R-PRIV-001, R-LAYA-005).

## Bootstrap wire contract

`GET /api/runtime/bootstrap` is read-only source of truth. Owner-guarded JSON `POST /api/runtime/bootstrap` is idempotent start/resume/repair. States are checking, installing, ready, repairable-error, and blocked-error; phases are detect, verify-bundled, activate, and probe. Ready requires the pinned executable/version plus live ACP probe. Safe errors never expose commands, paths, stderr, or secrets.

## Rollback

Never replace a running runtime. Keep the last verified version and atomically move the current pointer only after probe success. UI changes must retain limited Settings/diagnostics/pairing when bootstrap is absent or failed.
