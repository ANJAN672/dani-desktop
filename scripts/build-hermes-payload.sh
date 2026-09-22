#!/bin/sh
# =============================================================================
# T-BOOT-001: build a self-contained, redistributable Hermes runtime payload.
#
# Usage:
#   scripts/build-hermes-payload.sh <target> <outdir> [workdir]
#     target:  linux-x64 | mac-arm64 | mac-x64 | win-x64
#     outdir:  receives hermes-payload-<target>/ + .tar.gz + .manifest.json
#              (created if missing)
#     workdir: scratch dir (default: mktemp -d)
#
# Environment:
#   INCLUDE_GPL_CODECS=1   keep pillow-heif (bundles libx265 GPLv2 / libde265,
#                          libheif LGPLv3). Default 0: excluded, see NOTICE.
#   RUN_PROBE=0            skip the native ACP probe (default: run when target
#                          matches the build host's OS/arch)
#
# Windows CI note: the uname-based host detection below does NOT fire under
# Git Bash/MSYS runners (uname -s reports MINGW64_NT-*, not Windows_NT), and
# run-probe.sh would look for runtime/bin/python3, which does not exist in
# the Windows layout. On Windows runners, always invoke the probe explicitly:
#   cmd.exe /c probe\run-probe.cmd
#
# Requires: git, uv (>=0.5), python3 (+packaging), curl, rsync, tar,
#           sha256sum or shasum.
#
# Supply-chain model (all enforcement, no intent):
#   - upstream source pinned by commit, verified after checkout
#   - dependency resolution is upstream's frozen uv.lock, exported WITH hashes
#   - wheels are downloaded hash-enforced (pip --require-hashes) into a target
#     wheelhouse, then every wheel file's sha256 is verified against the
#     locked hash set (hermes_wheelhouse.py, fatal on mismatch)
#   - the payload installs ONLY from that wheelhouse (--no-index --find-links,
#     --require-hashes): no network at install time
#   - SBOM hashes are computed from the exact wheel files shipped
#   - exclusions (pillow-heif, mac-x64 cryptography) drop whole stanzas
#     (requirement + hash continuations), never individual hash lines
# =============================================================================
set -eu

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

TARGET="${1:?usage: build-hermes-payload.sh <target> <outdir> [workdir]}"
mkdir -p "${2:?missing outdir}"
OUT="$(cd "$2" && pwd)"
WORK="${3:-$(mktemp -d)}"
mkdir -p "$WORK"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PBS_DIGESTS="$SCRIPT_DIR/pbs-digests.json"

HERMES_REPO="https://github.com/NousResearch/hermes-agent.git"
HERMES_COMMIT="d337b736aa1e8ebecfab043842d13e4a2d2f48a3"   # tag v2026.9.21
HERMES_VERSION="0.21.4"
INCLUDE_GPL_CODECS="${INCLUDE_GPL_CODECS:-0}"

case "$TARGET" in
  linux-x64) UV_PLAT=x86_64-unknown-linux-gnu
             PIP_PLATFORMS="manylinux2014_x86_64 manylinux_2_17_x86_64 manylinux_2_28_x86_64 manylinux_2_31_x86_64 manylinux_2_34_x86_64" ;;
  mac-arm64) UV_PLAT=aarch64-apple-darwin
             PIP_PLATFORMS="macosx_10_9_universal2 macosx_10_13_universal2 macosx_11_0_universal2 macosx_12_0_universal2 macosx_11_0_arm64 macosx_12_0_arm64" ;;
  mac-x64)   UV_PLAT=x86_64-apple-darwin
             PIP_PLATFORMS="macosx_10_9_x86_64 macosx_10_10_x86_64 macosx_10_12_x86_64 macosx_10_13_x86_64 macosx_10_15_x86_64 macosx_11_0_x86_64 macosx_12_0_x86_64 macosx_10_9_universal2 macosx_10_13_universal2 macosx_11_0_universal2 macosx_12_0_universal2" ;;
  win-x64)   UV_PLAT=x86_64-pc-windows-msvc
             PIP_PLATFORMS="win_amd64" ;;
  *) echo "unknown target: $TARGET" >&2; exit 2 ;;
esac

EXCLUDES=""
if [ "$INCLUDE_GPL_CODECS" != 1 ]; then EXCLUDES="$EXCLUDES --exclude pillow-heif"; fi
if [ "$TARGET" = mac-x64 ]; then EXCLUDES="$EXCLUDES --exclude cryptography"; fi

echo "==> [1/10] pinned source: $HERMES_REPO @ $HERMES_COMMIT"
if [ ! -d "$WORK/src/.git" ]; then
  git clone "$HERMES_REPO" "$WORK/src"
