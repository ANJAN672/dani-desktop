---
name: dani-threat-model
description: "Use before giving Hermes, Laya, CUA or background jobs access to real computer, files, credentials, accounts, network, memory or autonomous actions."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Inventory identities, trust boundaries, assets, inputs (webpage/email/DOM/tool responses) and high-impact side effects.
2. Derive threats: prompt injection, confused deputy, cross-tenant access, credential exfiltration, unrestricted terminal/network bypass, duplicate submits, local bridge compromise, stale approvals.
3. Put authorization at a broker/enforced sandbox or credential boundary; model confidence and a pre-tool hook alone do NOT authorize.
4. Specify signed/session-scoped capabilities, approval TTL, effect fingerprints and human confirmation before high-impact actions.
5. Add negative integration tests: agent attempts alternate shell/HTTP path; expired approval; wrong user/device; malicious webpage instructions; denial on broker outage.
6. Document any unavoidable limitations. Keep autonomous high-impact feature OFF until truly enforceable.
**Gate:** fail closed on permission uncertainty; record outcomes without private data leaks.
