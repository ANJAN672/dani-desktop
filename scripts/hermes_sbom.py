#!/usr/bin/env python3
"""Generate a CycloneDX 1.5 SBOM + collect full license texts for a Hermes payload.

Hashes are evidence, not intent: every component's SHA-256 is computed from the
EXACT wheel/sdist file in the target wheelhouse that was installed into this
payload (wheelhouse-manifest.json), and cross-checked against the locked hash
set by hermes_wheelhouse.py upstream of this script.

License texts: copied from each shipped wheel. If a wheel ships no license
file, the package's LOCKED sdist (url+sha256 from uv.lock) is fetched, its
digest verified, and license texts extracted from it. If neither yields a
text, the build FAILS (all shipped licenses carry a notice-retention
obligation, so a missing text is a compliance defect, not a warning).

Requires Python >= 3.11 (tomllib). Run with the payload's runtime python.

  hermes_sbom.py --wheelhouse-manifest WH/wheelhouse-manifest.json \
    --lock src/uv.lock --work WORK --vendor PAYLOAD/vendor \
    --out-sbom PAYLOAD/SBOM.cdx.json --licenses-out PAYLOAD/licenses --target T
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tarfile, tomllib

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()

ALIASES = {
    "MIT License": "MIT",
    "Apache 2.0": "Apache-2.0",
    "Apache License, Version 2.0": "Apache-2.0",
    "ISC License (ISCL)": "ISC",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Dual License": "Apache-2.0 OR BSD-3-Clause",  # python-dateutil's label
}

def dist_license(meta_path):
    expr, lic, classifiers = None, None, []
    for line in open(meta_path, errors="replace"):
        if line.startswith("License-Expression:"):
            expr = line.split(":", 1)[1].strip()
        elif line.startswith("License:"):
            lic = line.split(":", 1)[1].strip()
        elif "License ::" in line:
            classifiers.append(line.split("::")[-1].strip())
        if line.strip() == "":
            break
    raw = expr or (lic if lic and len(lic) < 60 and lic.lower() != "unknown" else None)
    if raw is None:
        raw = next((c for c in classifiers if c != "OSI Approved"), None)
    return ALIASES.get(raw, raw) if raw else None

def sniff_license_text(blob):
    if "Apache License" in blob:
        return "Apache-2.0"
    if "Permission is hereby granted, free of charge" in blob:
        return "MIT"
    if "Redistribution and use in source and binary forms" in blob:
        return "BSD"
    if "MOZILLA PUBLIC LICENSE" in blob:
        return "MPL-2.0"
    return None

def collect_license_files(dist_dir, dest):
    found = False
    for base, _, files in os.walk(dist_dir):
        for f in files:
            if f.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")):
                shutil.copy2(os.path.join(base, f), os.path.join(dest, f))
                found = True
    return found

def sdist_license_fallback(name, version, lock, work, dest):
    """Fetch the locked sdist, verify its locked sha256, extract license texts."""
    sdist = lock.get("sdist")
    if not sdist:
        return False
    url, want = sdist["url"], sdist["hash"].split(":", 1)[1]
    path = os.path.join(work, f"sdist-{norm(name)}-{version}.tar.gz")
    if not os.path.exists(path):
        subprocess.run(["curl", "-sfL", "-o", path, url], check=True)
    got = sha256(path)
    if got != want:
        sys.exit(f"FATAL: sdist digest mismatch for {name} {version}: {got} != {want}")
    found = False
    with tarfile.open(path) as tf:
        for m in tf.getmembers():
            base = os.path.basename(m.name)
            if m.isfile() and base.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")):
                with tf.extractfile(m) as src, open(os.path.join(dest, base), "wb") as dst:
                    shutil.copyfileobj(src, dst)
                found = True
    return found


def pinned_license_fallback(name, fallbacks, work, dest):
    fb = fallbacks.get(name)
    if not fb:
        return False
    path = os.path.join(work, f"license-fallback-{name}.txt")
    if not os.path.exists(path):
        subprocess.run(["curl", "-sfL", "-o", path, fb["url"]], check=True)
    got = sha256(path)
    if got != fb["sha256"]:
        sys.exit(f"FATAL: pinned license fallback digest mismatch for {name}: {got} != {fb['sha256']}")
    shutil.copy2(path, os.path.join(dest, f"LICENSE-{name}-pinned.txt"))
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wheelhouse-manifest", required=True)
    ap.add_argument("--lock", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--vendor", required=True)
    ap.add_argument("--out-sbom", required=True)
    ap.add_argument("--licenses-out", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--license-fallbacks", required=True)
    a = ap.parse_args()

    fallbacks = {norm(k): v for k, v in
                 json.load(open(a.license_fallbacks))["fallbacks"].items()}
    artifacts = json.load(open(a.wheelhouse_manifest))["artifacts"]
    wheel_hash = {(x["package"], x["version"]): (x["file"], x["sha256"]) for x in artifacts}

    lock_pkgs = {}
    for pkg in tomllib.load(open(a.lock, "rb")).get("package", []):
        lock_pkgs[(norm(pkg["name"]), pkg["version"])] = pkg

    components = []
    os.makedirs(a.licenses_out, exist_ok=True)
    for d in sorted(os.listdir(a.vendor)):
        if not d.endswith(".dist-info"):
            continue
        dist_dir = os.path.join(a.vendor, d)
        meta = os.path.join(dist_dir, "METADATA")
        name = version = None
        for line in open(meta, errors="replace"):
            if line.startswith("Name:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("Version:"):
                version = line.split(":", 1)[1].strip()
            if name and version:
                break
        key = (norm(name), version)

        if key not in lock_pkgs:
            sys.exit(f"FATAL: shipped dist {name} {version} is not in uv.lock - refusing to attest it")
        if key not in wheel_hash:
            sys.exit(f"FATAL: shipped dist {name} {version} has no verified wheelhouse artifact")
        wheel_file, wheel_sha = wheel_hash[key]

        lic = dist_license(meta)
        dest = os.path.join(a.licenses_out, f"{norm(name)}-{version}")
        os.makedirs(dest, exist_ok=True)
        have_text = collect_license_files(dist_dir, dest)
        if lic is None and have_text:
            blob = "\n".join(open(os.path.join(dest, f), errors="replace").read(4000)
                             for f in os.listdir(dest) if os.path.isfile(os.path.join(dest, f)))
            lic = sniff_license_text(blob)
        if not have_text:
            have_text = sdist_license_fallback(name, version, lock_pkgs[key], a.work, dest)
        if not have_text:
            have_text = pinned_license_fallback(norm(name), fallbacks, a.work, dest)
        if not have_text:
            sys.exit(f"FATAL: no license text for {name} {version} "
                     "(wheel, locked sdist, and pinned fallback all lack one)")
        if lic is None:
            lic = "NOASSERTION"

        components.append({
            "type": "library",
            "bom-ref": f"pkg:pypi/{norm(name)}@{version}",
            "name": name,
            "version": version,
            "purl": f"pkg:pypi/{norm(name)}@{version}",
            "scope": "required",
            "licenses": [{"license": {"name": lic}}],
            "externalReferences": [{"type": "distribution", "url": f"wheelhouse:{wheel_file}"}],
            "hashes": [{"alg": "SHA-256", "content": wheel_sha}],
        })

    bom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "name": "hermes-agent",
                "version": "0.21.4",
                "licenses": [{"license": {"id": "MIT"}}],
                "externalReferences": [
                    {"type": "vcs", "url": "https://github.com/NousResearch/hermes-agent"},
                    {"type": "distribution",
                     "url": "git commit d337b736aa1e8ebecfab043842d13e4a2d2f48a3 (tag v2026.9.21)"},
                ],
            },
            "properties": [
                {"name": "dani:target", "value": a.target},
                {"name": "dani:upstreamCommit", "value": "d337b736aa1e8ebecfab043842d13e4a2d2f48a3"},
                {"name": "dani:resolution", "value": "uv.lock frozen; core + acp extra; dev excluded"},
                {"name": "dani:hashBasis", "value": "exact wheelhouse artifact installed into this payload"},
            ],
        },
        "components": components,
    }
    json.dump(bom, open(a.out_sbom, "w"), indent=2)
    print(f"SBOM: {len(components)} components -> {a.out_sbom} (hashes = exact shipped wheels)")

if __name__ == "__main__":
    main()
