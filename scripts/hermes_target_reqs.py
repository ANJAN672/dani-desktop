#!/usr/bin/env python3
"""Split a universal hashed `uv export` requirements file into a target-specific,
hash-complete requirements file (and a marker-stripped download variant).

Stanzas are kept or dropped WHOLE (requirement line + every --hash continuation +
comments) so hash coverage is never silently degraded. Exclusions are package-level.

Usage:
  hermes_target_reqs.py --export req-hashes.txt --target linux-x64 \
      [--exclude pillow-heif --exclude cryptography] \
      --out-reqs reqs-target.txt --out-download reqs-download.txt
"""
import argparse, re, sys
from packaging.markers import Marker

ENVS = {
    "linux-x64": dict(sys_platform="linux", platform_machine="x86_64", os_name="posix",
                      platform_system="Linux", platform_release="", platform_version=""),
    "mac-arm64": dict(sys_platform="darwin", platform_machine="arm64", os_name="posix",
                      platform_system="Darwin", platform_release="", platform_version=""),
    "mac-x64":   dict(sys_platform="darwin", platform_machine="x86_64", os_name="posix",
                      platform_system="Darwin", platform_release="", platform_version=""),
    "win-x64":   dict(sys_platform="win32", platform_machine="AMD64", os_name="nt",
                      platform_system="Windows", platform_release="", platform_version=""),
}
COMMON = dict(implementation_name="cpython", implementation_version="3.11.16",
              platform_python_implementation="CPython",
              python_full_version="3.11.16", python_version="3.11", extra="")

def stanzas(path):
    """Yield (package, marker_str, [lines]) per requirement stanza."""
    cur = None
    for line in open(path):
        if not line.strip() or line.lstrip().startswith("#") and cur is None:
            continue
        if line.startswith("-e"):
            continue
        if re.match(r"^[A-Za-z0-9._-]+==", line):
            if cur:
                yield cur
            req = line.rstrip().rstrip("\\").rstrip()
            name = re.match(r"^([A-Za-z0-9._-]+)==", req).group(1)
            marker = req.split(" ; ", 1)[1] if " ; " in req else None
            cur = (name, marker, [line])
        elif cur is not None and (line.startswith(" ") or line.startswith("\t")):
            cur[2].append(line)
        elif cur is not None and not line.strip():
            continue
    if cur:
        yield cur

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True)
    ap.add_argument("--target", required=True, choices=list(ENVS))
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--out-reqs", required=True)
    ap.add_argument("--out-download", required=True)
    a = ap.parse_args()

    env = dict(COMMON, **ENVS[a.target])
    excluded = {e.lower() for e in a.exclude}
    kept, dropped = [], []
    for name, marker, lines in stanzas(a.export):
        norm = re.sub(r"[-_.]+", "-", name).lower()
        if norm in excluded:
            dropped.append((name, "excluded"))
            continue
        if marker and not Marker(marker).evaluate(env):
            dropped.append((name, f"marker false: {marker}"))
            continue
        kept.append((name, marker, lines))

    with open(a.out_reqs, "w") as f:
        for name, marker, lines in kept:
            f.writelines(lines)
    with open(a.out_download, "w") as f:
        for name, marker, lines in kept:
            # marker already accounted for by the filter; strip it from the
            # requirement line so pip (which evaluates markers on the HOST)
            # downloads the artifact anyway. Hash continuations untouched.
            first = lines[0]
            if " ; " in first:
                first = first.split(" ; ", 1)[0].rstrip().rstrip("\\").rstrip() + " \\\n"
            f.write(first)
            f.writelines(lines[1:])

    print(f"target={a.target}: kept {len(kept)} packages, dropped {len(dropped)}")
    for name, why in dropped:
        print(f"  dropped {name} ({why})")

if __name__ == "__main__":
    main()
