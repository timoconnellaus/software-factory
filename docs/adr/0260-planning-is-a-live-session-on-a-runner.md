# ADR 0260: Planning is a live agent session on a runner, modelled on kim

Status: accepted, 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)).

## Context
V1 planning is one-shot. The spec run writes a JSON result with its questions and ends. The
Workflow waits for answers, then starts a fresh run with the answers pasted into the prompt (at
most two rounds, `QUESTION_ROUNDS`). There is no chat, no follow-up, no mockups or designs, and the
agent never sees an answer while it is working.

Keep it moving (kim, the interviewer) already does planning well, and it is well tested:
- questions with a default and a recommendation, and bulk accept;
- a living plan rewritten as answers arrive;
- chat, including per-question threads;
- mockups with option cards and live controls, and system designs with pinned comments;
- an agent that stays connected.

Two things make it work. First, the agent manages questions and the plan freely, through a client
(the `kim` CLI) for the server's operations. Second, kim's hooks bring answers back into the
agent's context:
- **`PostToolUse`** injects answers and chat after each tool call (throttled to about 15 s), so the
  agent sees them mid-task;
- **`UserPromptSubmit`** does the same when someone types to the session;
- **`Stop`** waits while the agent is idle, and wakes it when the person pauses (about 15 s), sends
  a chat message, or answers every open question.

## Decision
- **A factory-native rewrite, with kim as the reference.** No code is shared and there is no kim
  dependency. Planning lives in the factory's D1, operations, app and runner channel. These are
  copied from kim faithfully, as semantics:
  - the question model (types, default + recommendation, `acceptedDefault`, revisions);
  - hook delivery;
  - free management of questions (add, edit, reorder, delete, focus) and of the living spec;
  - the design formats (D2 / DBML / Mermaid / OpenAPI) with their checks and diagnostics;
  - pinned comments that name the element (`data-name`);
  - the `.kim/` folder conventions.

  Live mockup controls are in scope, but their mechanics may differ.
- **The planning agent is a resumable agent session on a runner.** Model credentials stay with the
  runner's owner (ADR 0023), so it never runs in the control plane. One planning session belongs to
  a work item and stays open from the moment the spec stage starts until the spec gate is decided.
- **The agent acts through factory operations.** The harness projects a planning MCP server that
  calls operations over the signed runner channel: `question.ask`, `question.update`,
  `question.delete`, `question.reorder`, `spec.revise`, `artifact.add`, `artifact.update`,
  `chat.reply`, `planning.yield`. Every call is scoped to the run's work item and fenced by its
  lease (no ambient authority). A result file is no longer how planning hands back.
- **Hooks deliver answers, as kim's do.** `harness-claude` projects `PostToolUse`,
  `UserPromptSubmit` and `Stop` hooks pointed at the runner channel. Live and async are one
  mechanism: the only differences are whether someone is present and how fast answers arrive. There
  are no question "rounds" and no batches on the agent's side.
- **Planning starts on its own.** When the spec stage starts, the agent reads the repo, drafts the
  spec and adds the first questions. Then an inbox card goes to the owner. When the owner opens the
  Planning tab, the session is live.
- **An idle session keeps its slot while there is room.** It waits in its Stop hook, spending no
  tokens and holding a light slot ([ADR 0261](0261-runner-capacity-has-heavy-and-light-pools.md)).
  It yields only when the light pool is full, and then only after about 5 minutes with nobody
  present and no new answers. A yielded session is resumed (`claude --resume`, the same
  conversation) by the next answer or chat message.
- **A session always resumes on the same runner.** While that runner is offline, the session waits
  and answers are saved. A person may choose **Continue on another runner**, which starts a fresh
  session rebuilt from the **planning record**: the spec revisions, questions, answers, chat and
  artifacts. The record must always be complete enough to restart from; the conversation is a
  cache.
- **Presence** (who has the Planning view open) is tracked by the app and shown to the agent, as
  kim shows `stageVisible`.

## Consequences
- Amends [ADR 0028](0028-planning-built-in.md) and [ADR 0042](0042-one-question-object.md).
  Questions stay the one object, with new fields for kind, options, order and revision. Interview
  sessions stay views over them. Escalation on timeout is unchanged and never auto-accepts.
- Amends [ADR 0100](0100-runner-contract.md): a planning job is long-lived and resumable. The
  runner keeps the session reference (`sessionRef`) across yields. A resume is a new job for the
  same session on the same runner.
- The spec stage of the work-item Workflow becomes "wait for the planning session to reach the
  gate", replacing the propose/ask/answer loop. Versioned per [ADR 0053](0053-workflow-versioning.md).
- Specs: [20](../specs/20-planning-loop.md) (M1, the loop), [21](../specs/21-planning-visuals.md) (M2, visuals),
  [22](../specs/22-planning-system-designs.md) (M3, system designs + `.kim/`), [23](../specs/23-triage-questions-and-critic.md) (M4, triage questions).
