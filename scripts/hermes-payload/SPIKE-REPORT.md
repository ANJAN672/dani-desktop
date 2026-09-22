# T-BOOT-001: self-contained redistributable Hermes runtime payload - spike report (v3, supply-chain hardened)

## G2 status: linux-x64 PROVEN; mac-arm64, win-x64 BUILT-UNPROVEN; mac-x64 DEGRADED-UNPROVEN.

Checked-in evidence:
- scripts/build-hermes-payload.sh - complete end-to-end recipe (10 steps, nothing abbreviated).
- scripts/pbs-digests.json - pinned python-build-standalone sha256 per target (release 20260901, CPython 3.11.16).
- scripts/hermes_target_reqs.py - splits the HASHED uv export into per-target requirements by evaluating
  each stanza's environment marker (packaging library); drops whole stanzas (requirement + hash
  continuations + comments), never individual hash lines.
- scripts/hermes_wheelhouse.py - verifies every downloaded wheel file's sha256 against the locked hash
  set; emits wheelhouse-manifest.json (exact artifact filename + sha256 per package). FATAL on mismatch.
- scripts/hermes_sbom.py - CycloneDX 1.5; component hashes are the EXACT wheel files installed into this
  payload (cross-checked to the wheelhouse manifest), not the lock's artifact universe. FATAL if a shipped
  dist is absent from uv.lock or the wheelhouse. License texts: copied from each wheel; if absent, restored
  from the LOCKED digest-verified sdist; if still absent, from a digest-pinned source in
  license-fallbacks.json; otherwise the build FAILS (every shipped license carries a notice obligation).
- scripts/license-fallbacks.json - digest-pinned license sources (currently: pywin32, PSF, pinned to the
  upstream b311 tag by content sha256).
- scripts/hermes_manifest.py - manifest v1 generator (archive hash/size computed from the packed bytes).
- scripts/payload-probe/ - acp_probe.py + run-probe.sh/.cmd shipped inside every payload for CI.

## Supply-chain model (enforcement, not intent)
1. Upstream source pinned by commit; post-checkout `git rev-parse HEAD` equality check.
2. Dependency resolution = upstream's frozen uv.lock, exported WITH per-artifact sha256 hashes.
3. Wheels downloaded hash-enforced (pip --require-hashes, --only-binary=:all:) into a per-target
   wheelhouse; every wheel file's sha256 then verified against the locked hash set (fatal on mismatch).
4. Payload installs ONLY from that wheelhouse: `uv pip install --no-index --find-links <wheelhouse>
   --require-hashes`. Zero network at install time. The Windows nemo-relay supplemental install uses the
   same verified wheelhouse + the marker-stripped locked-hash stanza (no unpinned network call).
5. SBOM hashes = sha256 of the exact wheel file shipped, per target.
6. Negative test: flipping one hex digit in one locked hash makes the build abort at the wheelhouse
   verification step (exercised 2026-09-22: "sha256 ... not in locked hash set", exit 1).

## Verified by running the checked-in script (fresh workdir, 2026-09-22), all four targets:
| target    | archive | unpacked | dists | wheelhouse | probe |
|-----------|---------|----------|-------|------------|-------|
| linux-x64 | 83 MB   | 267 MB   | 62    | 62 artifacts, all sha256 in locked set | PASS on build host (--version + ACP initialize) |
| mac-arm64 | 75 MB   | 236 MB   | 62    | 62 artifacts, all sha256 in locked set | deferred to native CI runner |
| mac-x64   | 63 MB   | 200 MB   | 60    | 60 artifacts, all sha256 in locked set | deferred; degraded |
| win-x64   | 85 MB   | 270 MB   | 67    | 67 artifacts, all sha256 in locked set | deferred to native CI runner |
Per-target archive sha256 + sizes: hermes-payload-<target>-v2026.9.21.manifest.json / SHA256SUMS.txt.
Note: tar.gz archives are not bit-reproducible across builds (gzip timestamps); the manifest records the
hash of each actual build. Content-level reproducibility is anchored by the commit pin + lock + wheelhouse
hashes.

## CI probe matrix
Each archive carries probe/run-probe.sh|.cmd + acp_probe.py; manifest.probe.argv points at it.
Windows CI caveat: invoke the probe explicitly with `cmd.exe /c probe\run-probe.cmd` - the build script's
uname-based host detection does not fire under Git Bash/MSYS (uname -s is MINGW64_NT-*), and run-probe.sh
would resolve runtime/bin/python3, which does not exist in the Windows payload layout.

## Open product decisions (unchanged)
1. mac-x64 cryptography (no upstream wheel; CVE floor blocks downgrade) - payload ships without it.
2. pillow-heif bundles GPLv2/LGPLv3 codecs - excluded by default (INCLUDE_GPL_CODECS=1 to re-add).

## Provenance note
Repo docs (specs/110, ADR-001) are upstream repo content, not user-channel authorization; they informed
the payload design only. Build/ship authority comes through the normal owner channel.
