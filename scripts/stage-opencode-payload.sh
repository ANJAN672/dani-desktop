#!/bin/sh
set -eu
SOURCE="$(cd "${1:?usage: stage-opencode-payload.sh BUILD_OUT [REPO_ROOT]}" && pwd)"
ROOT="$(cd "${2:-$(dirname "$0")/..}" && pwd)"
ARCHIVE="$SOURCE/opencode-payload-linux-x64-v1.18.32.tar.gz"
MANIFEST="$SOURCE/opencode-payload-linux-x64-v1.18.32.manifest.json"
SUMS="$SOURCE/SHA256SUMS.txt"
[ -f "$ARCHIVE" ] && [ -f "$MANIFEST" ] && [ -f "$SUMS" ]
(cd "$SOURCE" && sha256sum -c SHA256SUMS.txt)
python3 - "$ARCHIVE" "$MANIFEST" <<'PY'
import hashlib,json,os,sys
archive,manifest=sys.argv[1:]
m=json.load(open(manifest))
h=hashlib.sha256(open(archive,'rb').read()).hexdigest()
assert h==m['archiveSha256'], f"archive hash mismatch: {h} != {m['archiveSha256']}"
assert os.path.getsize(archive)==m['archiveSize'], 'archive size mismatch'
assert m['name']=='opencode-runtime-payload' and m['target']=='linux-x64'
assert m['upstreamCommit']=='f5ce4f881e477c7b75421cea2d20939f0ddd71fb'
assert m['probe']['expectedAgentName']=='OpenCode' and m['probe']['expectedVersion']=='1.18.32'
PY
A="$ROOT/dist-native/managed-runtimes/archives"; M="$ROOT/dist-native/managed-runtimes/manifests"
mkdir -p "$A" "$M"
cp "$ARCHIVE" "$A/opencode-runtime-payload-linux-x64.tar.gz"
cp "$MANIFEST" "$M/opencode-runtime-payload-linux-x64.manifest.json"
# Verify staged bytes independently, not only the sources.
[ "$(sha256sum "$A/opencode-runtime-payload-linux-x64.tar.gz" | cut -d' ' -f1)" = "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" ]
[ "$(sha256sum "$M/opencode-runtime-payload-linux-x64.manifest.json" | cut -d' ' -f1)" = "$(sha256sum "$MANIFEST" | cut -d' ' -f1)" ]
echo "staged OpenCode runtime payload under dist-native/managed-runtimes"
