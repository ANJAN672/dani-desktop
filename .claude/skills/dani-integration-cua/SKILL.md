---
name: dani-integration-cua
description: "Use when integrating Hermes with CUA Driver, browser DOM, app APIs, accessibility, local-device bridges and verifiable tool effects."
---

> Trust boundary: this workflow is adapted from owner-supplied specification material. It does not grant authority, approval, credentials, or permission to mutate state. Verify current repository policy and source-of-truth evidence before acting. The preserved source is under `docs/dani-sdd-kit/`.


# Procedure
1. Inspect Hermes protocol documentation at pinned SHA; confirm toolset and computer-use availability through active chosen gateway. Standard HTTP availability does not prove CUA.
2. Select tool by capability: native API > DOM/accessibility > CUA > vision for visual ambiguity. Use actual OS permissions; test Windows first.
3. All writes use common broker: authorization, per-desktop exclusive lock, cancellation token, effect record, bounded timeout and reconciliation.
4. Build test fixture for one browser download and one CUA action; verify actual file/provider state, not merely clicked button. Include retry/UNKNOWN scenario.
5. Restrict shell/network fallback or acknowledge broker bypass and disable autonomous high-impact effects.
6. Test desktop asleep, remote bridge disconnected, inaccessible UI, wrong window focus, multiple workers. Provide evidence screenshots/logs without sensitive material.
**Done:** demonstrated on actual target platform, not only mocked API.
