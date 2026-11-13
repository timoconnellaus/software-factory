# ADR 0304: Triage scores readiness and can ask

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

## Amendment, 2026-11-12 (spec 23 part A, the owner via the coordinator)
- **The pre-check parks only what no person released**: intake (issues, connectors), autopilot output,
  and anything an agent files or releases. A person who marks an item ready, releases it or sends it
  to shaping has judged it clear enough. The check never parks it; they see its result as a hint they
  can ignore (in the release response and on the item), and the question round is left to triage,
  whose job it is. Why: a word-count heuristic that parks a person's "Fix the typo in the README
  header" is the check being wrong, not the request. It is the same for every project; there is no
  setting.
- **Parking is the Backlog with a needs-info marker, not a status.** The universal states stay
  Backlog, the release (Ready → Queued) and Done (ADR 0491, 0493). A parked item sits in the Backlog
  with `core_work_items.needs_info`: who it waits on (the requester), why, the questions asked of
  them (their Inbox), and where it was heading. It holds no Workflow and no slot. Answering (or
  editing the request) re-runs the check with the answers appended to the request; passing, the
  item goes on to Ready, Queued or shaping as it was heading, so nobody releases it twice. A person
  may move a parked item on by hand; that withdraws its questions.

## Amendment, 2026-11-12 (review of #117)
**The pre-check is a floor for emptiness, not a judgement of clarity.** A keyword and word-count rule
parked 13 of 15 ordinary requests ("App crashes on startup on Windows 11", "Upgrade React to 19"),
and triage (an agent stage) already exists to ask what it needs. So the deterministic check parks
only what code knows for certain:
- nothing to act on: no body and a title of fewer than four words, or a body that is only a
  template's headings (or comments and its checklist, a checkbox line with its label) or only
  images or a link;
- an exact duplicate of an open item from the same source (same title and body).

Everything else goes to triage, which decides whether to ask.

**"A person released it" is the surface, not the actor type.** A human on the app, the desktop, the
phone or the sf CLI is a person. MCP is an agent acting with a person's token. Intake, the foreman,
autopilots and the improver aren't people either.

> Amended 2026-11-13 (follow-up to #117): a template's checklist lines count as template, label and
> all, and a body of only images parks, as the PR said it would.
