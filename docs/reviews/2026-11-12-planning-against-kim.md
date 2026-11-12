# Planning against kim (2026-11-12)

What the factory's planning (spec 20, M1, merged in #33, #35, #36, #37) does next to kim, the owner's
"Keep it moving" interviewer, which it copies. Kim's source is at `/Users/tim/orca/projects/interviewer`
(not in this repo); its paths below are relative to that folder. Factory paths are relative to this repo.

Verdicts: **same** (kim's behaviour, maybe in the factory's own words), **weaker** (there, but slower,
narrower or rougher), **missing**, **wrong** (a bug, or a behaviour that defeats the point), and
**n/a** (kim needs it because it runs in the user's own agent; the factory doesn't).

## How this was checked
- Read kim: `README.md`, `docs/keep-it-moving.md`, `skills/interviewer/SKILL.md`, `src/hook.ts`,
  `src/hooks.ts`, `src/shared/schema.ts`, `src/shared/questions.ts`, `src/server/hub.ts` (the batch
  rule, the agent sockets, notifications, `batchSummary`), `src/web/App.tsx`, `QuestionCard.tsx`, `Chat.tsx`.
- Read the factory: spec 20, ADR 0350, `packages/core/src/planning.ts`, `operations/planning.ts`,
  `operations/questions.ts`, `operations/live.ts` (`run.steer`), `packages/runner-contract/src/planning.ts`,
  `packages/harness-claude/src/planning/*`, `local/runner-host/src/planning-relay.ts`, and the Planning
  tab in `apps/app` and `apps/desktop`.
- Ran the planning tests on main: core 11/11, runner-host 4/4, harness-claude 28/28, engine
  planning-flow 2/2.
- **Ran the loop for real.** `harness-claude`'s `projectHarness` projected a planning job (MCP server,
  three hooks, settings, launch script) exactly as the runner host does, against an in-memory fake of
  the planning channel that logs every call. A real Claude Code session ran it in tmux, and I played
  the person through the fake (answers, chat, a revised answer) and typed into the terminal. Timings
  below come from that log (36 calls over about 7 minutes; a "Dark mode for Tally" item).

### What the live run showed
| Step | Result |
| --- | --- |
| Chat to an idle agent (in its Stop hook) | `planning.wait` returned 0.8 s after the message; the agent acted at once |
| First draft | `question_ask` with 2 single-choice questions, each with a default and a recommendation; `spec_revise` with provenance tags; a chat reply summarising both |
| Both questions answered (one away from the default) | Wait returned 0.7 s after the last answer (the settle rule, nothing left open); spec v2 written in 15 s |
| Redirecting chat ("drop the toggle, follow the OS") sent while the agent worked | **Lost the race.** It arrived 0.1 s before the agent's `planning_ready` and 0.8 s after its last PostToolUse news call, which then throttled for 15 s. The spec went to the gate without it. Woken in the Stop hook, the agent tried `spec_revise`, was refused (`conflict`: at the gate), called `planning_ready` again (which just re-confirmed v2), first told the person "Done, spec v3", then corrected itself and asked them to request changes at the gate |
| Answer revised at the gate | Delivered as `answer.revised` with `acceptedDefault` in 0.8 s. The agent noticed it contradicted the earlier chat and asked which one held, but couldn't change the spec, which still sat at the gate |
| Typing into the session's terminal | UserPromptSubmit took over from the waiting Stop hook and the agent answered; nothing typed there reached the planning record |

## The table

