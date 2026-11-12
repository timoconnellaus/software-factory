# Spec 43: runners under load: no orphans, tmux errors aren't "gone", back off claiming

Read first: [incident #11](../incidents/2026-11-11-bootstrap.md#11-under-load-tmux-stopped-answering-and-jobs-left-claude-running)
(M5, 2026-11-12), ADRs [0550](../adr/0550-a-job-is-stopped-from-the-process-table.md),
[0551](../adr/0551-run-branches-are-marked-not-guessed-from-their-names.md),
[0552](../adr/0552-runners-back-off-claiming-under-load.md), [0380](../adr/0380-runner-local-tmux-and-hook-status.md)
(tmux on `-L software-factory`), [0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md)
(the launch script and its pid file) and [0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md)
(the control-mode bridge); the code in `packages/runner-local` and `local/runner-host`.

The 30s are all taken (38 and 39 by the drain work), so this is 43.

## Goal
A runner on a busy machine degrades, it doesn't fall over. A slow tmux never ends a job, a job never
leaves its Claude running after release, and the runner stops taking new work before the machine is
overloaded.

## Scope
1. **No orphans** (ADR 0550).
   - The job's live harness is every process of the **runner's own user** whose command line has
     `--settings <runDir>/claude-settings.json`. It's read from `ps`, never guessed from a pid file.
     A process that only names the file (the owner's `less`, `tail` or a grep) isn't one.
   - Release, a failed start, a re-run of the same job and the reaper stop that process's group
     (TERM, then KILL after a grace period), and any descendant that left the group. Release also
     stops the runner user's processes that were re-parented to init and work in the job's
     worktree (a dev server started with `setsid` or `nohup`). Then they check that nothing is
     left.
   - A process it may not signal (EPERM) is another user's, never the job's, and never pins a job
     as a survivor.
   - It's done whether or not `kill-session` worked. A session whose kill didn't answer, or a
     new-session that failed and may have started late, is **abandoned**. A background clean-up,
     started from `capacity()` and never awaited, kills it and stops its harness again until tmux
     confirms it gone, and keeps at it for 2 minutes in case it starts late.
   - Capacity doesn't count a dead pane (kept by remain-on-exit), nor an abandoned session whose
     harness is confirmed gone. `capacity()` answers within 12 s whatever tmux does: one try of
     8 s, then the deadline. The host asks twice a turn, and `drain()` waits for the turn, so a turn
     stays well under a minute.
   - If something survives, release throws `ReleaseIncomplete`. The host then doesn't report the job
     released: it logs it, its lease lapses, and `sf-runner doctor` shows the process
     (`orphan-process`). The background clean-up retries the stop, and the survivor counts as in
     use until it's gone.
   - **Not covered yet.** Container jobs (ADR 0430) have no settings path on the host, so their
     Claude isn't ps-checked. Their container's removal is the stop. A kill-session timeout there
     is a plain release error, so the job isn't marked `released` but the lease is still given back.
     The host-side bridge of a Sprites job isn't ps-checked either. Those are follow-ups.
2. **A failed or timed-out tmux command is not "session gone"** (ADR 0550).
   - Only tmux's own answers mean gone: "can't find session|window|pane", "no server running on",
     and "error connecting to … (No such file or directory)". The wording is the same in 3.3 through
     3.6a.
   - Anything else retries with backoff and jitter (4 tries; 0.5 s doubling, jittered) and then
     throws `TmuxUnavailable`. Typing is never retried at all: a timeout, a client killed by a
     signal, or a "lost server" can each come after the keys arrived. When a later piece of a
     chunked steer fails, the line is cleared with Ctrl-U (best effort) before the failure is
     reported, so the earlier pieces don't run with the next message.
   - Every tmux exec has a timeout (20 s).
   - **Events.** While tmux can't answer, the job keeps running. It says so once, as a `stderr` log
     line, and keeps reading the hook file. It ends only once `ps` confirms its Claude is gone. If
     the session is gone but Claude still runs, the job waits `goneGraceMs` (30 s) and then fails;
     release stops Claude.
   - **Capacity.** A silent tmux reports the sessions this adapter started, `accepting: false` and
     `paused: { reason: "tmux" }`. It is never "0 in use".
   - **Start, steer, collect and release.** A start tolerates a silent tmux until its deadline. Steer
     errors stay steer errors. Collect already tolerated it. Release is covered by item 1.
3. **Back off claiming under load** (ADR 0552).
   - The thresholds are on the 1-minute load average, as a multiple of the CPU count. Heavy jobs
     stop above 1.5×. Light jobs stop too above 2.0×. Each resumes below its stop × 0.8.
   - It's on by default. Set it in `runner.json` as
     `load: { enabled, heavyStop, lightStop, resumeFactor }`.
   - The heartbeat carries `capacity.paused: { reason: "load", pools, load1, cores }`. Both pools
     paused also means `accepting: false`.
   - The scheduler gives a paused pool nothing (`core_runners.paused`, migration 0320). A paused
     heavy pool also reports `max = inUse`, as #82's closed pool does, so an older engine that
     doesn't read `paused` sends no heavy job either.
   - The runner health line says "runner busy: load 19.3 on 10 cores, no new heavy jobs".
4. **Run branches are the factory's own, whatever their name** (ADR 0551).
   - When `prepareWorkspace` creates `job.branch`, it marks it with
     `refs/software-factory/run-branches/<branch>`. That covers attached PRs'
     `<pr-branch>-run-<k>` too.
   - Release deletes the branch the workspace created, unless a worktree has it checked out.
   - **Nothing deletes the owner's commits.** A branch the run didn't just make is deleted only when
     that loses nothing: its tip is still the marker's commit, or is in `origin/<branch>`.
     Deletion uses `git branch -D -- <branch>`.
   - `prepareWorkspace` treats an existing `job.branch` that no worktree has checked out as stale
     and refuses one that is checked out anywhere. A stale one is deleted when that loses nothing,
     and otherwise moved aside to `<branch>-kept-<time>`, so the run gets its name and the commits
     stay.
   - The reaper and doctor sweep marked branches that no worktree has checked out
     (`orphan-branch`). They also sweep the configured checkouts, not only the ones the job
     worktrees hang off. One with commits the factory can't account for is reported and left for
     its owner (not fixable). An unmarked branch is never touched.
   - Container job repos are their own clones, deleted whole, so they don't leak. Their temporary
     fetch ref is deleted in a `finally`. Sprites job repos (ADR 0480) are made the same way, so
     they don't leak either.
   - **Sprites and no orphans.** A sprite's Claude runs in the sprite, so its stop is the sprite's
     destroy. A sprite this run asked for that can't be destroyed now makes release throw
     `ReleaseIncomplete`, like a host process that survives, so the host doesn't report the job
     released. Before, the host only skipped the `released` state.
5. **A steer typed mid-turn** (tmux).
   - Claude queues the message, and its turn runs after the current turn's Stop. So a non-planning
     tmux job doesn't end at a Stop while a steer is still owed. A steer is owed when it was typed
     after the last `UserPromptSubmit`.
   - The job ends at the Stop of the turn that answers the steer. The turn counts as started on
     its `UserPromptSubmit`, or on any tool hook line or transcript message after the Stop: a hook
     under load can deliver `UserPromptSubmit` late, or never.
   - If no such sign comes within `turnGraceMs` (15 s; Claude folded the steer into the turn that
     stopped), the job ends anyway, as stream mode does. New terminal lines don't count, because
     the TUI's own redraws would keep a folded steer waiting until the session times out.
6. **tmux 3.5a/3.6a's control-mode crash** (ADR 0440 note).
   - `terminal.test.ts`'s real-tmux tests skip inside a factory job (`SOFTWARE_FACTORY_RUN=1`, set
     by `harnessEnv`). `SF_TMUX_CONTROL_TESTS=1` runs them anyway.
   - The production bridge attaches with `-f pause-after=60` and handles `%extended-output` and
     `%pause` (continue, then redraw). It sends `detach-client` before closing its input.
   - **Trade-off.** A viewer that falls 60 s behind loses the pane's output since the pause. They
     see a redraw of the current screen, not the scroll in between. The job's own logs, which come
     from `capture-pane`, are unaffected.

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
15. Only `--settings <path>` on the runner user's processes is the job's: the owner's `less` on the
    file and another user's Claude are left alone. An EPERM process doesn't pin a survivor. A
    re-parented process working in the worktree is stopped; the owner's shell there is not.
16. A dead pane doesn't count as in use. A session abandoned by a timed-out kill doesn't count once
    its harness is gone, and the background clean-up kills it. `capacity()` never waits for that
    clean-up.
17. A marked branch the owner committed on is reported (not fixable) and kept by the sweep. A new
    run of the job moves it aside to `-kept-<time>`, with the owner's commit intact.
18. A steered turn that shows a tool call but no `UserPromptSubmit` isn't cut off at the grace
    period: the job ends at that turn's Stop.

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
