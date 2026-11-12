# Spec 43: runners under load: no orphans, tmux errors aren't "gone", back off claiming

Read first: [incident #11](../incidents/2026-11-11-bootstrap.md#11-under-load-tmux-stopped-answering-and-jobs-left-claude-running)
(M5, 2026-11-12), ADRs [0530](../adr/0530-a-job-is-stopped-from-the-process-table.md),
[0531](../adr/0531-run-branches-are-marked-not-guessed-from-their-names.md),
[0532](../adr/0532-runners-back-off-claiming-under-load.md), [0380](../adr/0380-runner-local-tmux-and-hook-status.md)
(tmux on `-L software-factory`), [0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md)
(the launch script and its pid file) and [0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md)
(the control-mode bridge); the code in `packages/runner-local` and `local/runner-host`.

The 30s are all taken (38 and 39 by the drain work), so this is 43.

## Goal
A runner on a busy machine degrades, it doesn't fall over. A slow tmux never ends a job, a job never
leaves its Claude running after release, and the runner stops taking new work before the machine is
overloaded.

## Scope
1. **No orphans** (ADR 0530).
   - The job's live harness is every process whose command line has the run's settings path
     (`<runDir>/claude-settings.json`). It's read from `ps`, never guessed from a pid file.
   - Release, a failed start, a re-run of the same job and the reaper stop that process's group
     (TERM, then KILL after a grace period), and any descendant that left the group. Then they
     check that nothing is left.
   - It's done whether or not `kill-session` worked.
   - If something survives, release throws `ReleaseIncomplete`. The host then doesn't report the job
     released: it logs it, its lease lapses, and `sf-runner doctor` shows the process
     (`orphan-process`). The adapter retries the stop on every capacity read and counts the survivor
     as in use.
2. **A failed or timed-out tmux command is not "session gone"** (ADR 0530).
   - Only tmux's own answers mean gone: "can't find session|window|pane", "no server running on",
     and "error connecting to … (No such file or directory)". The wording is the same in 3.3 through
     3.6a.
   - Anything else retries with backoff and jitter (4 tries; 0.5 s doubling, jittered) and then
     throws `TmuxUnavailable`. Typing is never retried after a timeout.
   - Every tmux exec has a timeout (20 s).
   - **Events.** While tmux can't answer, the job keeps running. It says so once, as a `stderr` log
     line, and keeps reading the hook file. It ends only once `ps` confirms its Claude is gone. If
     the session is gone but Claude still runs, the job waits `goneGraceMs` (30 s) and then fails;
     release stops Claude.
   - **Capacity.** A silent tmux reports the sessions this adapter started, `accepting: false` and
     `paused: { reason: "tmux" }`. It is never "0 in use".
   - **Start, steer, collect and release.** A start tolerates a silent tmux until its deadline. Steer
     errors stay steer errors. Collect already tolerated it. Release is covered by item 1.
3. **Back off claiming under load** (ADR 0532).
   - The thresholds are on the 1-minute load average, as a multiple of the CPU count. Heavy jobs
     stop above 1.5×. Light jobs stop too above 2.0×. Each resumes below its stop × 0.8.
   - It's on by default. Set it in `runner.json` as
     `load: { enabled, heavyStop, lightStop, resumeFactor }`.
   - The heartbeat carries `capacity.paused: { reason: "load", pools, load1, cores }`. Both pools
     paused also means `accepting: false`.
   - The scheduler gives a paused pool nothing (`core_runners.paused`, migration 0300).
   - The runner health line says "runner busy: load 19.3 on 10 cores, no new heavy jobs".
4. **Run branches are the factory's own, whatever their name** (ADR 0531).
   - When `prepareWorkspace` creates `job.branch`, it marks it with
     `refs/software-factory/run-branches/<branch>`. That covers attached PRs'
     `<pr-branch>-run-<k>` too.
   - Release deletes the branch the workspace created, unless a worktree has it checked out.
   - `prepareWorkspace` treats an existing `job.branch` that no worktree has checked out as stale,
     and refuses one that is checked out anywhere.
   - The reaper and doctor sweep marked branches that no worktree has checked out
     (`orphan-branch`). They also sweep the configured checkouts, not only the ones the job
     worktrees hang off. An unmarked branch is never touched.
   - Container job repos are their own clones, deleted whole, so they don't leak. Their temporary
     fetch ref is deleted in a `finally`. Sprites (#74, not on main) is out of scope; check it when
     it lands.
5. **A steer typed mid-turn** (tmux).
   - Claude queues the message, and its turn runs after the current turn's Stop. So a non-planning
     tmux job doesn't end at a Stop while a steer is still owed. A steer is owed when it was typed
     after the last `UserPromptSubmit`.
   - The job ends at the Stop of the turn that answers the steer. If that turn hasn't started within
     `turnGraceMs` (15 s; Claude folded the steer into the turn that stopped), it ends anyway, as
     stream mode does.
6. **tmux 3.5a/3.6a's control-mode crash** (ADR 0440 note).
   - `terminal.test.ts`'s real-tmux tests skip inside a factory job (`SOFTWARE_FACTORY_RUN=1`, set
     by `harnessEnv`). `SF_TMUX_CONTROL_TESTS=1` runs them anyway.
   - The production bridge attaches with `-f pause-after=60` and handles `%extended-output` and
     `%pause` (continue, then redraw). It sends `detach-client` before closing its input.

## Acceptance criteria
1. A scripted tmux that times out, crashes or errors is retried and then reported unavailable, never
   gone. "can't find session" and "no server running" are gone at once. Typing isn't repeated after
   a timeout. Every call has a timeout. (`runner-local/test/robust.test.ts`, "tmux answers")
2. With tmux timing out, a running job yields one "tmux isn't answering" line, keeps running, and
   ends `completed` on the hook's Stop. Its capacity is `accepting: false`, `paused.reason: "tmux"`,
   and it still counts the job.
3. With tmux timing out, the job ends only once the process table has no Claude for it.
4. A session gone while its Claude runs waits `goneGraceMs`, then fails. Release sends TERM, then
   KILL, to a process that ignores TERM.
5. Release stops Claude when `kill-session` times out, and cleans up the worktree.
6. A release that can't stop Claude throws `ReleaseIncomplete`. The host doesn't call release on
   the channel or push `released`, logs "NOT released" and reports `processesAlive`. The adapter
   counts the survivor until it's gone. (`runner-host/test/load.test.ts`)
7. A real stand-in process group that ignores TERM, with a child that ignores TERM, is KILLed, child
   included. Afterwards `ps` shows nothing with its settings path.
8. The reaper stops a job's Claude that the host doesn't run, found by its settings path, and leaves
   a running job's alone. Doctor reports it first as `orphan-process`.
9. The load gate stops heavy at 1.5×, light at 2.0×, and resumes below 0.8× each, logging each
   change. `runner.json` `load` parses with defaults, rejects `lightStop < heavyStop`, and can be
   turned off.
10. The heartbeat reports `paused: { reason: "load", pools, load1, cores }`. Past both thresholds,
    `accepting` is false and nothing is claimed. Past heavy only, `accepting` stays true with heavy
    paused. Under the thresholds there's no pause and the host claims.
11. The scheduler gives a paused pool nothing (`core/test/runner-paused.test.ts`), and the inbox's runner line reads "runner busy:
    load …" (`packages/client` test).
12. An attached PR's `<pr-branch>-run-<k>` is marked and deleted on release. A stale copy left by a
    crash is taken over. One checked out elsewhere is refused and left alone. The reaper and doctor
    sweep marked leftovers and never an owner's unmarked `*-run-1`.
13. A steer typed mid-turn doesn't end the job at that turn's Stop: it ends at the steered turn's.
    If the steered turn never comes, it ends after `turnGraceMs`.
14. `skipTmuxControlTests` is true inside a factory job unless asked. The parser reads
    `%extended-output` and `%pause`.

## Restore attempts after a runner incident (specified here, not built)
**Status: not built.** Mark it built only after this spec's fixes 1–3 land, so that runner faults
are rare and recorded before attempts are given back.

Incident #11 burned work items' attempts on failures the runner caused: kill-session errors on
every new job, and sessions read as "gone". A person needs a way to give those attempts back
without hand-editing D1.

### Classification first
- Every run records a `failureKind` at hand-back. The host sets it: it's a new optional field on
  the channel's `handback` and `release` calls, and a `core_runs.failure_kind` column. It's never
  inferred from text the agent wrote.
- The host sets it from what it observed, never from the summary or the result file. Values:
  - `runner`: a runner fault. That's a `TmuxUnavailable` or `TmuxError` from start, steer or
    release; kill-session or send-keys failures; `ReleaseIncomplete`; a cancellation because the
    runner was stopping (`the runner is stopping`); a fenced lease after a host restart (the
    reaper's lapsed runs); `prepareWorkspace` failing on the host's git or file system (for
    example, a stale branch, a worktree add exiting 255); the host's own push/channel errors that
    aren't 4xx refusals; and a session that ended because tmux went away while the agent ran.
  - `harness`: a `harness-config-mismatch`, or Claude not starting or not submitting the prompt.
    This is a runner fault too.
  - `work`: the session ended normally (a Stop or an exit) and the work failed. That covers a
    missing or invalid result file, "the build made no commits", an unresolved merge, a failed or
    red check, a verify verdict that failed, the agent's own error status, a usage limit (the
    account's, so the owner's problem, not the runner's), and the waiting-input timeout.
  - `timeout` and `cancelled` (by a person) are their own kinds. They are not runner faults.
- A run without a `failureKind` (from an older runner) counts as `work`: unknown is never
  refundable.

### The operation
`workItem.restoreAttempts` gives back the attempts spent on runs whose `failureKind` is `runner`
or `harness`.
- **Who.** Human only and browser only, like the gate decisions (ADR 0340): enforced in `invoke()`,
  never callable from a runner, an agent, MCP or a CLI token. Risk class `write`, journalled with
  the runs it refunded and the person.
- **What.** For one work item and stage, it counts the runs that ended with a runner-fault kind
  since the item's last successful run of that stage, then lowers the stage's spent attempts by
  that count (never below zero). Each refunded run is marked `refunded_at` so it's refunded once.
- **Never the work's failures.** It refuses, naming the runs, when the only failed runs are `work`,
  `timeout`, `cancelled` or unclassified. It never refunds those even when they sit among runner
  faults.
- **Re-opening.** A Workflow that ended `failed` *only* because the stage's attempts were
  exhausted, where every run counted against the limit is a runner fault, can be re-opened. The
  operation starts a new Workflow instance for the item at that stage, with the refunded budget.
  It doesn't resume the finished instance: per ADR 0053 a finished instance's journal is final, and
  replaying it on new code is what versioning forbids.
  - The new instance starts on the current `WORKFLOW_VERSION`, with `meta: version` journalled as
    always.
  - Its first step reads the item's existing state (spec, branch, PR), so it picks up at the failed
    stage without redoing earlier gates.
  - Re-opening is refused when any counted run is a work failure, or when a gate after that stage
    was already decided.

### Acceptance criteria (for the build)
1. The host records `failureKind` on every hand-back and release. The unit tests map each listed
   reason to its kind, and agent text can't change it: a summary that says "tmux error" on a normal
   Stop is `work`.
2. `workItem.restoreAttempts` is refused for a runner token, an agent, MCP and a CLI token, and
   allowed only from the browser for the item's owner or an approver. Each call is journalled.
3. It refunds exactly the runner-fault runs since the last success, once each. A second call
   refunds nothing.
4. It refuses with the run ids when the failures are the work's (failed checks, no result file
   after a normal end, the agent's error).
5. An item whose Workflow failed on exhausted runner-fault attempts is re-opened as a new instance
   on the current version, at the failed stage. One with any work failure, or a later decided gate,
   is not.
