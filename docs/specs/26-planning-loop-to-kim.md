# Spec 26: The planning loop, to kim's standard

Read first: the [audit against kim](../reviews/2026-11-12-planning-against-kim.md), [spec 20](20-planning-loop.md),
ADRs [0350](../adr/0350-how-the-planning-loop-is-wired.md) and [0470](../adr/0470-planning-steering.md),
and the planning screens in `docs/design/factory-ui/` (`ItemPlan.html`, `PlanFocus.html`, `PlanFocusMockup.html`).

## Goal
Fix what spec 20 built wrong or weaker than kim, and give people the steering the approved design
shows. Afterwards a person's word always reaches the planner before the spec reaches the gate, and
a person can redirect, interrupt, stop, pause or hand off the planner from the Planning tab.

Planning logic keys on the planning session, never on the work item's lifecycle state (spec 50 may
move planning before release).

## Scope
Three PRs.

**A. The loop** (core, runner-contract, harness-claude):
- PostToolUse looks for news at most every 2 s, not 15 s. `planning.news` writes nothing when
  nothing changed.
- `planning.ready` is refused while a person's answer or message is undelivered.
- A person's chat message, answer or revised answer while the spec waits at the gate withdraws the
  gate and starts the next round. The Workflow's planning stage handles `withdrawn`.
- Oversize news keeps answers and messages, drops presence first, and names the right cursor for
  the rest.
- Chat news carries `about: { questionId, number, prompt }`. Answer news carries `skipped`.
- People may skip a planning question (`question.answer { skipped: true }`). A skipped question
  counts as answered, and the agent decides it.
- Kim's size limits on planning questions: prompt 10,000 characters, recommendation 20,000, 100
  options.
- Read receipts: an answer and a person's message record when they reached the agent, for exactly
  the events delivered.
- After the first announcement, questions the agent asks and its chat replies notify the owner, once
  per call, when nobody has the Planning view open.
- `run.steer` on a planning run also stores the text in the chat (delivered).

**B. Steering** (core, runner-contract, the runner adapter's `interrupt` capability, the host's
steer loop):
- `chat.send { interrupt: true }`, `planning.stop`, `planning.pause`, `planning.resume`,
  `planning.finishAlone { on }`, as ADR 0470 describes.
- Answering planning questions from the desktop without a presence proof (`planning.answer`,
  `planning.acceptDefaults`): the owner's decision of 2026-11-12, ADR 0042 and 0391 as amended.

**C. The Planning tab** (inside the planning components of `apps/desktop` and `apps/app` only):
- Skip, read receipts, the question number on chat threads.
- Chat: Enter sends after the current step, ⌘-Enter interrupts.
- Stop on the activity line, Pause and Resume, "Let the planner finish alone".
- Desktop: updates when the engine says something changed, not on a 3 s poll.
- The plan is a plain document in its pane (only the Canvas tab is a canvas).

## Out of scope
Dropping Touch ID from the spec and merge gates (being confirmed with the owner separately). People editing the plan and
comments on its parts (slice 2, next). Mockups, designs and splits (specs 21, 22, 24).

## Acceptance criteria
1. A person's chat message sent while the agent works reaches it at its next tool call 2 s or more
   after the last look. A test drives the hook with a fake relay.
2. `planning.ready` with a person's answer or message undelivered is refused (`conflict`), and
   succeeds once the agent has read the news.
3. A person's chat message or answer while the spec waits at the gate withdraws the pending
   `spec.accept`, moves the round on, and lets the agent revise and ask for the gate again in the
   same session. An engine test drives the Workflow through it.
4. News over 9,500 characters keeps every answer and message. When it still has to be cut, the
   pointer names a cursor that returns every event that was cut.
5. A skipped question reaches the agent as `skipped: true`, counts as answered for
   `planning.ready`, and is refused for questions outside a planning session.
6. Chat news about a question carries its number and prompt.
7. An answer and a message show when they reached the agent. Events past the page a delivery read
   stay undelivered.
8. Questions asked and replies sent after the announcement notify the owner when nobody is present,
   and not when someone is.
9. A steer on a planning run appears in the planning chat and is not delivered a second time as news.
10. An interrupt stops the agent's current step and the agent then reads the message as news. A
    runner without `interrupt` gets the message after the current step, and the app says so.
11. A paused session isn't woken by news and resumes with everything since its cursor. Stop ends
    the agent's current step without ending the session.
12. With finish alone on, every bulk-acceptable question, asked before or after, is accepted with its
    default and logged as accepted by the person who turned it on. Security, privacy, irreversible
    and no-default questions still wait for a person. Approval is still a person's.
13. From the desktop, `planning.answer` and `planning.acceptDefaults` need no presence proof. From a CLI
    token they are refused. Questions outside a planning session and every gate keep their proof.