fi
(cd "$WORK/src" && git checkout -q "$HERMES_COMMIT")
ACTUAL_COMMIT="$(cd "$WORK/src" && git rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$HERMES_COMMIT" ]; then
  echo "FATAL: checkout drifted from pin: $ACTUAL_COMMIT != $HERMES_COMMIT" >&2
  exit 1
fi
echo "    pin verified: $ACTUAL_COMMIT"

echo "==> [2/10] frozen HASHED resolution: uv.lock, core + acp extra"
(cd "$WORK/src" && uv export --frozen --no-dev --extra acp -o "$WORK/req-hashes.txt")

echo "==> [3/10] structural target filter (whole stanzas, hashes preserved)"
# shellcheck disable=SC2086
python3 "$SCRIPT_DIR/hermes_target_reqs.py" --export "$WORK/req-hashes.txt" \
  --target "$TARGET" $EXCLUDES \
  --out-reqs "$WORK/reqs-target.txt" --out-download "$WORK/reqs-download.txt"

echo "==> [4/10] standalone CPython (digest-pinned)"
PBS_URL="$(python3 -c "import json;d=json.load(open('$PBS_DIGESTS'));print(d['targets']['$TARGET']['url'])")"
PBS_SHA="$(python3 -c "import json;d=json.load(open('$PBS_DIGESTS'));print(d['targets']['$TARGET']['sha256'])")"
PBS_TARBALL="$WORK/$(basename "$PBS_URL")"
[ -f "$PBS_TARBALL" ] || curl -sL -o "$PBS_TARBALL" "$PBS_URL"
if [ "$(sha256_of "$PBS_TARBALL")" != "$PBS_SHA" ]; then
  echo "FATAL: python-build-standalone digest mismatch for $TARGET" >&2; exit 1
fi
echo "    PBS digest verified: $PBS_SHA"

echo "==> [5/10] payload layout: runtime/ vendor/ app/ bin/ probe/"
PAYLOAD="$OUT/hermes-payload-$TARGET"
rm -rf "$PAYLOAD"; mkdir -p "$PAYLOAD/bin" "$PAYLOAD/probe"
tar xzf "$PBS_TARBALL" -C "$WORK"
mv "$WORK/python" "$PAYLOAD/runtime"
# Host-runnable 3.11 (pip + tomllib) for wheelhouse download and SBOM - the
# payload runtime may be a foreign-platform binary that cannot execute here.
uv python install 3.11 >/dev/null
HOST_PY="$(uv python find 3.11)"

echo "==> [6/10] wheelhouse: hash-enforced download + per-wheel verification"
WH="$WORK/wheelhouse-$TARGET"
rm -rf "$WH"; mkdir -p "$WH"
PIP_PLATFORM_ARGS=""
for p in $PIP_PLATFORMS; do PIP_PLATFORM_ARGS="$PIP_PLATFORM_ARGS --platform $p"; done
# shellcheck disable=SC2086
"$HOST_PY" -m pip download --no-deps --require-hashes --only-binary=:all: \
  --dest "$WH" --implementation cp --python-version 311 \
  --abi cp311 --abi abi3 --abi none $PIP_PLATFORM_ARGS \
  -r "$WORK/reqs-download.txt" --quiet
python3 "$SCRIPT_DIR/hermes_wheelhouse.py" --reqs "$WORK/reqs-download.txt" \
  --wheelhouse "$WH" --out "$WH/wheelhouse-manifest.json"

echo "==> [7/10] install payload ONLY from the verified wheelhouse"
uv pip install --target "$PAYLOAD/vendor" --python-platform "$UV_PLAT" \
  --python-version 3.11 --no-index --find-links "$WH" --require-hashes \
  -r "$WORK/reqs-target.txt" 2>&1 | tail -1
if [ "$TARGET" = win-x64 ]; then
  # uv cross-resolution evaluates nemo-relay's win32/AMD64 marker false for
  # x86_64-pc-windows-msvc; a real Windows host evaluates it true. Install it
  # explicitly from the SAME verified wheelhouse, hash-enforced via the
  # marker-stripped stanza produced by hermes_target_reqs.py.
  python3 - "$WORK/reqs-download.txt" > "$WORK/reqs-win-supplement.txt" <<'PYEOF2'
import re, sys
keep = False
for line in open(sys.argv[1]):
    if re.match(r"^[A-Za-z0-9._-]+==", line):
        keep = line.startswith("nemo-relay==")
    if keep:
        sys.stdout.write(line)
PYEOF2
  uv pip install --target "$PAYLOAD/vendor" --python-platform "$UV_PLAT" \
    --python-version 3.11 --no-index --find-links "$WH" --require-hashes \
    --no-deps -r "$WORK/reqs-win-supplement.txt" 2>&1 | tail -1
