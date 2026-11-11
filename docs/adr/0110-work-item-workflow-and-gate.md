# ADR 0110: A Workflow per work item, gated through the operation pipeline

Status: accepted, 2026-11-11. Proposed by the spike `spikes/workflow-gate`; promoted into `packages/core` and `apps/engine` by the V1 core + engine build. Fills in the mechanics of ADRs 0004, 0006, 0007, 0008, 0011, 0012 and 0013, and amends ADR 0004's risk classes.

## Context

The plan makes the coordinating agent a hybrid: a state machine owns the gates and an LLM picks the route within them, so policy is enforced in code, never by a prompt. Every factory verb is a registered operation run through one `invoke()` pipeline (actor × risk class gate, presets + floor, audit, outbox), as in the CRM (its ADRs 0003, 0017, 0018, 0130, 0171). We need to decide how work items, their stages and their human gates are executed on Cloudflare.

## Decision

**One Cloudflare Workflow instance per work item.**
- The instance id is derived from the intake event: `wi-` + the first 32 hex chars of SHA-256(`source` NUL `externalId`). The work item uses the same id. A redelivered event finds the work item (`duplicate: true`) and, if the start is retried, `create` reports the existing instance. One work item, one run.
- Stages run in order: intake → triage → spec gate (only for work triage sizes `large`) → build (a runner job) → verify (review packet) → merge gate. Each stage is one `step.do` that calls one operation through `invoke()`, as actor `agent` (or `runner` for the job's hand-back), with idempotency key `<instanceId>:<step name>`.

**The gate decides where a work item pauses; the Workflow only reacts.**
- Gate decisions come from `invoke()`: preset (Cautious, Balanced, Autonomous) for actor × risk class, `merge`/`deploy`/`self-modify` always reviewed for non-humans, then every matching floor rule (env `APPROVAL_FLOOR`; `actor|*` → `risk|*` → decision). The strictest wins, so the floor only tightens. A malformed floor denies every call; an unknown preset is Cautious.
- Risk classes: `read`, `write`, **`plan`** (accepting a spec), `spend`, `outbound`, `merge`, `deploy`, `self-modify`. `plan` is reviewed for agents in every preset, so a spec always needs an approver (ADR 0013). Small work skips it because triage routes it past the spec stage.
- `review` records a pending action (with its audit row and a `notify` outbox row, in one D1 batch) and returns `pending`. The Workflow then waits on `step.waitForEvent({ type: "approval-<pendingActionId>", timeout: "7 days" })`.
- `approval.decide` (humans only) records the decision and writes a `workflow.event` outbox row in the same batch. After commit the outbox sends the event.
- Approved: the Workflow re-runs the operation with the approval. The pipeline checks it matches (operation, actor type, work item, status), re-evaluates the gate (`deny` still refuses), runs the handler and marks the action `applied` in the same batch. Rejected → the work item closes `rejected`. Timeout → `expired`.

**Every change is one batch: writes + audit row + outbox rows.** The audit journal is append-only (triggers) and holds one row per write, refusal and failure, with actor, origin, risk, gate decision, outcome and the pending action or approval. Metrics are views over it. Workflow starts, gate events and terminations are outbox messages delivered after commit and retried by a minute cron with backoff.

**Kill switch.** A setting, changed only by humans (`factory.setKillSwitch`, risk `self-modify`). Turning it on bumps `kill_epoch`, moves running work items to `paused` and pauses their instances through the outbox (ADR 0006). While it is on, `invoke()` refuses every non-human write (`killed`), so nothing advances and no intake is accepted; humans can still decide gates. A step refused mid-flight parks on `waitForEvent("factory-resume-<epoch>")`. Turning it off moves the items back to `running`, resumes the instances and sends them that event; a parked step runs again under a new step name. The epoch in the event type stops a stale event from releasing a later park.

## Consequences

- Workflow code holds no policy. Moving a project from Balanced to Autonomous, or tightening the floor, changes where work pauses without a deploy.
- Waiting at a gate costs nothing; the inbox lists gates from `pending_actions`, not from Workflow status (which local Miniflare reports as `running` while waiting).
- A step can retry after its operation committed; the audit row's unique idempotency key returns the first outcome instead of applying twice or opening a second gate.
- Stage order is fixed in code for v1. Configurable pipelines (`.factory/` stages, content work) will need the Workflow to read a stage list; the gate mechanics stay the same.
- The spec gate depends on the new `plan` risk class. If we drop it, the spec gate needs another way to always pause outside Autonomous.

## Open questions

- Kill switch scope (factory, org or project).
- Whether an unknown preset should deny every call (ADR 0008 "fails closed") rather than fall back to Cautious.
- Escalation before a gate expires.
- Whether the applied audit row should name the approver as well as the original actor.

> Amended 2026-11-11 (V1 core + engine, promotion). What changed from the spike:
> (1) the gate answers `allow | review | deny` (not `auto`), and an unknown or malformed policy
> **denies** every non-human call (ADR 0008 "fails closed"), instead of falling back to Cautious;
> (2) the instance id is the work item id (`wi_<32 hex>`, random), **not** derived from the intake
> event: intake dedupe is `core_intake_events` (event id → no-op on redelivery) and
> `core_intake_keys` (dedupe key → attach to the existing item), per the ADR 0006 amendment;
> (3) the policy is the project's `.factory/policy.json` at a default-branch SHA
> ([ADR 0054](0054-factory-policy-file.md)), recorded on every audit row; the floor is env `FACTORY_FLOOR`;
> (4) gates have kinds: `spec` (`spec.accept`, risk `plan`), `merge` (`pr.merge`, risk `merge` or
> `self-modify`) and `approval` (anything else the gate sends to review). People decide them with
> `spec.approve` / `spec.requestChanges`, `review.merge` / `review.sendBack` and `approval.decide`; a
> second identical decision reports `alreadyDecided`. Changes requested and sent back loop inside the
> one instance (spec → planning, merge → build). The decision records who, when, the gate's open time
> and whether the full diff was opened;
> (5) a gate never expires the item: on timeout it is reassigned to the backup owner and waits again;
> (6) the kill switch is per org and per project (ADR 0044) with an epoch per switch; a parked step
> waits on `resume-<scope>-<id>-<epoch>`; turning a switch on also cancels the covered runs and bumps
> their fencing tokens, so their slots are freed;
> (7) only a real `waitForEvent` timeout is treated as one: the engine aborting a run for a pause must
> propagate, or the Workflow would act while paused (found by the kill-switch test);
> (8) versioning across deploys is [ADR 0053](0053-workflow-versioning.md).

