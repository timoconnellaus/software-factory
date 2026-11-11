# Stage 2: Intake, the work-item Workflow, triage and the spec gate

Read first: ADRs [0005](../adr/0005-hybrid-coordinator.md),
[0006](../adr/0006-work-item-workflows.md), [0007](../adr/0007-human-gates-are-pending-actions.md),
[0013](../adr/0013-triage-sizes-the-spec-gate.md), [0018](../adr/0018-model-roles.md),
[0028](../adr/0028-planning-built-in.md); [stage 1](01-operations-and-store.md).

## Goal
A request typed into the CLI or a chat becomes a work item whose Workflow triages it, opens a spec
gate when policy says so, and waits for a person without blocking anything else.

## Scope
- CLI/chat intake: a `factory` command (in `local/runner-host` or a tiny bin in `packages/sdk`)
  and a chat endpoint on `sf-app` that both call `workItem.create` with actor `intake`.
- `apps/engine`: one Cloudflare Workflow per work item. Instance id derived from the intake event,
  so a duplicate never starts a second run.
- Triage stage: the foreman (model role `triage`) sizes the item (`small | medium | large`),
  drafts acceptance criteria and a living spec, and tags decision domains.
- Spec gate: when the project's preset requires a spec at that size, the Workflow
  `waitForEvent('approval-<id>')`. `spec.approve`, `spec.requestChanges` and `question.answer`
  operations deliver the event.
- Gates are pending actions: the operation that opens one returns `pending_approval`.
- Kill switch: one setting that pauses every Workflow at its next step.
- Model roles: a registry mapping `triage`, `implement`, `review`, `summarise` to a model; code never
  names a model id.

## Out of scope
Running code (stage 3), verify (stage 4), the UI (stages 11–13; tests drive operations directly),
decision-domain routing beyond tagging, intake from GitHub/Linear/Slack.

## Acceptance criteria
1. Creating a work item from the CLI and from the chat endpoint both start exactly one Workflow;
   replaying the same intake event starts none.
2. A small, clear request skips the spec gate; a medium one under a preset that requires specs
   stops at it.
3. `spec.approve` resumes the Workflow; `spec.requestChanges` sends it back to planning with the
   note.
4. The foreman cannot skip or open a gate: a test where the model output asks to skip the spec gate
   still stops there.
5. The kill switch pauses a running Workflow and resuming continues it.
6. Every gate decision is in the audit journal with the decider and the time the gate was open.
7. No source file outside the model-role registry contains a model id (a lint/test guard).