fi

rsync -a --exclude=.git --exclude=tests --exclude=tests-js --exclude=website \
  --exclude=.github --exclude=docker --exclude=nix --exclude=evals \
  --exclude=apps --exclude=web --exclude=ui-tui --exclude=node_modules \
  --exclude=package-lock.json "$WORK/src/" "$PAYLOAD/app/"

echo "==> [8/10] launchers (self-locating; payload is fully relocatable)"
cat > "$PAYLOAD/bin/hermes" <<'LAUNCHER_SH'
#!/bin/sh
PAYLOAD_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONPATH="$PAYLOAD_ROOT/app:$PAYLOAD_ROOT/vendor"
export PYTHONNOUSERSITE=1
exec "$PAYLOAD_ROOT/runtime/bin/python3" -m hermes_cli.main "$@"
LAUNCHER_SH
cat > "$PAYLOAD/bin/hermes-acp" <<'LAUNCHER_SH'
#!/bin/sh
PAYLOAD_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONPATH="$PAYLOAD_ROOT/app:$PAYLOAD_ROOT/vendor"
export PYTHONNOUSERSITE=1
exec "$PAYLOAD_ROOT/runtime/bin/python3" -m acp_adapter "$@"
LAUNCHER_SH
chmod +x "$PAYLOAD/bin/hermes" "$PAYLOAD/bin/hermes-acp"
cat > "$PAYLOAD/bin/hermes.cmd" <<'LAUNCHER_CMD'
@echo off
set "PAYLOAD_ROOT=%~dp0.."
set "PYTHONPATH=%PAYLOAD_ROOT%\app;%PAYLOAD_ROOT%\vendor"
set "PYTHONNOUSERSITE=1"
"%PAYLOAD_ROOT%\runtime\python.exe" -m hermes_cli.main %*
LAUNCHER_CMD
cat > "$PAYLOAD/bin/hermes-acp.cmd" <<'LAUNCHER_CMD'
@echo off
set "PAYLOAD_ROOT=%~dp0.."
set "PYTHONPATH=%PAYLOAD_ROOT%\app;%PAYLOAD_ROOT%\vendor"
set "PYTHONNOUSERSITE=1"
"%PAYLOAD_ROOT%\runtime\python.exe" -m acp_adapter %*
LAUNCHER_CMD
cp "$SCRIPT_DIR/payload-probe/acp_probe.py" "$PAYLOAD/probe/"
cp "$SCRIPT_DIR/payload-probe/run-probe.sh" "$PAYLOAD/probe/"
cp "$SCRIPT_DIR/payload-probe/run-probe.cmd" "$PAYLOAD/probe/"
chmod +x "$PAYLOAD/probe/run-probe.sh"

echo "==> [9/10] SBOM (CycloneDX 1.5, exact-artifact hashes) + license texts"
"$HOST_PY" "$SCRIPT_DIR/hermes_sbom.py" \
  --wheelhouse-manifest "$WH/wheelhouse-manifest.json" \
  --lock "$WORK/src/uv.lock" --work "$WORK" \
  --vendor "$PAYLOAD/vendor" \
  --out-sbom "$PAYLOAD/SBOM.cdx.json" \
  --licenses-out "$PAYLOAD/licenses" \
  --license-fallbacks "$SCRIPT_DIR/license-fallbacks.json" \
  --target "$TARGET"

echo "==> [10/10] NOTICE + installed set + pack + manifest + probe"
cat > "$PAYLOAD/NOTICE" <<'NOTICE_EOF'
Hermes Runtime Payload - Third-Party Notices
=============================================

1. Hermes Agent v0.21.4 (tag v2026.9.21, commit d337b736aa1e8ebecfab043842d13e4a2d2f48a3)
   (c) Nous Research - MIT License (app/LICENSE)
   https://github.com/NousResearch/hermes-agent
   Upstream git tags/commits are NOT GPG-signed and the GitHub release has
   no assets; the commit pin above is the integrity anchor.

2. CPython 3.11.16 - python-build-standalone release 20260901
   (c) Python Software Foundation - PSF-2.0 (runtime/)
   https://github.com/astral-sh/python-build-standalone
   Artifact sha256 pinned in pbs-digests.json and verified at build time.

3. Python packages pinned by upstream uv.lock (core + "acp" extra),
   installed hash-enforced from a verified wheelhouse (every installed
   artifact's sha256 checked against the locked hash set; see
   SBOM.cdx.json for per-package artifact hashes and licenses/, for full
   license texts). Licenses verified from wheel METADATA on 2026-09-22:
   all shipped packages are MIT / Apache-2.0 / BSD / PSF / ISC, except:
   - pathspec 1.1.1 and tqdm 4.67.3: MPL-2.0 (weak, file-level copyleft;
     tqdm is MPL-2.0 AND MIT). Shipped UNMODIFIED; no source-offer
     obligation arises. If Dani ever patches an MPL-covered file, MPL-2.0
     requires offering that file's source (upstreams:
     https://github.com/cpburnz/python-pathspec, https://github.com/tqdm/tqdm).

