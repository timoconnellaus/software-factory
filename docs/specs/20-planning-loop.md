# Spec 20: Planning M1, the loop

Read first:
- ADRs [0300](../adr/0300-planning-is-a-live-session-on-a-runner.md),
  [0301](../adr/0301-runner-capacity-has-heavy-and-light-pools.md),
  [0302](../adr/0302-spec-provenance-coverage-and-critic.md), [0042](../adr/0042-one-question-object.md),
  [0100](../adr/0100-runner-contract.md), [0250](../adr/0250-runner-host-pushes-and-harness-projection.md);
- the plan [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md);
- mockups [`planning-three-pane.html`](../../.kim/mockups/planning-three-pane.html),
  [`planning-full-screen.html`](../../.kim/mockups/planning-full-screen.html) and
  [`planning-session-states.html`](../../.kim/mockups/planning-session-states.html);
- kim's hooks as the reference: `src/hook.ts` and `src/hooks.ts` in the
  [keep-it-moving](https://github.com/timoconnellaus/keep-it-moving) repo.

## Goal
A medium or large work item gets a planning agent that stays with it. The agent drafts the spec,
then adds, edits and deletes questions as answers arrive. It chats with the owner and revises the
living spec in front of them. When nobody is there, it waits without wasting a runner. This replaces
V1's one-shot spec run.

## Scope
- **Planning session**
  - A long-lived `planning` job in the light pool. It starts automatically when the spec stage
    starts.
  - The runner keeps the agent's `sessionRef` across yields. A resume is a new job for the same
    session on the same runner (`claude --resume`).
  - The session ends when the spec gate is decided.
- **Planning MCP server**, projected by `harness-claude`. Each tool calls an operation over the
  signed runner channel, scoped to the job's work item and fenced by its lease:
  - `question.ask`, `question.update`, `question.delete`, `question.reorder`, `question.focus`;
  - `spec.revise`, which takes the whole spec: body, criteria, assumptions, coverage and
    clarifications;
  - `chat.reply`;
  - `planning.yield`;
  - `planning.ready`, which asks for the spec gate.
- **Hooks**, projected by `harness-claude`:
  - `PostToolUse`: delivers news (answers, revisions, chat, presence) since the session's cursor,
    throttled to once per 15 s;
  - `UserPromptSubmit`: delivers the same;
  - `Stop`: waits on the channel and wakes the agent on a 15 s pause in answers, a chat message,
    or every open question answered. It yields when the scheduler asks.
- **Delivery**
  - Operations `planning.news { cursor }` and `planning.wait { cursor, idleMs, timeoutMs }` on the
    runner channel.
  - Every answer, revision, chat message and presence change is an event in a per-work-item
    planning log with a cursor.
- **Question model** (migration from block I):
  - `kind`: text, single-choice, multiple-choice, yes-no or number;
  - `options`;
  - `default`, which can be several values for multiple-choice;
  - `position`;
  - `revision`;
  - answers that can be revised (`answer.revised` is an event);
  - a note on any answer.

  `planning_round` is retired. Bulk accept, the security/irreversible rule and escalation on timeout
  are unchanged.
- **Chat**: `core_planning_messages`, one per message, from a person or the agent, optionally about
  a question, with replies. The operations are `chat.send` (person) and `chat.reply` (agent).
- **The living spec** gains Assumptions, Coverage and Clarifications sections and provenance tags
  (ADR 0302). `spec.revise` stores a new version, and the app highlights what changed.
- **Presence**: the app reports who has the Planning view open (`planning.presence`, heartbeat). The
  agent sees it in its news.
- **Capacity pools** (ADR 0301):
  - light and heavy pools in the capacity schema, `sf-runner --max-light`, and scheduler placement
    by pool;
  - a yield request to the oldest idle planning session when the light pool is full.
- **Runner offline**:
  - the session waits, and the planning view shows "Waiting for `<runner>`";
  - `planning.move { workItemId, runnerId? }` starts a fresh session rebuilt from the planning
    record. The prompt is built from the record: spec versions, questions and answers, chat, and
    artifacts by reference.
- **Workflow v3**: the spec stage waits for `planning.ready`, then opens the spec gate.
  - `spec.requestChanges` delivers the note into the same session as a chat message from the
    approver.
  - v1 and v2 instances run unchanged (ADR 0053).
- **App: the Planning tab**, layout A:
  - three panes: questions | spec | chat, with the gate bar at the bottom;
  - a full-screen toggle (F / Esc);
  - phone tabs;
  - the session pill in its states (attached, idle, paused, waiting for runner);
  - Continue on another runner;
  - provenance chips, with assumptions highlighted.

  Live updates over a WebSocket or SSE from the engine, not polling.

## Out of scope
Mockups, option cards, the canvas and pinned comments (spec 21); system designs and `.kim/` (spec
22); triage questions, the readiness check and the critic (spec 23); splits (spec 24); guests and
delegation (R1 milestone (c)); web push (spec 15).

## Acceptance criteria
1. A work item that triage sends to the spec stage starts one planning session on a runner with a
   free light slot. The first spec draft and its first questions appear without anyone opening the
   tab, and an inbox card says planning is ready.
2. While the agent is working (mid tool calls), an answer submitted in the app reaches it within 20
   s through `PostToolUse`. A test drives a fake harness and asserts the news it receives.
3. The agent can add one question, add four, edit one, reorder, and delete one in any order. Each
   change appears in an open Planning tab within 2 s, with no reload.
4. A chat message wakes an idle session immediately. The agent's reply appears in the chat, and its
   spec revision appears highlighted in the spec pane.
5. With the light pool full and another light job queued, an idle session with nobody present for 5
   minutes yields. A later answer resumes the same conversation (same `sessionRef`) on the same
   runner, and the agent sees every event since its cursor.
6. An idle session never yields while the light pool has room, and never holds a heavy slot. A build
   still starts while 6 planning sessions sit idle.
7. With the session's runner offline, answers are saved and the pill shows "Waiting for `<runner>`".
   "Continue on another runner" starts a fresh session whose prompt contains the full planning
   record, and the old runner's session is fenced when it returns.
8. Every planning operation from the runner is refused (`fenced`) once the job's lease is gone, and
   refused (`forbidden`) for any work item other than the job's.
9. Spec revisions carry provenance tags. Statements tagged `[assumption]` are highlighted in the app,
   and the committed spec keeps the tags and has the Assumptions, Coverage and Clarifications
   sections.
10. `spec.requestChanges` puts the note into the same session, and the agent revises without
    starting a new session. Approval ends the session and releases its slot.
11. Security & privacy and irreversible questions still can't be bulk-accepted. A blocking question
    still escalates to the backup owner on timeout and is never auto-accepted.
12. A v2 Workflow instance in its spec stage at deploy time finishes on the v2 path.