### Questions
| Behaviour | kim | Factory | Verdict |
| --- | --- | --- | --- |
| Question types: text, single, multiple, yes-no, number | `src/shared/schema.ts:8` | `packages/runner-contract/src/planning.ts` `QUESTION_KINDS` | same |
| Default (one value, several for multiple-choice) + recommendation | `schema.ts` `questionFields.default`, `recommendation` | `planningQuestionSchema`; `normalizeQuestion` in `packages/core/src/operations/questions.ts:40` | same |
| Size limits | prompt 10k, recommendation 20k, 100 options | prompt 2k, recommendation 4k, 12 options (`runner-contract/src/planning.ts:68,72`) | weaker (minor) |
| `acceptedDefault` on every answer | `src/shared/questions.ts:173` | `questions.ts:525`, in news as `acceptedDefault` | same |
| Skip a question | `AnswerInputSchema.skipped`, the card's Skip | none: an answer is required (`question.answer` input) | **missing** |
| "Other, or add a note" | the note is folded into the answer text (`Option — note`) | a separate `note` field, plus "Other…" | same |
| Bulk accept | "Accept all" over every acceptable question (`src/web/App.tsx:337`) | `question.acceptDefaults` (`questions.ts:535`); never security/privacy or irreversible (ADR 0042) | same, stricter by policy |
| Revisable answers, `answer.revised` | yes | yes, for planning questions (`questions.ts:520`); verified live | same |
| Add / update / delete / reorder / focus freely | `kim question …` | `question.ask/update/delete/reorder/focus` over MCP; verified live | same |
| Focus a group of questions | `focusedQuestionIds` | one question | weaker (minor) |
| Read receipts ("✓ Read" on each answer and message) | `QuestionCard.tsx:311-349`, `deliveredAt` | messages store `delivered_at` (`operations/planning.ts:519`), answers don't; neither Planning tab shows it | **missing** |
| Answering takes one click | web: one click, bulk in one | sf-app: one click. **Desktop: `question.answer` and `acceptDefaults` are `browserOnly` + `presenceDecidable` (`questions.ts:505,542`), so every answer is a Touch ID prompt** | **wrong** on desktop (needs an owner decision, below) |

### Chat
| Behaviour | kim | Factory | Verdict |
| --- | --- | --- | --- |
| One chat, replies, Markdown | `Chat.tsx`, `chat.reply` | `chat.send` / `chat.reply`, `core_planning_messages` | same |
| Per-question threads | `questionId`; the batch gives `about: { questionId, number, prompt }` (`src/server/hub.ts:1570`) | `questionId` only in news (`packages/core/src/planning.ts:352`); the agent has to look the question up | weaker |
| A message wakes an idle agent at once | settle 750 ms | same rule; measured 0.8 s | same |
| "Agent is away / replying / working on your answers" | `App.tsx:47` | the session pill with the agent's last tool (`packages/client/src/planning.ts` `sessionPill`) | same (richer) |

### Delivery: hooks, throttling, the Stop wait
| Behaviour | kim | Factory | Verdict |
| --- | --- | --- | --- |
| News after each tool call (PostToolUse) | its own interview **at every step**; only interviews sent to the user are throttled to 15 s (`src/hook.ts:337-346`) | throttled to once per 15 s (`packages/harness-claude/src/planning/hooks.ts:104`), so a message can sit unseen for up to 15 s while the agent works | **weaker**; caused the lost redirect above |
| News when someone types (UserPromptSubmit) | yes | yes, and it cancels the waiting Stop hook; verified live | same |
| The batch rule (15 s pause, 750 ms settle after a chat or nothing open) | `hub.ts:1467` | `batchDue`, `packages/core/src/planning.ts:372`; measured 0.7-0.8 s settles | same |
| Stop hook waits without tokens and wakes the model (asyncRewake) | `src/hooks.ts:107`, `src/hook.ts:482` | `hooks.ts:143`; `planning.wait` held up to 50 s by the engine and looped; verified live | same |
| "Still waiting" wake | only after a wait that ran at least half its course | at ~23 h 45 m | same |
| Context over 10k chars | drops the raw events, keeps answers and messages (`hook.ts:229`) | slices the JSON mid-string and says "call planning_news with cursor N-1" (`hooks.ts:56`); the cursor has already moved past the cut events, and N-1 returns only the last one | **wrong** |
| The agent asks for the gate while a person's message is undelivered | n/a (kim has no gate) | `planning.ready` succeeds (`operations/planning.ts:617`); verified live | **wrong** |
| Leaving the gate when a person redirects | n/a | impossible: `spec.revise` is refused at the gate (`operations/planning.ts:379`) and the agent can't withdraw; only "Request changes" by an approver reopens it | **wrong** |
| Mark-delivered | the batch's last event id | the cursor, but `deliver()` marks *every* undelivered person message read, even past the 500-row page (`planning.ts:270`) | weaker (minor) |
| SessionStart / SessionEnd hooks, bindings by cwd | needed to find the user's interviews | the host owns the session; the relay file names the job | n/a |
| Several interviews per agent session | yes | one session per job | n/a |

