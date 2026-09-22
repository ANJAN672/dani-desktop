#!/usr/bin/env python3
"""Validate Dan Lab SDD document integrity and traceability, never product behavior."""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

REQ = re.compile(r"\bR-[A-Z0-9]+-[0-9]{3}\b")
TASK = re.compile(r"\bT-[A-Z0-9]+-[0-9]{3}\b")
AC = re.compile(r"\bAC-[A-Z0-9]+-[0-9]{3}\b")
ACTIVE = {"DRAFT", "REVIEWED", "APPROVED", "IMPLEMENTED", "VERIFIED"}
REQUIRED_KIT = ["CONSTITUTION.md", "MASTER_PROMPT.md", "README.md", "templates/feature-spec.md", "templates/research.md", "templates/adr.md", "templates/constitution.md", "templates/task-plan.md", "templates/acceptance-matrix.md", "templates/handoff.md", "templates/bugfix-spec.md", "templates/incident.md"]


def duplicates(values):
    seen=set(); dup=set()
    for value in values:
        (dup if value in seen else seen).add(value)
    return sorted(dup)


def analyze(root: Path):
    errors=[]
    kit=root/"docs/dani-sdd-kit"
    for relative in REQUIRED_KIT:
        if not (kit/relative).is_file(): errors.append(f"missing kit file: {relative}")
    skills=list((kit/"skills").glob("*/SKILL.md"))
    if len(skills)<12: errors.append(f"expected >=12 skills, found {len(skills)}")
    for path in skills:
        text=path.read_text(encoding="utf-8")
        front=re.match(r"^---\n(.*?)\n---\n", text, re.S)
        if not front: errors.append(f"bad skill frontmatter: {path.relative_to(root)}"); continue
        name=re.search(r"^name: ([a-z0-9-]+)$",front.group(1),re.M)
        if not name or name.group(1)!=path.parent.name: errors.append(f"skill name mismatch: {path.relative_to(root)}")
        if not re.search(r"^description: .+",front.group(1),re.M): errors.append(f"missing skill description: {path.relative_to(root)}")
        if len(text.splitlines())>500: errors.append(f"skill too long: {path.relative_to(root)}")

    readme=(root/"specs/README.md").read_text(encoding="utf-8")
    for pattern in (r"Branch:\s*`prod` only", r"Never target `main`", r"PR into `prod`"):
        if re.search(pattern,readme,re.I): errors.append(f"stale active branch instruction in specs/README.md: {pattern}")

    reports=[]
    for feature in sorted((root/"specs").glob("[0-9][0-9][0-9]-*/")):
        spec=feature/"spec.md"
        if not spec.exists(): continue
        files={name:(feature/name) for name in ("spec.md","research.md","plan.md","tasks.md","acceptance.md")}
        missing=[name for name,path in files.items() if not path.exists()]
        # Existing 001/002 directory specs predate the artifact set. They are
        # migration inventory, not silently compliant. Enforce completeness
        # as soon as any downstream artifact is introduced.
        if missing and all(not files[name].exists() for name in ("research.md", "plan.md", "tasks.md", "acceptance.md")):
            reports.append({"feature":feature.name,"legacy":True,"migration":"pending"})
            continue
        if missing: errors.append(f"{feature.name}: missing {', '.join(missing)}"); continue
        text={name:path.read_text(encoding="utf-8") for name,path in files.items()}
        requirements=REQ.findall(text["spec.md"])
        if not requirements: errors.append(f"{feature.name}: no requirement IDs")
        for value in duplicates(requirements): errors.append(f"{feature.name}: duplicate requirement {value}")
        requirement_set=set(requirements)
        plan_refs=set(REQ.findall(text["plan.md"])); task_refs=set(REQ.findall(text["tasks.md"])); acceptance_refs=set(REQ.findall(text["acceptance.md"]))
        for stage,refs in (("plan",plan_refs),("tasks",task_refs),("acceptance",acceptance_refs)):
            unknown=refs-requirement_set
            missing_refs=requirement_set-refs
            for value in sorted(unknown): errors.append(f"{feature.name}: {stage} references unknown {value}")
            for value in sorted(missing_refs): errors.append(f"{feature.name}: {value} absent from {stage}")
        tasks=TASK.findall(text["tasks.md"]); acs=AC.findall(text["acceptance.md"])
        for value in duplicates(tasks): errors.append(f"{feature.name}: duplicate task {value}")
        for value in duplicates(acs): errors.append(f"{feature.name}: duplicate acceptance {value}")
        if not tasks: errors.append(f"{feature.name}: no task IDs")
        if not acs: errors.append(f"{feature.name}: no acceptance IDs")
        for line_no,line in enumerate(text["acceptance.md"].splitlines(),1):
            if "| VERIFIED |" in line and ("none" in line.lower() or not re.search(r"\b[0-9a-f]{7,40}\b",line)):
                errors.append(f"{feature.name}: VERIFIED row {line_no} lacks immutable evidence")
        reports.append({"feature":feature.name,"requirements":len(requirement_set),"tasks":len(set(tasks)),"acceptance":len(set(acs))})
    return errors,reports


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp); (root/"docs/dani-sdd-kit/skills/a").mkdir(parents=True); (root/"specs/999-fixture").mkdir(parents=True)
        for name in REQUIRED_KIT: path=root/"docs/dani-sdd-kit"/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text("# x\n")
        for i in range(12): path=root/f"docs/dani-sdd-kit/skills/s{i}/SKILL.md"; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(f"---\nname: s{i}\ndescription: fixture\n---\n")
        (root/"specs/README.md").write_text("main only")
        base=root/"specs/999-fixture"
        (base/"spec.md").write_text("Status: APPROVED\nR-FIX-001 R-FIX-001")
        (base/"research.md").write_text("baseline")
        (base/"plan.md").write_text("R-FIX-001")
        (base/"tasks.md").write_text("T-FIX-001 R-UNKNOWN-999")
        (base/"acceptance.md").write_text("AC-FIX-001 R-FIX-001 | VERIFIED | none")
        errors,_=analyze(root)
        expected=("duplicate requirement", "references unknown", "absent from tasks", "VERIFIED row")
        if not all(any(item in error for error in errors) for item in expected): raise AssertionError(errors)
    print("SDD checker negative fixtures: PASS")


def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--json",action="store_true"); parser.add_argument("--self-test",action="store_true")
    args=parser.parse_args()
    if args.self_test: self_test(); return
    root=Path(__file__).resolve().parents[3]
    errors,reports=analyze(root)
    result={"ok":not errors,"features":reports,"errors":errors,"note":"document integrity only; not product validation"}
    print(json.dumps(result,indent=2) if args.json else "\n".join([f"SDD features checked: {len(reports)}",f"SDD status: {'PASS' if not errors else 'FAIL'}",*[f"ERROR: {e}" for e in errors],"This check does not prove product behavior."]))
    raise SystemExit(bool(errors))
if __name__=="__main__": main()
