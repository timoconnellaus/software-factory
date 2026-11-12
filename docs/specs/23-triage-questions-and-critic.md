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

## As built
### Part A: the readiness pre-check and parking (ADR 0304 as amended 2026-11-12)
- Who it applies to: only items no person released (intake, MCP, an autopilot, an agent). A person's
  ready, release or shape is never parked; `workItem.create`, `workItem.release` and `workItem.shape`
  return a `hint` instead, and `workItem.get` shows `readinessHint` while the item is in the
  Backlog or Ready. This replaces criterion 1's "a request" with "a request no person released".
- **Parking is not a `needs_info` status.** It is the Backlog with a marker, migration 0370's
  `core_work_items.needs_info` (block AR; block AE's numbers sit below 0261's rebuild of
  `core_work_items`). The marker holds `{ waitingOn, reason, source, missing, questionIds, heading,
  at }`. The question goes to the requester as an ordinary blocking question (their Inbox) with the
  fixed prompt; the backlog card and the item page show "needs info: …" as the status reason.
- The check (`packages/core/src/readiness.ts`) is a floor for emptiness, not a judgement of
  clarity (review of #117). It parks only an item with nothing to act on (no body and a title under
  four words, or a body that is only template headings or a link) or an exact duplicate of an open
  item from the same source (`core_work_items_project_title_idx`, migration 0371). Everything else
  goes to triage. "A person" is decided by the surface: the app, the desktop, the phone and the sf
  CLI are; MCP (an agent with a person's token), intake and automation aren't. The tests hold 15
  ordinary requests that must pass, and 6 empty ones that must park.
- Answering the last needs-info question, or editing the request, re-runs it. Passing: the marker
  clears, the answers are appended to the request, and the item goes to Ready, is released, or
  starts shaping, as it was heading. Failing: the requester is asked again. An agent can't move a
  parked item on; a person can, which withdraws its questions.
- Tests: `packages/core/test/readiness.test.ts`, plus `packages/db/test/late-migrations.test.ts`
  (this branch's migration applies after everything on main and survives a fresh build).

### Part B: triage's readiness (Workflow v8, provisional number)
- `triageResultSchema` gains `readiness` (`ready`, `needs_answers`, `not_actionable`; default
  `ready`), `readinessReason` and up to five `questions`. The triage prompt asks for them in v8
  instances, with the answers to an earlier round. `workItem.triage` journals the readiness and its
  reason with the size decision. It never touches the spec gate, which the autonomy policy decides
  as before (criterion 6).
- **`not_actionable`** (`triage: park`): `workItem.parkForInfo` parks the item in the Backlog with
  a needs-info marker (`source: "triage"`) and triage's questions to its requester. It resets
  the item for a fresh start and moves it to a new Workflow generation (`<id>-r2`, …), since an
  instance id can't be reused. Every Workflow create and release event now uses `workflow_id`.
  The instance ends (`parked`), and the slot is freed (a pull is requested). Answering re-releases
  it (or re-shapes it, as it was heading), and triage runs again on the new generation with the
  answers in the request (criterion 4).
- **`needs_answers`, no spec required** (a small item): `triage #k: ask` asks triage's questions as
  ordinary blocking questions, waits for the answers (escalating on timeouts as any question round),
  and triages again with them (`triage #k`, `#k: record`), at most two rounds. Then it goes on as
  triage last said (criterion 2). Deviation: the spec suggested a short planning session for this
  round; ordinary questions do the same with no session to manage, and answering re-runs triage as
  asked.
- **`needs_answers`, spec required** (medium or large): the planning session opens with triage's
  questions already asked (`planning: triage questions`, `planning.seedQuestions`), as the planner's
  open questions in the Planning tab (criterion 3).
- After review of #125:
  - `workItem.parkForInfo` parks only from the item's current Workflow instance while it is in
    triage. It's checked in the handler and guarded in the batch.
  - Triage parks an item at most three times (`TRIAGE_PARK_CAP`). At the cap the marker is
    `capped`, with every question asked across the cycles. Answering no longer re-releases it; a
    person moves it on.
  - A dead release on a later generation fails the item (freeing its slot). The item id comes from
    the `release-<itemId>` event type, not the `<id>-r2` instance.
- Tests: `apps/engine/test/triage-readiness.test.ts` (the three paths through the real Workflow),
  and core `readiness.test.ts` (parking on a new generation; seeding needs an open session). The
  version test freezes v8's step names.