### Living plan
| Behaviour | kim | Factory | Verdict |
| --- | --- | --- | --- |
| Plan rewritten after each batch | `kim plan` replaces it | `spec.revise`, the whole spec each time, versions kept | same |
| What changed is highlighted | the workspace highlights changes against the repo copy | the spec pane marks blocks changed since the previous version (`apps/*/components/planning.tsx` `isChanged`) | same |
| Provenance, coverage, assumptions, clarifications | none | ADR 0302; chips, highlighted assumptions, "Overturn" an assumption | factory adds |

### Session: resume, presence, runners
| Behaviour | kim | Factory | Verdict |
| --- | --- | --- | --- |
| Resume a stopped interview | `kim session resume` | yield then resume on the same runner (`wakeSession`); `planning.move` rebuilds from the record | same |
| Session limit | none | the harness is ended after 6 h (`PLANNING_SESSION_TIMEOUT_MS`, `planning.ts:24`) and resumed by the next answer (`--resume`) | weaker (minor: a resume reloads the whole conversation) |
| Presence | `agentWatching`, `agentSeenAt` shown to the person | `planning.presence` heartbeats; the agent sees who is here; the pill shows the agent | same |
| Live updates in the app | WebSocket per interview | sf-app: SSE from `PlanningHub` (`apps/app/src/components/planning.tsx:163`). **Desktop polls every 3 s** (`apps/desktop/src/mainview/lib/queries.ts:56`), over spec 20's 2 s criterion | weaker on desktop |
| Notifications | push when an interview gains open questions, on each agent reply, and when an assignee answers, once per burst (`hub.ts:389-437`) | one `planning.ready` notice when the first draft is in (`operations/planning.ts:131`); later questions and replies notify nobody (`questions.ts:193` returns before notify) | **weaker** (the async path depends on it) |

### Visuals, designs, the repo, other people (later specs)
| Behaviour | kim | Factory | Verdict |
| --- | --- | --- | --- |
| HTML mockups on a sandboxed origin, 1280/834/390 | `src/server/framePage.ts`, `src/web/Preview.tsx` | — | missing (spec 21) |
| Option cards (`optionArtifacts`) | `schema.ts` | — | missing (spec 21) |
| Live controls (`--var`, `@attr`, `#slot`, sliders, hover preview, `applied` in the batch) | `src/shared/bindings.ts`, `QuestionCard.tsx:164-185` | — | missing (spec 21) |
| Design canvas, frames per question | `src/web/Canvas.tsx`, `canvasLayout.ts` | — | missing (spec 21) |
| Pinned comments naming the element | `PinInputSchema`, `pin` in the batch | — | missing (spec 21/22) |
| System designs (D2, DBML, Mermaid, OpenAPI) with checks and layout warnings | `src/design/*`, `src/designCheck.ts` | — | missing (spec 22) |
| `.kim/` pull, keep, write-back on stop | `src/designSync.ts`, `src/designFiles.ts` | — | missing (spec 22) |
| Assign to someone else (a guest by email) | `kim session assign`, `src/web/Assign.tsx` | questions go to the approver; escalation to the backup owner | missing (R1 milestone (c)) |
| A quick question mid-task (`kim ask`) | yes | — (triage questions are spec 23; build questions later) | missing (spec 23, later) |

