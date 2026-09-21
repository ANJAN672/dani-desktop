---
name: failure-injection
description: "Use before merging any job, approval, webhook, proactivity, voice or computer-use feature to test outages, ambiguous effects and recovery."
---

# Procedure
1. Identify each transaction boundary: local persist, Hermes session, model response, provider dispatch, acknowledgment, verification and user notification.
2. Kill process BEFORE and AFTER each boundary; restart and assert allowed state transitions, no duplicate consequential effects and truthful UNKNOWN if unresolved.
3. Inject Laya timeout, Hermes loss, network partition, duplicate webhook, quota exhaustion, stale event, bad tool output, driver permission denial and competing desktop workers.
4. Verify stop prevents new dispatch; distinguish work in flight from reversible operations. Test voice speech interruption separately.
5. Reconcile external state using provider IDs/receipts or pause for review. Never blindly retry an uncertain payment/message/destructive action.
6. Save failure logs, fix root cause and rerun full affected matrix; don't mark as passed because a recovery dialog appeared.
**Output:** reproducible scripts/cases and real outcomes with trace IDs.
