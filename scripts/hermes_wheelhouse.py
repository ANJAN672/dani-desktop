#!/usr/bin/env python3
"""Verify a downloaded wheelhouse against the hashed requirements it came from,
and emit wheelhouse-manifest.json: the exact artifacts (filename + sha256) that
will be installed into the payload. FATAL on any mismatch or missing artifact.

Usage: hermes_wheelhouse.py --reqs reqs-download.txt --wheelhouse WH --out WH/wheelhouse-manifest.json
"""
import argparse, hashlib, json, os, re, sys

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()

def req_hashes(path):
    """package -> (version, set of allowed sha256 from the hashed requirements)."""
    out, cur = {}, None
    for line in open(path):
        line = line.rstrip()
        m = re.match(r"^([A-Za-z0-9._-]+)==([^\s\\;]+)", line)
        if m:
            cur = norm(m.group(1))
            out[cur] = {"version": m.group(2).strip(), "hashes": set()}
        h = re.search(r"--hash=sha256:([0-9a-f]{64})", line)
        if h and cur:
            out[cur]["hashes"].add(h.group(1))
    return out

def wheel_name_ver(filename):
    parts = filename.split("-")
    return norm(parts[0]), parts[1]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reqs", required=True)
    ap.add_argument("--wheelhouse", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    reqs = req_hashes(a.reqs)
    files = sorted(f for f in os.listdir(a.wheelhouse) if f.endswith((".whl", ".tar.gz")))
    if not files:
        sys.exit("FATAL: wheelhouse is empty")

    manifest, seen = [], set()
    errors = []
    for f in files:
        name, ver = wheel_name_ver(f)
        digest = sha256(os.path.join(a.wheelhouse, f))
        entry = reqs.get(name)
        if entry is None:
            errors.append(f"{f}: not in requirements")
        elif entry["version"] != ver:
            errors.append(f"{f}: version {ver} != locked {entry['version']}")
        elif digest not in entry["hashes"]:
            errors.append(f"{f}: sha256 {digest} not in locked hash set")
        manifest.append({"file": f, "package": name, "version": ver, "sha256": digest})
        seen.add(name)

    missing = sorted(set(reqs) - seen)
    if missing:
        errors.append(f"no artifact downloaded for: {missing}")
    if errors:
        sys.exit("FATAL wheelhouse verification failed:\n  " + "\n  ".join(errors))

    json.dump({"artifacts": manifest}, open(a.out, "w"), indent=2)
    print(f"wheelhouse verified: {len(manifest)} artifacts, every sha256 in locked hash set")

if __name__ == "__main__":
    main()
