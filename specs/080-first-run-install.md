# 080 - First-run install experience

Source: founder directive 2026-09-21 ("first-run install: one command, works
first try"). Phase P6. NEW SPEC.

## Status ledger

- Done: partial substrate - README install/build-from-source section exists and
  legacy download links were stripped (rebrand slices); bundled speech models
  ship checksum-pinned with the app. R1 landed: root install.sh / install.ps1
  (idempotent, --check gate, printed verified success check + actionable
  failures) documented verbatim at the top of README Quick start and pinned by
  scripts/install-commands.test.mjs, including stubbed-toolchain behavior tests.
- Done (continued): R2 consent half - first use of a metered model requires an
  explicit acknowledgement, gated server-side at the turn (409
  metered_consent_required) and confirmed in the model picker GUI; hermes
  models carry per-provider billing classes (2c/2c-ii). R6 substrate:
  uninstall residue contract documented in README, Windows uninstaller
  deletes app data (deleteAppDataOnUninstall), residue drift pinned by
  scripts/uninstall-residue.test.mjs; managed cloud-box names generate dani-
  and dual-accept pre-rebrand ogb- scoped names.
- Remaining: clean-VM execution of the install commands and uninstall steps
  per platform (needs physical machines - the harness and drift tests are in
  place; real artifact builds, uninstaller runs on clean macOS/Windows/Linux
  VMs are not yet run); R2 remainder (wizard first pixel truth), R3 first
  turn, R4 mic gate verification, R5 failure actionability sweep, upgrade
  migrations.

## Requirements

R1. One command per platform gets a user from nothing to a running app:
    documented at the top of the README, idempotent, with a printed success
    check.
R2. First launch opens a setup wizard that is truthful from the first pixel:
    provider + model setup using spec 040's connectivity states, explicit
    metered consent (spec 010 R8), no fake "Connected".
R3. The first real turn succeeds against the explicitly selected provider/model,
    or fails with an actionable reason - never a hang, never a silent fallback.
R4. Microphone permission is requested only when voice is enabled and gated
    (spec 050 investor demo rule); denied permission degrades gracefully to
    text with a truthful label.
R5. Every failure in install or first run is actionable: what happened, what to
    do, where logs are.
R6. Uninstall leaves no residue beyond the documented data directory.

## Design contract

- Install commands live in the README and are tested verbatim by CI scripts -
  docs and tests cannot drift.
- The wizard writes through the same typed config/migration path as settings
  (specs 020/040); no wizard-only persistence.
- Voice surfaces in the wizard only when spec 050 is fully gated.

## Acceptance criteria (binary)

- [ ] Clean-VM fresh install passes on macOS Apple Silicon, macOS Intel,
      Windows x64, Linux x64 (each claimed format): one command, zero manual
      steps, app launches.
- [ ] First-run wizard reaches a successful first ordinary turn against an
      explicitly selected provider on each platform.
- [ ] No surface shows "Connected"/"installed" without live verification.
- [ ] A metered provider cannot be used before explicit consent.
- [ ] Mic-denied path: text works, voice labeled truthfully.
- [~] Upgrade install over an existing data directory preserves data and runs
      migrations with backup. Migration writes (config browser-profile
      canonicalization, bots.json reference rewrite) now leave a one-time
      pre-migration sibling backup, covered by real filesystem fixture tests
      (server/upgrade-migration.test.ts). The packaged-installer upgrade run
      itself remains a physical clean-VM check.
- [ ] Uninstall verification: no residue beyond the documented data directory.

## Test gates

Clean-VM installed-artifact matrix (aligns with spec 100's matrix; Vite/dev
runs do not count); README-command CI test; migration/upgrade fixture run;
Gauntlet critic attacks: partial installs, interrupted first run, stale config
from older versions, permission-denied paths.

## Non-goals

- Signing/notarization and store distribution belong to spec 100; this spec
  proves the flow on unsigned/dev-signed artifacts where necessary.
- No mobile install paths (parked).

## Dependencies

Specs 040 and 070 (the wizard renders truthful provider/model state only),
spec 010 (SecretStore + consent), spec 050 gate decision for voice surfaces.
