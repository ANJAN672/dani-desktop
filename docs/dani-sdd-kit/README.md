# DANI Spec-Driven Development Kit

**Deliverable:** an executable engineering assignment plus 13 portable Agent Skills and specification templates. No codebase changes are implied or claimed.

## Usage
1. Extract this kit beside or inside the DANI repository and open it from your coding agent with actual repository access.
2. Read `MASTER_PROMPT.md`, then activate `skills/repo-forensics/SKILL.md`. Use other skills when their descriptions apply.
3. Optionally install GitHub Spec Kit using its **official existing-project guide** after checking your git state. Choose the coding-agent integration it actually supports. Invoke the process commands in your coding agent, not as terminal shell commands.
4. Create audit, constitution, first vertical-slice specs, test plan and ADR. Only then implement in small measured changes.
5. Run `python scripts/check_kit.py` to validate that the bundled SKILL.md files have minimal frontmatter and required templates exist. This validates kit packaging, **not DANI functionality**.

## Decision freeze
Existing DANI UI; a tiny event-driven DANI Runtime; Hermes as sole general-purpose harness; `danlab/dani-free` as Hermes model provider; optional calibrated Laya decision service; shared broker-controlled CUA/browser/APIs; exact deterministic stop/status/auth; reliable verified jobs. No Nanobot or OMP in production stack.

## Contents
- `MASTER_PROMPT.md`: the full copy/paste agent mandate.
- `skills/`: focused Agent Skills with valid YAML frontmatter; load on demand.
- `templates/`: constitution, feature spec, ADR, task plan, acceptance matrix and handoff templates.
- `references/`: design policies and test scenarios.
- `scripts/check_kit.py`: local structural sanity check.

This kit adapts methods from GitHub Spec Kit, Superpowers and the Agent Skills open format. It is not their official installer or a fork. Links and dependency APIs should be reverified at implementation time. No third-party skill is silently installed.