## Collaborative planning (the owner's six cases)
| Case | kim | Factory today | Gap and where it goes |
| --- | --- | --- | --- |
| 1. Interrupt or redirect the agent mid-work | chat reaches it at its next tool call; typing in its terminal | chat wakes an idle agent in under a second, but mid-work it waits for the 15 s throttle and can lose the race to `planning_ready` (seen live). `run.steer` (spec 31) works on a planning run: it is typed into the terminal, and UserPromptSubmit brings the news; verified by typing. But a steer is owner-of-runner only and never lands in the planning record or chat | **Slice 1:** news at every tool call (cheap check), `planning.ready` refused while a person's news is undelivered, and a person's chat or revised answer at the gate takes the spec back from the gate. A steer on a planning run also writes a chat message, so the record and a moved session keep it |
| 2. The person edits the plan text | not possible: the agent owns the plan; the person steers through chat | not possible | **Slice 2:** `spec.edit` for people; the edit is a spec version by a person, arrives as `spec.edited` news with a diff, and is kept: the agent may not undo a person's edit without asking |
| 3. Comments pinned to part of the plan, a mockup or a design | on mockups and designs (element-named pins); per-question threads; not on the plan | per-question chat ("Discuss") only | **Slice 2:** comments anchored to a spec block (heading + paragraph), in news as `about: { block }`. Mockups in spec 21, designs in spec 22 |
| 4. Reject a direction and have the agent redo what follows | a revised answer is "a fresh decision point"; no dependency system | the same mechanism works (seen live: the agent caught the conflict), "Overturn" on an assumption drafts a chat. Blocked at the gate (case 1) | **Slice 1** covers the gate. Optional in slice 2: questions record which earlier answers they depend on, so a revision can mark the downstream ones for the agent |
| 5. Take over in a terminal | the agent always runs in the user's own terminal | runner-local: `tmux attach` on the runner's Mac; the Live tab's terminal (hosts work in flight). Typing works (verified) | Nothing new for planning beyond case 1's "steer into the record" |
| 6. Hands-off: accept every default, only the final approval needs a person | "Accept all", and the agent stops itself | "Accept remaining defaults", the agent revises and calls `planning_ready`, then Approve. Two decisions in sf-app; on desktop two Touch IDs (plus one per question that can't be bulk-accepted: security, privacy, irreversible, no default, by policy) | Works today. The Touch ID per answer on desktop is the friction (owner decision below). Defaults are never accepted without a person (ADR 0042): no change proposed |

## The planning screens (PR #61) against the backend
The approved design (`docs/design/factory-ui/ItemPlan.html`, `PlanFocus.html`,
`PlanFocusMockup.html`, on PR #61) is the target for the planning UI. Each behaviour it shows:

| Shown | Backend today | Where it comes |
| --- | --- | --- |
| Questions with progress, Recommended pre-selected, "changed by you", Accept recommended, bulk "Accept 3 recommended" | yes (`question.answer`, `acceptDefaults`, `acceptedDefault`) | — |
| Skip | no | slice 1 |
| Per-question thread ("2 messages") | yes (`questionId` on chat) | slice 1 adds `about` to news |
| Plan with provenance chips, rev N, changed line highlighted, assumptions with Overturn, coverage | yes | — |
| **Edit a plan line** ("the agent keeps your wording and updated Q3 to match") | no | slice 2 (`spec.edit`) |
| **Comment (C)** on the plan | no | slice 2 (comments on spec blocks) |
| **Pinned comment on a mockup** with Resolved / Reopen | no (kim's pins have no resolved state either: new) | spec 21 |
| Mockups tab, option cards (Choose A / B), Open full size, "Try with" states, Ask for a third option, Canvas, System | no | spec 21 (System: spec 22) |
| **Chat: Enter = after the planner's current step; ⌘-Enter = interrupt now** | Enter: yes but up to 15 s late (the throttle). Interrupt: no | slice 1 (below) |
| Activity line ("Revising the acceptance criteria") with **Stop** | the activity: yes; Stop: no | slice 1 (interrupt without a message) |
| **Pause** (session bar) | no; the session yields only when the scheduler asks | slice 1 (`planning.pause` / `resume`: interrupt, then yield the slot; news doesn't wake it until resumed) |
| Open terminal | runner-local `tmux attach` on the runner's Mac; the Live tab's terminal comes with the hosts work | hosts session |
| Planner is here / working on M5 / runner and light slots in the status bar | yes (presence, the pill, pools in the heartbeat) | — |
| **Let the planner finish alone** | no. "Accept remaining defaults" is the nearest | slice 1: `planning.finishAlone` accepts the bulk-acceptable defaults now and **the ones the planner asks later**, and the planner calls `planning_ready` itself. Security, privacy, irreversible and no-default questions still wait for a person (ADR 0042), and approval stays a person's. A person turning it on is not an auto-accept on timeout, but the owner should confirm it reads ADR 0042 the same way |
| Approve plan and 2 work items | no | spec 24 (splits) |

**How Enter and ⌘-Enter map onto the hooks and steer.**
- **Enter (after its current step)** is `chat.send`. The message goes into the planning log, and the
  PostToolUse hook brings it after the tool call the planner is in. With slice 1's news at every
  tool call, that is the next step, not up to 15 s later. An idle planner is woken by its Stop hook
  (0.8 s, measured).
- **⌘-Enter (interrupt now)** is `chat.send` with `interrupt: true`. The message is stored like any
  other, then the factory steers the run: the runner adapter presses Escape in the session (Claude
  Code stops the current step) and submits a fixed line: "A person interrupted you: read the
  planning news". No person's text is typed into the terminal. The UserPromptSubmit hook then
  delivers the news, the message included, as untrusted data, as for any chat. So any member who may
  chat may interrupt, not only the runner's owner (`run.steer` stays owner-only, because there the
  text is typed as-is). It needs one optional runner capability, `interrupt` (Escape, then a line),
  declared by `runner-local`: a new adapter method and the smallest possible hook in the host's
  steer loop.
- **Stop** on the activity line is the same interrupt with no message and the line "A person
  stopped your current step; end your turn". The Stop hook then waits as usual.

## Owner decisions needed
1. **Answering a planning question on desktop.** Today each answer is a Touch ID prompt because
   `question.answer` is a presence-decided gate operation (ADR 0042, 0391). Proposal: answers to a
   *planning session's* questions are ordinary member writes (no presence proof), except security,
   privacy and irreversible ones, which keep it. The spec gate keeps Touch ID. This narrows a
   `browserOnly` rule, so it is a policy change for the owner, not something to do quietly.
2. ~~Collaboration slice before or after spec 21.~~ Decided 2026-11-12: slice 2 (spec edits by
   people, comments on spec blocks) goes before spec 21.
3. **"Let the planner finish alone"** accepts defaults the planner asks after the person turned it
   on. Only bulk-acceptable ones, never on a timeout. Confirm this reads ADR 0042 as intended.

## Proposed build order
1. **Slice 1, M1 fixes (kim parity in the loop).** No new tables beyond a small migration.
   - Delivery: news at every PostToolUse when there is any (a cheap cursor check, e.g. against the
     work item's `PlanningHub`), so the 15 s throttle goes; `planning.ready` refused while a person's
     news is undelivered; a person's chat or revised answer while the spec is at the gate takes it
     back (the round moves on, as with a gate note); the hook's oversize news keeps answers and
     messages and drops the rest, as kim does.
   - News fidelity: `about: { number, prompt }` on messages; skip; kim's size limits.
   - Read receipts on answers and messages; notifications for questions asked after the first
     announcement and for agent replies, once per burst.
   - A steer on a planning run also goes into the chat.
   - Steering from the design: chat after the current step (Enter) or as an interrupt (⌘-Enter),
     Stop on the activity line, Pause and Resume, and "Let the planner finish alone".
   - Desktop: push-driven updates instead of the 3 s poll, inside the planning component; decision 1
     if the owner agrees.
2. **Slice 2, collaboration** (agreed): `spec.edit` by people, comments on spec
   blocks, optional question dependencies.
3. **Spec 21**: mockups, option cards, live controls, the canvas, pinned comments.
4. **Spec 23**: triage questions, the readiness check, the spec critic.
5. **Spec 22**: system designs and `.kim/` write-back.
6. **Spec 24**: splits.

Planning logic stays independent of the work item's lifecycle state (spec 50 may move planning
before release): every slice keys on the planning session, not on the spec stage.

## Also seen (for other sessions)
- Every `Write(...)` deny rule in the projected settings shows Claude Code's warning "never matches ·
  use Edit(...)" at launch (seen in the live run). If Claude Code no longer applies `Write(...)` deny
  rules, the harness's file denials are weaker than they look. That belongs to `harness-claude`'s
  owners (the hosts session).
