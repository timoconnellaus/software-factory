# ADR 0029: Decision domains

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Not every decision belongs to an engineer. On a medical product, a domain expert should decide
behaviour and UX while engineers decide architecture.

## Decision
- `.factory/` maps **decision domains** (product, architecture, security, ...) to owners.
- Triage tags which domains a work item touches. Each planning question and approval is tagged and
  routed to that domain's owner.
- Spec approval is split per domain.

## Consequences
- Open question: how to handle a domain that is touched but has no declared owner (fall back to the
  project approver, or block).
- Status note: the UI plan marks domains as proposed; this ADR records the product plan's decision.

> Amended 2026-11-11 (UI interview, `.kim/plans/2026-11-11-software-factory-ui-design.md`): the
> default domains are **product**, **architecture** and **security & privacy**; projects can add
> their own (e.g. clinical). When build touches a domain the spec did not plan for, the build pauses
> and sends a scoped question to that domain's owner while other work continues. Still open: a
> touched domain with no declared owner.
