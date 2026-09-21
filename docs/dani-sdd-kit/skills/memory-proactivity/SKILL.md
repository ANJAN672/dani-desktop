---
name: memory-proactivity
description: "Use only for features involving cross-session recall, procedural memory, quiet hours, scheduled events, user context, consent and proactive actions."
---

# Procedure
1. Distinguish user memory (derived), workflows (versioned and verified), operational job state (authoritative) and current external state (re-fetch). One owner per store.
2. Inspect existing Hermes memory provider before writing another ingestion job. Enforce per-user/workspace isolation, source/timestamp and corrections; implement clear deletion/retention semantics.
3. Normalize authorized events with IDs, dedup and freshness. Apply consent, quiet hours, rate/budget and novelty gates without waking Hermes when irrelevant.
4. Separate `silent`, `inform`, `prepare`, `act`; permission required at effect broker regardless of initiative score. Reconfirm current task relevance before action.
5. Treat disconnected/sleeping desktop honestly; cloud always-on is a separate opt-in deployment and sync design.
6. Test duplicate/out-of-order events, stale memory, cross-user leaks, contradictory facts, forget request, one-month recovery and notification storms.
**Done:** proved proactive benefit without autonomous overreach.
