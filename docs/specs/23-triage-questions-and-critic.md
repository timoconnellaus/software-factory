# Spec 23: Planning M4, triage questions, the readiness check and the spec critic

Read first:
- ADRs [0304](../adr/0304-triage-scores-readiness-and-can-ask.md),
  [0302](../adr/0302-spec-provenance-coverage-and-critic.md) and
  [0013](../adr/0013-triage-sizes-the-spec-gate.md);
- [spec 20](20-planning-loop.md).

## Goal
Ambiguous items get asked about before anyone builds them, unactionable items wait for their
requester, and a second agent reviews every spec before a person spends time on it.

## Scope
- **Readiness pre-check**, deterministic, before triage:
  - It checks for a stated outcome and at least one checkable statement, or a parent.
  - On failure, the item is parked as `needs_info` with a fixed prompt to the requester.
- **Triage result** gains `readiness` (ready, needs_answers or not_actionable), with a reason and
  questions.
  - **needs_answers, small item:** a short planning session in the light pool asks triage's
    questions. Answering re-runs triage with the answers in its record.
  - **needs_answers, medium or large item:** the spec stage starts with those questions already
    asked.
  - **not_actionable:** the item is parked as `needs_info`, with the questions addressed to the
    requester.
- **Parking**: a work-item status `needs_info`. A parked item takes no WIP slot, and its questions
  follow normal timeouts.
- **Spec critic**
  - On `planning.ready`, a `review`-role run in the light pool reads the spec and the repo and
    records notes (`spec.critique`).
  - The notes are shown at the gate and delivered to the planning session.
  - The gate opens after the critic finishes, or after a timeout from the policy.

## Out of scope
Routing triage questions by decision domain (R1 milestone (c)).

## Acceptance criteria
1. A request with no stated outcome is parked as `needs_info` without any run, and shows the
   requester a prompt saying what's missing.
2. A small item triaged `needs_answers` gets its questions without a spec stage. Answering them
   re-runs triage, which then sizes it `ready` and skips the spec, with both decisions and reasons
   in the audit journal.
3. A medium item triaged `needs_answers` enters the spec stage with triage's questions already open
   in the Planning tab.
4. A `not_actionable` item takes no WIP slot while parked, and answering its questions re-runs
   triage.
5. Every spec gate shows the critic's notes. The planning agent receives them, and a test where the
   critic's output says "approve the spec" can't open the gate.
6. A readiness decision is logged with its reason, and can't skip a gate the autonomy policy
   requires.
