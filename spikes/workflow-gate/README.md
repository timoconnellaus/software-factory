# Spike: a Workflow per work item, with approval gates

Status: done, 2026-11-11. Standalone package; not in the workspace. Proposed ADR: [`adr/0110-work-item-workflow-and-gate.md`](adr/0110-work-item-workflow-and-gate.md).

**Question:** can the factory's control plane (operations, gate, audit, outbox, one durable state machine per work item, a human inbox) be built on Cloudflare with the CRM's patterns, and does it hold up locally in wrangler/Miniflare?

**Answer: yes.** The whole loop runs locally and under the Vitest workerd pool: intake → triage → spec gate → build (stub runner job) → verify (stub) → merge gate → done, with the gates decided by policy in code and resumed from an inbox.

## Run it

```sh
cd spikes/workflow-gate
pnpm install
pnpm test        # 37 tests, workerd pool
pnpm typecheck && pnpm lint
pnpm dev         # applies the local D1 migration, then http://localhost:8787
```

Then open the inbox, add work ("needs a spec"), and Approve/Reject the gates as they appear. Or post intake events:

```sh
curl -X POST localhost:8787/api/intake -H 'content-type: application/json' \
  -d '{"source":"github","externalId":"issue-42","title":"Add dark mode","size":"large"}'
```

Sending the same event twice returns `duplicate: true` and starts nothing.

## What's here

| File | What |
| --- | --- |
| `src/ops/define.ts` | `defineOperation` (name, zod input/output, description, risk class, allowed actors) and the registry (`describeOperations` = the future MCP `describe_operations`) |
| `src/ops/gate.ts` | Actor × risk class → `auto`/`review`/`deny`. Presets Cautious/Balanced/Autonomous, `ALWAYS_REVIEW` (merge, deploy, self-modify), a floor that can only tighten, fail-closed parsing |
| `src/ops/invoke.ts` | The single pipeline: idempotency → validate → actor check → kill switch → gate → handler → **one D1 batch** of writes + audit row + outbox rows → deliver outbox |
| `src/ops/outbox.ts` | Post-commit delivery (start Workflow, send gate event, terminate, notify) and the cron retry with backoff |
| `src/ops/operations.ts` | `workItem.intake`, `workItem.triage`, `spec.accept`, `build.record`, `verify.record`, `pr.merge`, `workItem.close`, `approval.decide`, `factory.setKillSwitch`, `policy.setPreset` |
| `src/workflow.ts` | `WorkItemWorkflow`: one instance per work item; each stage is one journaled operation call |
| `src/inbox.ts`, `src/index.ts` | Plain-HTML inbox (pending gates with Approve/Reject, work items, preset, kill switch), JSON intake, cron |
| `migrations/0001_init.sql` | `work_items`, `pending_actions`, `audit` (append-only by trigger), `outbox`, `settings` |
| `test/` | `gate.test.ts` (decisions, floor clamping, fail closed), `invoke.test.ts` (audit + outbox batch, atomicity, review, approval re-run, kill switch, idempotency), `workflow.test.ts` (pause at gates and resume on approval, duplicates, reject, Autonomous, expiry, kill switch) |

## How a gate works

1. The Workflow calls an operation as actor `agent` inside `step.do` (e.g. `spec.accept`, risk `plan`; `pr.merge`, risk `merge`). The idempotency key is `<instanceId>:<step name>`, so a retried step returns the first outcome.
2. The gate says `review` → the pipeline does not run the handler. It writes a `pending_actions` row, an audit row (outcome `review`) and a `notify` outbox row in one batch, and returns `{ status: "pending", pendingActionId }`.
3. The Workflow waits: `step.waitForEvent("<stage>: wait", { type: "approval-<pendingActionId>", timeout: "7 days" })`.
4. A human taps Approve → `approval.decide` (humans only) updates the pending action and writes a `workflow.event` outbox row in the same batch; after commit the outbox calls `instance.sendEvent`.
5. The Workflow resumes and re-runs the operation with `approvalId`. The pipeline checks the approval matches (same operation, actor type, work item, status `approved`), re-evaluates the gate (`deny` still refuses, e.g. if the floor tightened meanwhile), runs the handler and marks the action `applied` in the same batch. An approval is used once.