14. The Planning tab shows all of the above (before and after screenshots in each UI PR), and the
    desktop's view updates within 2 s of a change without polling.

## As built
**PR A, the loop.** Migration 0240 (`core_questions.skipped`, `answer_delivered_at`).
- `PLANNING_NEWS_THROTTLE_MS` is 2 s. `planning.news` writes the session row only when its status
  or activity changes, or every 30 s for `agent_seen_at`.
- `planning.ready` reads the news since the session's cursor and refuses (`conflict`) when a
  person's answer or message is in it. It also withdraws a spec gate the Workflow opened after a
  take-back (a stale gate).
- `takeBackFromGate` (in `packages/core/src/planning.ts`) runs on `chat.send`, `question.answer`
  and `question.acceptDefaults` while the session is at the gate. It moves the round on, withdraws
  the pending `spec.accept` (`decision: "withdrawn"`, the approval event to the Workflow) and logs
  `gate.withdrawn`. `spec.approve`, and `approval.decide` approving a spec gate, refuse a stale gate
  (`assertSpecGateCurrent`). The Workflow's planning stage `continue`s on `withdrawn`.
- `fitNews` in `harness-claude` drops presence first, then shortens long texts, then reports a
  count. Its pointer is the cursor just before the first event.
- News: `about` on chat messages; `skipped` and a nullable `answer` on answers. `question.answer`
  takes `skipped: true` for planning questions only.
- Read receipts: `deliver()` marks exactly the answers and messages it delivered. `planning.get`
  returns `skipped` and `answerDeliveredAt`.
- `notifyAway` sends `planning.question` and `planning.reply` notices after the announcement, when
  nobody is present.
