#!/usr/bin/env python3
"""Packaging sanity check; NOT a DANI implementation test."""
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parents[1]
errors=[]
for req in ['MASTER_PROMPT.md','README.md','templates/feature-spec.md','templates/adr.md','templates/constitution.md','templates/task-plan.md','templates/acceptance-matrix.md','templates/handoff.md']:
    if not (ROOT/req).is_file(): errors.append(f'Missing required file: {req}')
skills=list((ROOT/'skills').glob('*/SKILL.md'))
if len(skills)<12: errors.append(f'Expected >=12 skills, found {len(skills)}')
for p in skills:
    s=p.read_text(encoding='utf-8')
    m=re.match(r'^---\n(.*?)\n---\n',s,re.S)
    if not m: errors.append(f'Bad frontmatter: {p}') ; continue
    front=m.group(1)
    nm=re.search(r'^name: ([a-z0-9-]+)$',front,re.M)
    if not nm or nm.group(1)!=p.parent.name: errors.append(f'Name mismatch: {p}')
    if not re.search(r'^description: .+',front,re.M): errors.append(f'Missing description: {p}')
    if len(s.splitlines())>500: errors.append(f'Skill too long: {p}')
print(f'Skills checked: {len(skills)}')
print(f'Kit status: {"PASS" if not errors else "FAIL"}')
for e in errors: print('ERROR:',e)
raise SystemExit(bool(errors))
