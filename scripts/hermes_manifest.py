#!/usr/bin/env python3
"""Emit manifest v1 for a Hermes runtime payload (T-BOOT-001 / ADR-001 verify-and-activate).

Schema v1:
  {manifestVersion, name, target, version, upstreamCommit, archiveSha256, archiveSize,
   unpackedSize, format, executableRelPath, probe:{argv, protocol, expectedVersion},
   noticeRelPath, sbomRelPath, degradations[]}

Run AFTER the archive is built: archive hash/size are computed here, so the manifest
always describes the shipped bytes, never the intent.
"""
import argparse, hashlib, json, os

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def dir_size(root):
    total = 0
    for base, _, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            if not os.path.islink(p):
                total += os.path.getsize(p)
    return total

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True, choices=["linux-x64", "mac-arm64", "mac-x64", "win-x64"])
    ap.add_argument("--payload-dir", required=True)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--degradations", default="")   # comma-separated; empty = none
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    is_win = a.target.startswith("win")
    manifest = {
        "manifestVersion": 1,
        "name": "hermes-runtime-payload",
        "target": a.target,
        "version": "0.21.4",
        "upstreamCommit": "d337b736aa1e8ebecfab043842d13e4a2d2f48a3",
        "archiveSha256": sha256(a.archive),
        "archiveSize": os.path.getsize(a.archive),
        "unpackedSize": dir_size(a.payload_dir),
        "format": "tar.gz",
        "executableRelPath": "bin/hermes-acp.cmd" if is_win else "bin/hermes-acp",
        "probe": {
            "argv": ["probe\\run-probe.cmd"] if is_win else ["probe/run-probe.sh"],
            "protocol": "acp-jsonrpc-stdio: spawn executableRelPath, send initialize "
                        "{protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,"
                        "writeTextFile:false}, terminal:false}}, expect result.agentInfo",
            "expectedVersion": "0.21.4",
        },
        "noticeRelPath": "NOTICE",
        "sbomRelPath": "SBOM.cdx.json",
        "degradations": [d for d in a.degradations.split(",") if d],
    }
    with open(a.out, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"manifest v1 -> {a.out} (archive sha256 {manifest['archiveSha256'][:16]}...)")

if __name__ == "__main__":
    main()