- `run.steer` on a planning run writes a delivered chat message and logs `chat.steered` (not news).
- After review (fixes on #67):
  - Every check is guarded in the operation's batch:
    - `planning.ready` guards "nothing from a person is unread" and "the round hasn't moved";
    - `takeBackFromGate` guards "not at the gate" when it doesn't act, and "still at the gate,
      gate still pending" when it does. It leaves a gate that was just decided alone;
    - approving a spec gate guards "the planner still stands behind it".
    The loser of a race is refused as `conflict` and retried. A core test races `planning.ready`
    against a chat, and an approval against a chat at the gate.
  - Delivery is confirmed by the hook. `planning.news` and `planning.wait` take `ack` (the cursor
    the hooks last showed the agent) and `hold` (don't mark this call's news read). The hooks save
    the cursor they showed only after printing it. `planning_ready` sends the same `ack` through the
    MCP server.
  - `fitNews` never drops answers or messages. Long texts are shortened, and events that don't fit
    come at the next step, because only the shown cursor is acknowledged.
  - `planning.peek` (read risk) comes first, so a look with nothing new and the same activity costs
    no write and no audit row.
  - `hasUnreadPersonNews` counts without the 500-event page.
  - A planning steer's chat message is marked read when the host takes the steer (`steer_id`), and
    it takes the spec back from the gate.
  - Away notices go once per burst (`notified_at`, 2 minutes).
- After the second review (fixes on #67):
  - The agent can't forge its read cursor. `ack`, `hold` and `cursor` are not in its MCP tool
    schemas (`PLANNING_TOOL_INPUTS`), and the MCP server forwards only what the tool's schema
    parsed. On the server, an `ack` is clamped to `handed_cursor` (the highest cursor this session
    was handed), and a `cursor` only re-reads, never past what was delivered.
  - Receipts are per answer revision. `handed_answers` records the revision each answer was handed
    at, and an ack stamps a question only if that revision is still current. News answers carry
    `revision`.
  - The hook acknowledges only events shown whole: a shortened one stays unread until the agent
    reads it with `planning_news`.
  - A message that loses the race to an approval is told so (`chat.send`'s `note`).
  - The race tests are deterministic. `InvokeDeps.beforeCommit`, a test seam, holds one call
    between its reads and its commit while the other runs, in both orders.
- Not in A: the interrupt, Stop, Pause and finish alone (PR B), and the UI (PR C).

**PR B, steering.** Migration 0241 (`core_run_steers.interrupt`, `core_planning_sessions.paused_at`,
`paused_by`).
- The `interrupt` capability and `adapter.interrupt` in runner-contract. runner-local declares it:
  it presses Escape, waits 500 ms, then types the line as a steer does. The host's steer loop calls
  `interrupt` for a steer marked `interrupt` and falls back to `steer` when the adapter can't.
- `interruptPlanning` (core) queues a steer with one of `PLANNING_INTERRUPT_LINES`, only while the
  session is `working` and its runner declares `steer` and `interrupt`. `chat.send { interrupt }`
  returns `interrupted` and a `note` when it couldn't.
- `planning.stop`, `planning.pause` (no wake on news while paused; interrupts a working planner),
  and `planning.resume` (logs `planning.resumed`, a user event that settles at once and reaches the
  agent as news; resumes a yielded session). `planning.get` gains `paused`, `pausedBy` and
  `canInterrupt`.
- `planning.answer` and `planning.acceptDefaults` are `desktopDecidable` (a new operation flag:
  `invoke()` skips the browser-only refusal on the desktop surface). Planning questions only.
- `planning.finishAlone { on }` (in `questions.ts`): `browserOnly` and `desktopDecidable`, human only.
  Turning it on accepts the open bulk-acceptable planning questions with `acceptDefaults(…, { alone })`.
  `question.ask` from the planner inserts a bulk-acceptable question already answered while it is on.
  Both record `accepted_alone` and set `answered_by` to the person who turned it on.
  `planning.note` (changes requested) turns it off. The planner hears `finish.alone` in its news.
  `planning.get` gains `session.finishAlone` and `acceptedAlone` on each question. Migration 0241
  adds `finish_alone_by`, `finish_alone_at` and `core_questions.accepted_alone`.
- After review (fixes on #71):
  - A paused session isn't resumed by news (`wakeSession` checks `paused_at`; `planning.resume`
    resumes it).
  - `chat.send { interrupt }`, `planning.stop`, `planning.pause` and `planning.resume` are
    `browserOnly` and `desktopDecidable`: a person in the app or on the desktop, never a CLI or MCP
    token.
  - Interrupts merge: one queued per run. They are spaced out: none within 10 s
    (`INTERRUPT_GAP_MS`) of the last delivered.
  - Tested in a real Claude Code session: one Escape mid-turn stops the step, and the typed line
    becomes the next prompt. Two Escapes within about a second open the Rewind menu, which swallows
    the line (Enter there could rewind). So runner-local's `interrupt` looks at the screen after its
    Escape and closes the menu before typing. A stream session gets its interrupt control line
    (`interruptStream`).
  - `planning.answer` keeps the presence proof on the desktop for security, privacy and
    irreversible questions (also `presenceDecidable`; `ctx.presence` tells the handler a proof
    came). Ordinary answers and bulk accept stay proof-free.
- After the second review (fixes on #71):
  - Decision domains are a closed list, normalised on the way in (`decisionDomainSchema`:
    "Security" → `security`, "security & privacy" → `security`). One shared predicate,
    `isSensitiveQuestion` in runner-contract, used by core and the clients, decides what a person
    must answer themselves.
  - Finish alone covers only questions its setter may answer (the assignee, or an approver). Only an
    approver, or the person the open questions are assigned to, may turn it on. An ask that answers
    in the setter's name is guarded on finish alone still being on.
  - `planning.answer` takes `questionRevision`, and an answer to a question the planner changed
    meanwhile is refused. `question.update` reopens an answer when the question becomes sensitive,
    or its kind or options change.
  - The 10 s interrupt spacing is guarded in the batch.
  - The Rewind-menu check reads only the bottom of the screen and needs the menu's footer line.
  - `desktopDecidable`'s comment lists the operations it covers and why.

**PR C, the Planning tab (desktop).** Built on PR #70's restyle (spec 41); it only adds behaviour.
- Planning questions are answered with `planning.answer` through a plain call (no Touch ID).
  Security, privacy and irreversible ones go through `decide` (Touch ID). Bulk accept uses
  `planning.acceptDefaults`.
  - The desktop's `DECIDE_OPS` (may go through decide) is now separate from `DECISION_OPS` (must).
    `test/decisions.test.ts` checks both against core's flags.
- Skip on an open planning question. Answered rows show "skipped · the planner decides", "default ·
  finish alone", and a "✓ Read" receipt. A person's chat message shows "Read" too.
- Chat: Enter sends after the planner's current step, ⌘-Enter interrupts. A hint row says which,
  or that the runner can't interrupt. An interrupt that didn't happen says why.
- The activity line has Stop. The chat header has Pause and Resume, and a paused planner is shown.
  The gate bar has "Let the planner finish alone" (and who turned it on, with Turn off) while the
  spec isn't at the gate, and "Accept N recommended".
- Push instead of polling: the engine's `planning.changed` delivery also tells the ClientHub of
  everyone with the view open (`notifyPlanningViewers`, from presence). The desktop main process
  forwards it to the view (`planningChanged`), which re-reads. The poll is now a 30 s fallback.
- Screenshots: `docs/screenshots/planning/` (before and after, docked and focus).
- Deferred: the same behaviours in sf-app, whose screens shrink to auth (ADR 0392), and plan
  editing and comments (slice 2).

