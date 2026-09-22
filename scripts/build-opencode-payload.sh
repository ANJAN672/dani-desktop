#!/bin/sh
set -eu
TARGET="${1:?usage: build-opencode-payload.sh linux-x64 OUTDIR [WORKDIR]}"; [ "$TARGET" = linux-x64 ] || { echo 'linux-x64 only' >&2; exit 2; }
OUT="$(mkdir -p "$2" && cd "$2" && pwd)"; WORK="${3:-$(mktemp -d)}"; mkdir -p "$WORK"
URL=https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-linux-x64-baseline.tar.gz
UP_SHA=763af386ef88a8cab18df00fcf055690e5a55e31a7088beabe02307142a6adce; UP_SIZE=60608354
UP="$WORK/opencode-linux-x64-baseline.tar.gz"; [ -f "$UP" ] || curl -fL "$URL" -o "$UP"
[ "$(stat -c %s "$UP")" = "$UP_SIZE" ]; echo "$UP_SHA  $UP" | sha256sum -c -
P="$OUT/opencode-payload-$TARGET"; rm -rf "$P"; mkdir -p "$P/bin" "$P/probe" "$P/licenses"
tar xzf "$UP" -C "$P/bin"; chmod +x "$P/bin/opencode"
cat > "$P/bin/opencode-acp" <<'EOF'
#!/bin/sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/bin/opencode" acp --pure "$@"
EOF
chmod +x "$P/bin/opencode-acp"
cp "$(dirname "$0")/opencode-payload/"* "$P/probe/"; chmod +x "$P/probe/run-probe.sh"
cat > "$P/licenses/OpenCode-MIT.txt" <<'EOF'
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
EOF
cat > "$P/NOTICE" <<EOF
OpenCode Runtime Payload - Third-Party Notices
OpenCode v1.18.32 (commit f5ce4f881e477c7b75421cea2d20939f0ddd71fb), official immutable linux-x64-baseline release artifact.
Upstream: https://github.com/anomalyco/opencode/releases/tag/v1.18.32
Archive SHA-256: $UP_SHA; size: $UP_SIZE bytes.
Copyright (c) 2025 opencode. MIT license: licenses/OpenCode-MIT.txt.
The upstream executable is redistributed unmodified. Dani adds only launchers, probes, NOTICE, and SBOM metadata.
EOF
BIN_SHA=$(sha256sum "$P/bin/opencode"|cut -d' ' -f1); BIN_SIZE=$(stat -c %s "$P/bin/opencode")
cat > "$P/SBOM.cdx.json" <<EOF
{"bomFormat":"CycloneDX","specVersion":"1.5","serialNumber":"urn:uuid:9ff06d4b-6e5d-4cc4-85d4-118320000001","version":1,"metadata":{"component":{"type":"application","name":"opencode-runtime-payload","version":"1.18.32"}},"components":[{"type":"application","bom-ref":"pkg:github/anomalyco/opencode@v1.18.32","name":"OpenCode","version":"1.18.32","licenses":[{"license":{"id":"MIT"}}],"hashes":[{"alg":"SHA-256","content":"$BIN_SHA"}],"properties":[{"name":"dani:upstreamCommit","value":"f5ce4f881e477c7b75421cea2d20939f0ddd71fb"},{"name":"dani:upstreamTag","value":"v1.18.32"},{"name":"dani:upstreamArchiveSha256","value":"$UP_SHA"},{"name":"dani:executableSize","value":"$BIN_SIZE"}]}]}
EOF
A="$OUT/opencode-payload-$TARGET-v1.18.32.tar.gz"; tar czf "$A" -C "$OUT" "opencode-payload-$TARGET"
python3 "$(dirname "$0")/opencode_manifest.py" --target "$TARGET" --payload-dir "$P" --archive "$A" --out "$OUT/opencode-payload-$TARGET-v1.18.32.manifest.json"
(cd "$OUT" && sha256sum "$(basename "$A")" "$(basename "$A" .tar.gz).manifest.json" > SHA256SUMS.txt)
"$P/probe/run-probe.sh"
echo "DONE $A"
