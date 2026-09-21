# Reference: contractual boundaries

## DecisionProvider (proposed, validate against actual Laya API)
Request: `schema_id`, `schema_version`, `task_id`, minimized `state_summary`, enumerated `options`, explicit `NONE_OF_THE_ABOVE`, timeout, trace ID.
Response: scores, selected option or null, model/checkpoint hash, elapsed time and abstention reason.
Validation: reject unknown schema/model version, malformed scores, unrecognized option, stale state, expired deadline. This decision is advisory; executor rechecks preconditions and permissions.

## Job state machine
`QUEUED -> RUNNING -> WAITING_APPROVAL -> RUNNING -> VERIFYING -> SUCCEEDED` with `FAILED`, `CANCELED`, `UNKNOWN` terminal or reconciliation states. Define exact allowed transitions per feature; never mark success after an action dispatch without evidence.

## Effect ledger
Each intent: job ID, identity, tool, resource, semantic operation, idempotency key if provider supports, approval scope, precondition hash, attempt timestamp, acknowledgement, verification type/result, reconciliation pointer. Crash after submission but before acknowledgement => UNKNOWN, never unconditionally retry consequential operation.

## Provider capabilities
Model/provider ID, auth state, tool/vision/structured output, context size, rate limit, quota, price, permissions, timeout, failover. Preserve legacy provider aliases independently of `danlab/dani-free`.
