# ADR 0110: A Workflow per work item, gated through the operation pipeline

Status: proposed, 2026-11-11 (spike `spikes/workflow-gate`). Moves to `docs/adr/` when accepted.

## Context

The plan makes the coordinating agent a hybrid: a state machine owns the gates and an LLM picks the route within them, so policy is enforced in code, never by a prompt. Every factory verb is a registered operation run through one `invoke()` pipeline (actor × risk class gate, presets + floor, audit, outbox), as in the CRM (its ADRs 0003, 0017, 0018, 0130, 0171). We need to decide how work items, their stages and their human gates are executed on Cloudflare.

## Decision

**One Cloudflare Workflow instance per work item.**
- The instance id is derived from the intake event: `wi-` + the first 32 hex chars of SHA-256(`source` NUL `externalId`). The work item uses the same id. A redelivered event finds the work item (`duplicate: true`) and, if the start is retried, `create` reports the existing instance. One work item, one run.
- Stages run in order: intake → triage → spec gate (only for work triage sizes `large`) → build (a runner job) → verify (review packet) → merge gate. Each stage is one `step.do` that calls one operation through `invoke()`, as actor `agent` (or `runner` for the job's hand-back), with idempotency key `<instanceId>:<step name>`.

**The gate decides where a work item pauses; the Workflow only reacts.**
- Gate decisions come from `invoke()`: preset (Cautious, Balanced, Autonomous) for actor × risk class, `merge`/`deploy`/`self-modify` always reviewed for non-humans, then every matching floor rule (env `APPROVAL_FLOOR`; `actor|*` → `risk|*` → decision). The strictest wins, so the floor only tightens. A malformed floor denies every call; an unknown preset is Cautious.
- Risk classes: `read`, `write`, **`plan`** (accepting a spec), `spend`, `outbound`, `merge`, `deploy`, `self-modify`. `plan` is reviewed in Cautious and Balanced and auto in Autonomous.
- `review` records a pending action (with its audit row and a `notify` outbox row, in one D1 batch) and returns `pending`. The Workflow then waits on `step.waitForEvent({ type: "approval-<pendingActionId>", timeout: "7 days" })`.
- `approval.decide` (humans only) records the decision and writes a `workflow.event` outbox row in the same batch. After commit the outbox sends the event.
- Approved: the Workflow re-runs the operation with the approval. The pipeline checks it matches (operation, actor type, work item, status), re-evaluates the gate (`deny` still refuses), runs the handler and marks the action `applied` in the same batch. Rejected → the work item closes `rejected`. Timeout → `expired`.

**Every change is one batch: writes + audit row + outbox rows.** The audit journal is append-only (triggers) and holds one row per write, refusal and failure, with actor, origin, risk, gate decision, outcome and the pending action or approval. Metrics are views over it. Workflow starts, gate events and terminations are outbox messages delivered after commit and retried by a minute cron with backoff.

**Kill switch.** A setting, changed only by humans (`factory.setKillSwitch`, risk `self-modify`). While on, `invoke()` refuses every non-human write (`killed`), so no stage can advance and no intake is accepted. Turning it on also marks running work items `stopped` and terminates their instances through the outbox.

## Consequences

- Workflow code holds no policy. Moving a project from Balanced to Autonomous, or tightening the floor, changes where work pauses without a deploy.
- Waiting at a gate costs nothing; the inbox lists gates from `pending_actions`, not from Workflow status (which local Miniflare reports as `running` while waiting).
- A step can retry after its operation committed; the audit row's unique idempotency key returns the first outcome instead of applying twice or opening a second gate.
- Stage order is fixed in code for v1. Configurable pipelines (`.factory/` stages, content work) will need the Workflow to read a stage list; the gate mechanics stay the same.
- The spec gate depends on the new `plan` risk class. If we drop it, the spec gate needs another way to always pause outside Autonomous.

## Open questions

- Kill switch scope (factory, project or runner) and whether turning it off restarts stopped items.
- Escalation before a gate expires.
- Whether the applied audit row should name the approver as well as the original actor.
