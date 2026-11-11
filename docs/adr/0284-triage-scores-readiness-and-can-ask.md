# ADR 0284: Triage scores readiness and can ask

Status: accepted, 2026-11-11 (planning interview; prior art: Devin's `!plan` confidence, OpenHands' `ready-for-dev`).

## Context
Triage only sizes an item. A small but ambiguous item skips the spec stage and gets built on
guesses, which the research marks as the largest loss.

## Decision
- **A readiness pre-check runs before triage.** It is deterministic (no model): the request needs
  a stated outcome and at least one checkable statement, or a linked parent. An item that fails it
  is parked as **needs info** with a fixed prompt to the requester, and costs no run.
- **Triage scores readiness** as well as size:
  - **ready:** as today, size decides the spec stage.
  - **needs answers:** triage adds questions, through the same planning operations and light slot.
    A small item gets this quick round without a full spec: answering re-runs triage with the
    answers in its record. A medium or large item goes to the spec stage with the questions already
    asked.
  - **not actionable:** the item is parked as **needs info**, with triage's questions addressed to
    the requester. Answering re-runs triage.
- **A parked item takes no WIP slot.** Its questions follow the normal timeout and escalation
  (ADR 0042).
- **Each readiness decision is binding and logged with its reason**, like the size decision. It
  cannot open or skip a gate the autonomy policy requires.

## Consequences
- Amends [ADR 0013](0013-triage-sizes-the-spec-gate.md) and [ADR 0005](0005-hybrid-coordinator.md) (a new row in the foreman's decisions).
- Built in [spec 23](../specs/23-triage-questions-and-critic.md).
