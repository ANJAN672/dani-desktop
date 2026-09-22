#!/bin/sh
set -eu
SOURCE="$(cd "${1:?usage: stage-hermes-payload.sh BUILD_OUT TARGET [REPO_ROOT]}" && pwd)"
TARGET="${2:?missing target}"
ROOT="$(cd "${3:-$(dirname "$0")/..}" && pwd)"
ARCHIVE="$SOURCE/hermes-payload-$TARGET-v2026.9.21.tar.gz"
MANIFEST="$SOURCE/hermes-payload-$TARGET-v2026.9.21.manifest.json"
[ -f "$ARCHIVE" ] && [ -f "$MANIFEST" ]
python3 - "$ARCHIVE" "$MANIFEST" "$TARGET" <<'PY'
import hashlib,json,os,sys
archive,manifest,target=sys.argv[1:]
m=json.load(open(manifest))
assert hashlib.sha256(open(archive,'rb').read()).hexdigest()==m['archiveSha256']
assert os.path.getsize(archive)==m['archiveSize']
assert m['name']=='hermes-runtime-payload' and m['target']==target
assert m['probe']['expectedAgentName']=='hermes-agent' and m['probe']['expectedVersion']=='0.21.4'
PY
A="$ROOT/dist-native/managed-runtimes/archives"; M="$ROOT/dist-native/managed-runtimes/manifests"
mkdir -p "$A" "$M"
cp "$ARCHIVE" "$A/hermes-runtime-payload-$TARGET.tar.gz"
cp "$MANIFEST" "$M/hermes-$TARGET.manifest.json"
echo "staged Hermes runtime payload under dist-native/managed-runtimes"
