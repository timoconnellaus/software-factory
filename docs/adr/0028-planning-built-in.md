# ADR 0028: Planning is built in

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Specs are better when written with the approver than for them. The interviewer patterns already work.

## Decision
- **Planning** is native to the factory: questions with defaults and recommendations, a **living spec**,
  mockups and system designs.
- It is used at triage, spec, agent questions, design review and greenfield kickoff.
- It is not an integration with an outside interviewer tool.

## Consequences
- Planning questions are pending actions routed by decision domain ([ADR 0029](0029-decision-domains.md)).
- Open question: planning scope in v1 (the UI plan leaves it open).
