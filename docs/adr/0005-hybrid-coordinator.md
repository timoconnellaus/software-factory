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
