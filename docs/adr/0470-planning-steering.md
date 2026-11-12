# ADR 0470: How people steer the planning agent

Status: accepted, 2026-11-12 (spec 26, block AE). Amends [ADR 0350](0350-how-the-planning-loop-is-wired.md);
builds on [0042](0042-one-question-object.md), [0300](0300-planning-is-a-live-session-on-a-runner.md)
and [0400](0400-watch-and-steer-runs-from-the-dashboard.md).

## Context
The [audit against kim](../reviews/2026-11-12-planning-against-kim.md) ran the planning loop with a
real Claude Code session. A person's redirect arrived 0.1 s before the agent asked for the spec gate.
The PostToolUse hook only looks for news every 15 s, so the agent never saw it, and once at the gate
it couldn't revise the spec or leave the gate. The approved planning design (`docs/design/factory-ui`)
also lets people steer in ways the backend has no word for: chat delivered after the planner's
current step or as an interrupt, Stop, Pause, and "Let the planner finish alone".

## Decision
- **News at almost every step.** PostToolUse looks for news at most every 2 s, not 15 s (kim takes
  its own interview at every step). `planning.news` writes nothing when nothing changed, so a look
  costs one read.
- **Delivery is what the agent saw.** A hook asks with `hold` and acknowledges the cursor it showed
  (`ack`) on its next call, after it has printed the news. News a hook couldn't show (a timeout, a
  cut) comes again, and read receipts mean the agent was shown it. A read (`planning.peek`) comes
  first, so an empty look writes nothing.
- **Races are guarded, not just checked.** Each rule below is enforced in the operation's D1 batch
  (`guardExists`, `guardChanged`). The call that loses a race is refused as `conflict` and retried.
  It never commits half.
- **No gate on stale news.** `planning.ready` is refused (`conflict`) while a person's answer or
  message since the agent's cursor is undelivered. The agent reads the news and asks again.
- **A person's word takes the spec back from the gate.** While the spec waits at the gate, a person's
  chat message, answer or revised answer withdraws the pending `spec.accept` action
  (`decision: "withdrawn"`, as verify withdraws a merge gate) and starts the next planning round, so
  the agent can revise. The Workflow's planning stage treats `withdrawn` like changes requested,
  without the note step: the message is already in the chat. No Workflow version bump: only this
  release emits `withdrawn` for a spec gate, and no running instance has taken that path (ADR 0053).
  This only ever makes the gate stricter, so any member who may chat may do it.
- **Two ways to send a message.** *After its current step* (Enter) is plain `chat.send`: the
  PostToolUse hook brings it after the tool call in progress, or the Stop hook wakes an idle agent.
  *Interrupt* (⌘-Enter) is `chat.send { interrupt: true }`: the message is stored as usual, then the
  run is interrupted through a new optional runner capability, `interrupt`. The adapter presses
  Escape in the session (Claude Code stops the current step) and submits a fixed line telling the
  agent to read its planning news. No person's text is typed into the terminal: the message reaches
  the agent through the UserPromptSubmit hook's news, as untrusted data like any chat. That is why a
  member may interrupt while `run.steer`, which types its text as-is, stays with the runner's owner.
- **Interrupts come from a person and are spaced out.** Interrupt, Stop, Pause and Resume are
  refused from a CLI or MCP token. One interrupt is queued per run at a time, and none goes within
  10 s of the last, because a second Escape within a second opens Claude Code's Rewind menu. The
  adapter also closes that menu if it finds it after its Escape.
- **Stop and Pause.** *Stop* is an interrupt with no message: the agent ends its turn and waits.
  *Pause* (`planning.pause`) interrupts and marks the session paused. A paused session's Stop hook
  isn't woken by news, and the session yields its slot when the light pool needs it, as an idle one
  does. *Resume* (`planning.resume`) clears the pause and wakes it with the news since its cursor.
- **Let the planner finish alone** (`planning.finishAlone`) is a person's standing instruction for
  this session. It accepts every bulk-acceptable default now and each one the agent asks later, and
  tells the agent to call `planning_ready` when it can. Security and privacy questions, irreversible
  ones and questions without a default still wait for a person, as with bulk accept (ADR 0042).
  Nothing is accepted on a timeout, and approving the spec stays a person's decision. Only a
  person turns it on or off (never an agent, the chat or the CLI). It is per session and off by
  default, every answer it gives is recorded as accepted under the instruction of the person who
  set it, and changes requested at the gate turn it off. The owner approved this form on
  2026-11-12 (ADR 0042, amended).
- **A steer on a planning run is in the record.** `run.steer` on a planning run also stores the
  text as a chat message by its author, marked delivered, so the Planning tab and a session rebuilt
  on another runner see it.

## Consequences
- A person's message can no longer be lost to a race with the gate. The cost is one more planning
  round when an approver chats at the gate instead of deciding.
- Interrupting needs the runner to declare `interrupt`. A runner without it delivers the message
  after the current step, and the app says so.
- Finish alone is the only path where an answer is recorded without a click on that question. It is
  limited to what bulk accept could already do in one click, and the log names the person who
  turned it on.
