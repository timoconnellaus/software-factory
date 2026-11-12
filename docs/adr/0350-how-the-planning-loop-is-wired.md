# ADR 0350: How the planning loop is wired

Status: accepted, 2026-11-12 (spec 20 build, block R). Implements [ADR 0300](0300-planning-is-a-live-session-on-a-runner.md)
and [ADR 0301](0301-runner-capacity-has-heavy-and-light-pools.md); builds on [ADR 0035](0035-lease-fencing-and-one-branch-per-run.md),
[0053](0053-workflow-versioning.md), [0100](0100-runner-contract.md), [0250](0250-runner-host-pushes-and-harness-projection.md)
and [0270](0270-the-factory-launches-the-harness-and-verifies-it.md).

## Context
ADR 0300 decides that planning is a live, resumable agent session on a runner that acts through
operations and hears back through kim-style hooks. Spec 20 leaves the wiring open: how the
harness's MCP server and hooks reach the signed channel without the runner's key, how a session
yields and resumes, where the cursor lives, how the app gets live updates, and which Workflow version
carries the new spec stage.

## Decision
- **One planning call on the channel.** `POST /runner/v1/jobs/:id/planning` carries
  `{ fencingToken, op, input }` and runs one operation from a fixed allowlist (`question.ask`,
  `.update`, `.delete`, `.reorder`, `.focus`, `spec.revise`, `chat.reply`, `planning.news`,
  `planning.wait`, `planning.yield`, `planning.ready`) as the runner, with `jobId` and
  `fencingToken` added from the path and body. Answers aren't stored in the idempotency store
  (`news` and `wait` are reads with side effects on the cursor; the writes are idempotent by
  content or refused on repeat).
- **Every planning operation from a runner is scoped by the job.** The work item is the job's.
  An input naming another work item is `forbidden`. The run must be this runner's, active, and the
  lease's current holder with the same fencing token; otherwise `fenced`. A yielded or ended
  session's run is no longer active, so its calls are fenced too.
- **The runner key stays in the host.** The harness's planning MCP server and hooks call a
  **local relay** the runner host serves for each planning job: `127.0.0.1` on a random port, with a
  per-job bearer secret, written to `<runDir>/planning.json` (0600, denied to the agent's Read tool).
  The relay adds the job id and fencing token and signs the call. Whoever reads the secret gets
  exactly that job's planning operations, which the agent already has through MCP.
- **The cursor is the planning log's id.** `core_planning_events` has an autoincrement id; a
  session's `delivered_cursor` is the last id the agent was given. `planning.news` and
  `planning.wait` default to it, so a hook keeps no state of its own. News is the log after the
  cursor minus the agent's own events: answers (`answer.submitted`, `answer.revised`), chat from
  people, spec-gate notes and presence changes.
- **`planning.wait` follows kim's batch rule.** A wait is due once a person has paused for
  `idleMs` (15 s) after their latest answer, or at once (750 ms settle) after a chat message or
  when no question is left open. The operation evaluates; the engine's channel route holds the
  request (up to 50 s) and re-evaluates when the work item's `PlanningHub` is notified or the due
  time passes. The Stop hook loops on it.
- **Yield.** When a light job can't be placed because a runner's light pool is full, the scheduler
  marks that runner's oldest idle planning session (waiting in its Stop hook for 5 minutes, nobody
  present for 5 minutes, nothing undelivered) `yield_requested`. Its next `planning.wait` answers
  `{ yield: true }`; the Stop hook calls `planning.yield`, and the host ends the Claude process and
  hands the run back. The session is `yielded`.
- **Resume is a new job pinned to the runner.** A person's answer, revision or chat message to a
  yielded or interrupted session queues a `planning` job with `pinned_runner_id` = the session's
  runner and context `{ planning: { sessionId, sessionRef, resume: true } }`. The harness starts
  `claude --resume <sessionRef>` in the same planning worktree, which the adapter keeps across
  yields (it is named after the session, not the run). `sessionRef` is a UUID the cloud picks at
  `planning.start` and the harness passes as `--session-id`, so it is known before the process runs.
- **Continue on another runner** (`planning.move`) bumps the fencing token (the old runner's
  session is fenced when it returns), ends the old session as `moved`, and starts a fresh session
  whose prompt is built from the planning record (spec versions, questions and answers, chat).
- **Pools.** `capacity.light = { max, inUse }` is new and optional on the wire; the existing
  `max`/`inUse` are the heavy pool when `light` is reported. Light: triage, spec (v1–v4) and
  planning; heavy: build and verify. A runner that reports no light pool shares one pool as before
  and takes no planning jobs. No contract version bump: the fields are additive and only runners
  that report a light pool get the new stage. `sf-runner --max-light` (default 6).
- **Live updates.** Each planning change emits a `planning.changed` outbox message. Its delivery
  notifies the work item's `PlanningHub` Durable Object, which pushes a cursor to every
  Server-Sent-Events stream open on the Planning tab (sf-app proxies the stream from sf-engine's RPC
  entrypoint, after checking access) and wakes channel waits. The app re-reads `planning.get` on
  each push. Nothing polls.
- **Workflow v5.** `WORKFLOW_VERSION` is 4 on `main` (spec 20 was written when it was 2, and calls
  the new version v3). The planning spec stage is **v5**: `planning: start`, then per round
  `planning #k: await` (bumps the round), a wait for `planning-ready-<item>-<k>` that escalates
  open blocking questions on each question timeout, and the gate. Request changes is
  `planning.note` (a chat message from the approver into the same session); approval or rejection
  is `planning.end`, which cancels the run and frees its slot. v1–v4 keep their spec rounds and
  `planning_round`.
- **The question model** gains `kind`, multi-value `default_values`, `position`, `number` (the `[Qn]`
  of provenance tags, per work item), `revision`, `note` and `planning_session_id`. A question with
  a planning session can be answered again (`answer.revised`); one without keeps V1's
  answer-once rule. Delete is `withdrawn`.

## Consequences
- The planning agent never holds the runner key, a job token or the owner's credentials; the only
  new thing it can reach is the relay, scoped to its own job.
- A planning session costs one light slot while idle and nothing once yielded.
- `PlanningHub` is the first Durable Object in sf-engine. Live updates and waits stop at one
  isolate per work item; if a hub is evicted, the next change or wait re-creates it, and the app
  re-reads on reconnect.
- The spec stage's old one-shot prompt stays for v1–v4 instances until they drain.
