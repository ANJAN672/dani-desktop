# ADR-001: DANI runtime and Hermes responsibility boundary

Status: Accepted for staged implementation. Date: 2026-09-21.

DANI Runtime is a small deterministic control plane for ingress, durable jobs, policy, effects, cancellation, budgets, audit and verification. Hermes ACP is the sole default general-purpose reasoning harness. Laya may only return bounded advisory decisions. Native API, DOM/browser, accessibility, CUA, filesystem, terminal, app and integration routes implement the same typed tool/effect contract.

This extends existing provider and event seams instead of replacing the product shell or embedding another supervisor. It limits duplicate state, keeps no-model controls available, and makes ambiguous effects explicit. Costs are a migration layer between existing routines/delegations and the new ledger, SQLite operational limits, and the need for enforced rather than prompt-only tool isolation.

Alternatives rejected: a second general LLM supervisor; per-feature effect rules; Laya on every request; optimistic exactly-once claims; a blanket rewrite. Rollback: keep new runtime paths feature-gated, preserve existing stores, and remove routing without deleting ledger evidence.
