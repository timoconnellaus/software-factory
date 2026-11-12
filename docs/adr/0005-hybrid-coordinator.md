# ADR 0005: Hybrid coordinator: state machine owns gates, foreman picks the route

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
A coordinating agent is needed to move work items through stages without babysitting. An LLM alone
can be talked out of a gate; a fixed state machine alone cannot choose sensible routes.

## Decision
- A state machine on Cloudflare Workflows ([ADR 0006](0006-work-item-workflows.md)) owns the stages
  and the gates.
- The **foreman**, an LLM, picks the route within what the state machine allows: which stage next,
  which runner capabilities to ask for, whether to ask a planning question.
- Policy is enforced in code, never by a prompt. The foreman cannot skip or open a gate.

## Consequences
- A bad foreman decision costs time, never a merge or deploy without an approver.
- The foreman is reached through a model role ([ADR 0018](0018-model-roles.md)).

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): the **foreman's decisions** are listed explicitly. **Binding** means the Workflow acts on
> it without a person (it is still logged with a reason and can never open or skip a gate the
> autonomy policy requires); **advisory** means code or a person checks it before it takes effect.
>
> | Decision | Made at | Binding or advisory | Bounded by |
> | --- | --- | --- | --- |
> | **Size** (`small` / `medium` / `large`) and so whether the spec stage is skipped | triage | binding, logged with its reason ([ADR 0013](0013-triage-sizes-the-spec-gate.md)) | the autonomy policy's threshold; the merge gate always follows |
> | **Domains touched** | triage, and again on each build hand-back | binding for routing questions and approvals; it may only add domains during build, never remove the spec's | the domains `.factory/` declares ([ADR 0029](0029-decision-domains.md)) |
> | **Route**: next stage, capabilities to ask for, whether to ask a question | each stage boundary | advisory: the Workflow accepts only a stage the project's pipeline allows, and the scheduler places within `.factory/` limits | pipeline, capabilities allowed, WIP limit |
> | **Retry or escalate** after a failed run | each failed run | binding up to the retry limit; escalation to a person is always allowed, retry past the limit never is | retry limit, cascade and depth limits ([ADR 0006](0006-work-item-workflows.md)) |

> Amended 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)): a new foreman decision, **readiness** at triage: binding, logged with its reason, and bounded by the autonomy policy ([ADR 0304](0304-triage-scores-readiness-and-can-ask.md)). The spec critic is advisory and can't open or skip the gate ([ADR 0302](0302-spec-provenance-coverage-and-critic.md)).

> Amended 2026-11-12 ([ADR 0351](0351-workflows-are-presets-over-typed-slots.md), spec 08 M2): the state machine still owns the stages and gates, as a fixed skeleton with three typed slots. Projects fill the slots with named workflows. **Triage picks the workflow**: a binding foreman decision, logged with its reason, that a person can change until build. Workflows only add steps, so a wrong pick can't skip a gate.
