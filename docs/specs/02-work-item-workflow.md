# Spec 02: Intake, the work-item Workflow, triage and the spec gate

Read first: ADRs [0005](../adr/0005-hybrid-coordinator.md),
[0006](../adr/0006-work-item-workflows.md), [0007](../adr/0007-human-gates-are-pending-actions.md),
[0013](../adr/0013-triage-sizes-the-spec-gate.md), [0018](../adr/0018-model-roles.md),
[0028](../adr/0028-planning-built-in.md), [0042](../adr/0042-one-question-object.md),
[0044](../adr/0044-kill-switch-scope.md); spike ADR 0110 (`spikes/workflow-gate/adr/`);
[spec 01](01-operations-and-store.md).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): one Workflow per work item stays, and this spec now
> owns its hard parts (send-back loops, versioning, limits, merged intake). LLM triage decides spec
> skips and logs the reason. Questions are one object. The kill switch is per org and per project.
> Gates block. Part of R1 milestone (a).

## Goal
A request typed into the CLI or a chat becomes a work item whose Workflow triages it, opens a spec
gate when policy says so, and waits for a person without blocking anything else.

## Scope
- CLI/chat intake: a `factory` command (in `local/runner-host` or a tiny bin in `packages/sdk`)
  and a chat endpoint on `sf-app` that both call `workItem.create` with actor `intake`.
- Intake dedupe: each intake event has a dedupe key (source + external id). A redelivered event is a
  no-op; a new event whose key maps to an existing work item **attaches** to it (a comment on the
  issue, a follow-up in Slack) instead of starting a second item. The dedupe key is separate from the
  Workflow id.
- `apps/engine`: one Cloudflare Workflow per work item, which:
  - runs send-back loops (spec → planning, verify → build) inside the one instance;
  - keeps steps small: payloads carry ids, large artifacts go to R2, under the Workflow step and
    payload limits;
  - survives deploys: an instance started on an older Workflow version finishes on it, or is
    migrated by a recorded, tested step;
  - releases its runner slot while it waits at a gate or is paused.
- Triage stage: the foreman (model role `triage`) sizes the item (`small | medium | large`),
  drafts acceptance criteria and a living spec, and tags decision domains. Whether the spec stage is
  skipped is the triage decision, bounded by the autonomy policy's threshold, and is **journaled with
  its reason**. The foreman's other decisions follow ADR 0005's binding/advisory table.
- Spec gate: when the autonomy policy requires a spec at that size, the Workflow blocks on
  `waitForEvent` (spike ADR 0110). `spec.approve` and `spec.requestChanges` deliver the event. On
  approval the spec is committed to `docs/specs/NN-*.md` on the work item's branch.
- Questions: `question.ask`, `question.answer` (ADR 0042). A blocking question pauses the
  Workflow like a gate. Each gate and blocking question has a timeout from the autonomy policy; on
  timeout it goes to the backup owner.
- Kill switch: per org and per project (ADR 0044). Pauses the affected Workflows at their next step.
- Model roles: a registry mapping `triage`, `implement`, `review`, `summarise` to a model; code never
  names a model id.

## Out of scope
Running code (spec 03), verify (spec 04), the UI (specs 11–13; tests drive operations directly),
routing questions by decision domain beyond tagging (R1 milestone (c)), intake from GitHub, Linear
or Slack, the Jev injection check (ADR 0047), speculative continuation past a gate.

## Acceptance criteria
1. Creating a work item from the CLI and from the chat endpoint both start exactly one Workflow;
   replaying the same intake event starts none; a second event with the same dedupe key attaches to
   the existing work item.
2. A small, clear request skips the spec gate, and the skip and its reason are in the audit journal
   and on the work item; a medium one under an autonomy policy that requires specs stops at it.
3. `spec.approve` resumes the Workflow; `spec.requestChanges` sends it back to planning with the
   note, in the same instance, and it can loop more than once.
4. The foreman cannot skip or open a gate: a test where the model output asks to skip the spec gate
   under a policy that requires it still stops there.
5. The kill switch for a project pauses that project's running Workflows and no others; the org
   switch pauses every project in the org; turning it off resumes them.
6. Every gate decision is in the audit journal with the decider and the time the gate was open.
7. No source file outside the model-role registry contains a model id (a lint/test guard).
8. A gate or blocking question that times out goes to the backup owner and is never auto-accepted.
9. An instance started before a deploy that changes the Workflow completes after it (a test across
   two Workflow versions).