License obligations summary:
   - MIT / BSD / ISC / PSF-2.0: retain copyright + license text (licenses/).
   - Apache-2.0 (agent-client-protocol, nemo-relay, et al.): retain NOTICE
     files where present (preserved under licenses/); state changes (none).
   - MPL-2.0 (pathspec, tqdm): see above.
   - Packages whose wheel lacks a license text have it restored from the
     LOCKED, digest-verified sdist (e.g. firecrawl-anydoc, MIT), or from a
     digest-pinned upstream source recorded in license-fallbacks.json
     (e.g. pywin32, PSF). The build FAILS rather than ship a package
     without its required license text.

Exclusions (deliberate, with product consequences):
   - pillow-heif (upstream core pin >=1.4.0,<2): its prebuilt wheels bundle
     libx265 (GPLv2) and libde265/libheif (LGPLv3). Shipping GPL inside a
     proprietary redistributable requires legal sign-off, so it is excluded
     by default (re-add with INCLUDE_GPL_CODECS=1). Degradation: HEIC /
     HEIF / AVIF image inputs are rejected by the vision tools.
   - mac-x64 only: cryptography 50.0.1. Upstream publishes NO macOS x86_64
     wheel (arm64-only since 50.0.0) and the 50.x floor is a deliberate
     CVE pin. Degradation: WeCom plugin crypto, Skills Hub GitHub App auth
     (RS256), dashboard-auth asymmetric JWT, chronos verify, PyJWT crypto
     algorithms. The ACP harness path does not import cryptography
     (probe-verified).
NOTICE_EOF
python3 - "$PAYLOAD" <<'PYEOF2'
import json, os, sys
vendor = os.path.join(sys.argv[1], "vendor")
dists = sorted(d[:-10] for d in os.listdir(vendor) if d.endswith(".dist-info"))
json.dump(dists, open(os.path.join(sys.argv[1], "INSTALLED.json"), "w"), indent=2)
print(f"    installed set: {len(dists)} distributions")
PYEOF2

ARCHIVE="$OUT/hermes-payload-$TARGET-v2026.9.21.tar.gz"
tar czf "$ARCHIVE" -C "$OUT" "hermes-payload-$TARGET"
echo "$(sha256_of "$ARCHIVE")  $(basename "$ARCHIVE")" >> "$OUT/SHA256SUMS.txt"
echo "    archive: $(du -h "$ARCHIVE" | cut -f1)  unpacked: $(du -sh "$PAYLOAD" | cut -f1)"

DEGRADATIONS="no-pillow-heif:HEIC/HEIF/AVIF image inputs rejected by vision tools (GPL codecs excluded; INCLUDE_GPL_CODECS=1 to re-add)"
if [ "$TARGET" = mac-x64 ]; then
  DEGRADATIONS="$DEGRADATIONS,no-cryptography:no upstream macOS x86_64 wheel; WeCom crypto, Skills Hub GitHub App RS256 auth, dashboard asymmetric JWT, chronos verify unavailable,no-nemo-relay:upstream marker excludes darwin/x86_64 (no-op relay by design)"
fi
python3 "$SCRIPT_DIR/hermes_manifest.py" \
  --target "$TARGET" \
  --payload-dir "$PAYLOAD" \
  --archive "$ARCHIVE" \
  --degradations "$DEGRADATIONS" \
  --out "$OUT/hermes-payload-$TARGET-v2026.9.21.manifest.json"

HOST_TAG="$(uname -s)-$(uname -m)"
RUN_PROBE="${RUN_PROBE:-auto}"
case "$TARGET:$HOST_TAG" in
  linux-x64:Linux-x86_64|mac-arm64:Darwin-arm64|mac-x64:Darwin-x86_64|win-x64:Windows_NT-x86_64)
    if [ "$RUN_PROBE" != 0 ]; then
      echo "==> native probe ($TARGET on $HOST_TAG)"
      "$PAYLOAD/bin/hermes" --version
      "$PAYLOAD/probe/run-probe.sh"
    fi
    ;;
  *)
    echo "==> no native probe: cross build, or a Windows MSYS/Git Bash runner where"
    echo "    uname detection cannot fire. On Windows CI invoke the probe explicitly:"
    echo "    cmd.exe /c hermes-payload-$TARGET\\probe\\run-probe.cmd"
    ;;
esac
echo "DONE: $ARCHIVE"