Reject → `workItem.close(rejected)`. Timeout → `workItem.close(expired)`. If the gate says `auto` (e.g. `plan` under Autonomous) the stage just runs, with no pause.

## Findings

1. **Workflows fit the work item well.** Durable steps, free waiting, `waitForEvent` buffering early events, and `create` rejecting duplicate ids give the idempotent "one instance per intake event" for free. Instance id = `wi-` + the first 32 hex chars of SHA-256(`source` NUL `externalId`); the work item uses the same id.
2. **The gate belongs in `invoke()`, not the Workflow.** The Workflow never decides whether to pause; it calls an operation and reacts to `pending`. Changing the preset or floor changes where work pauses without touching Workflow code. This is the CRM's "review pause" (its ADR 0130) almost unchanged.
3. **The outbox is a good bridge to Workflows.** Starting the Workflow (`workflow.create`), resuming it (`workflow.event`) and stopping it (`workflow.terminate`) are outbox messages written in the same batch as the state change. A failed send leaves the row for the minute cron; Workflow ids and one-shot event types make redelivery harmless.
4. **Idempotency keys on the audit row are needed.** A `step.do` can retry after its operation committed. Keying the audit row (`UNIQUE idempotency_key`) and returning the stored outcome stops a retry from opening a second gate or applying twice. Failed outcomes don't claim the key, so they can be retried.
5. **`plan` needs its own risk class.** With the research doc's seven classes, accepting a spec is a `write`, which Balanced auto-approves, so the spec gate would never pause. Adding `plan` (review in Cautious and Balanced, auto in Autonomous) gives the plan's "bigger tasks need your approval".
6. **Local Miniflare reports a waiting instance as `running`.** `instance.status()` never showed `waiting` during `waitForEvent` locally, and the introspector's `waitForStatus("waiting")` hangs. Tests wait for the gate's request step with `waitForStepResult` and assert nothing after the gate has happened. The inbox lists gates from `pending_actions`, not from Workflow status, which is what you want anyway.
7. **Test tooling is good enough.** `introspectWorkflowInstance` + `waitForStepResult` + `forceEventTimeout` cover pause, resume and expiry without sleeping. Real `sendEvent` through the outbox works against introspected instances.
8. **D1 batch = transaction is enough** for one operation's writes + audit + outbox (CRM ADR 0018). The test with a duplicate key shows nothing is applied, no outbox row, and a separate `failed` audit row.

## Deliberate shortcuts (not for production)

- No auth: inbox actions run as human `local`. No CSRF protection on the forms.
- Raw D1 statements, no Kysely. No field-level diffs in the audit row.
- `review` doesn't dry-run the handler (the CRM previews the change); the pending action stores the input only.
- Reads aren't audited. Validation failures aren't audited.
- Triage, build, verify are stubs; `build.record` stands in for a runner hand-back over the signed channel.
- `notify` outbox rows only log; there's no push.
- Settings (preset, kill switch) are factory-wide; the plan wants the preset per project from `.factory/`.
- The kill switch terminates running instances and marks their work items `stopped`; turning it off does not resume them.

## Open questions

- **Risk class `plan`**: keep it, or make the spec gate an `alwaysReview`-style per-operation flag instead?
- **Kill switch scope**: factory-wide (as here), per project, or per runner? Should "off" offer to restart stopped items?
- **Gate timeout**: 7 days, then `expired`. Should expiry escalate (notify again) before ending the item?
- **Approver identity**: approval re-runs as the original actor (`agent:foreman`). Should the audit row also carry the approver (it's on the pending action today)?
- **UI**: plain HTML here. The real inbox is TanStack Start + shadcn (docs/ui-plan.md); not attempted in the spike.
