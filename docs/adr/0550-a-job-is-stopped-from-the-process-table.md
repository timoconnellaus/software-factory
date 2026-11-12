# ADR 0550: A job is stopped from the process table, and a slow tmux is not a gone session

Status: accepted, 2026-11-12. Spec [43](../specs/43-runners-under-load.md). Incident
[#11](../incidents/2026-11-11-bootstrap.md#11-under-load-tmux-stopped-answering-and-jobs-left-claude-running).
Amends [0380](0380-runner-local-tmux-and-hook-status.md) and
[0270](0270-the-factory-launches-the-harness-and-verifies-it.md).

## Context
Under load (17–25 on the M5), tmux client commands took minutes. runner-local read any failed or
timed-out tmux call as "the session is gone". It handed jobs back as ended and then tried
`kill-session`, which failed too. The jobs' Claude processes kept running as orphans, adding to
the load, and every new job failed at its first `kill-session`. Stopping a job relied on tmux alone,
and nothing checked that it had worked.

## Decision
1. **Only tmux's own words mean gone.** Those are "can't find session|window|pane", "no server
   running on" (ECONNREFUSED) and "error connecting to … (No such file or directory)" (ENOENT), as
   printed by tmux 3.3 through 3.6a. A timeout, any other exit, or any other connect error
   (EAGAIN under load) retries with backoff and jitter, bounded, and then throws `TmuxUnavailable`.
   Typing (`send-keys`) is never retried after a timeout, because it may have arrived. Every tmux
   exec has a timeout.
2. **A job's processes are found by its settings path.** The launch script `exec`s Claude with
   `--settings <runDir>/claude-settings.json`. That path is on Claude's command line for as long as
   it runs, and on no other process's. It's read with `ps -A -ww -o pid=,ppid=,pgid=,command=`.
   The pid file only ever describes; a pid is never signalled on the pid file's word, because a
   stale pid may belong to anything.
3. **The group is the pane's.** tmux starts each pane with `forkpty()`, which calls `setsid()`, so
   the pane's first process leads its own session and process group. The launch script is that
   process (`exec /bin/sh launch.sh`), and it `exec`s Claude, so Claude is the group leader
   (pgid = pid). A stream session is spawned `detached` (setsid) for the same reason. The tools
   Claude runs inherit the group. No `setsid` or `set -m` is added: the leader is already right,
   and the stop checks `pgid === pid` before signalling a group. A process that isn't a leader is
   signalled alone. Descendants that left the group are found from the ppid tree before anything
   dies and is re-parented. The runner's own group is never signalled.
4. **Stop means TERM, then KILL, then check.** Release, a failed start, a re-run of the same job
   and the reaper send TERM to the group, wait (5 s), send KILL, wait (3 s), and then read `ps`
   again. They do this whether or not `kill-session` worked. If a process with the settings path
   is still there, or `ps` can't be read, they throw `HarnessStillRunning`, a `ReleaseIncomplete`
   from the runner contract.
5. **A job whose processes may be alive is never reported released.** On `ReleaseIncomplete` the
   host skips the channel's `release` and the `released` state. It logs "NOT released", and the
   lease lapses instead (ADR 0035). The adapter keeps the survivor, retries the stop on each
   capacity read and counts it as in use. `sf-runner doctor` reports it (`orphan-process`) and
   `--fix` stops it.
6. **Ended means the process is gone.** In the events loop, a tmux that doesn't answer is reported
   once (a `stderr` log line). It isn't a new agent status, so the contract is unchanged. The job
   keeps reading the hook file. It ends only when `ps` shows no Claude for it, and unknown counts
   as alive. A session that's gone while Claude still runs waits `goneGraceMs`, then fails, and
   release stops Claude. Capacity with a silent tmux counts the sessions the adapter started and
   pauses claims (`paused.reason: "tmux"`, ADR 0552).

## Consequences
- An overloaded host keeps its jobs running instead of shedding them as failures, and can't leave
  a Claude behind without someone hearing about it.
- Container jobs (ADR 0430) aren't stopped this way: their processes aren't the host's to see. The
  container's removal stops them, as before. Nor are Sprites jobs (ADR 0480): the sprite's destroy
  is their stop, and a sprite that can't be destroyed makes release throw `ReleaseIncomplete` too.
- A descendant that `setsid`s and then re-parents before release starts is not found. That is a
  daemon the agent started on purpose. The sandbox already limits what it can reach, and the next
  doctor run doesn't see it either, since it carries no settings path. That's a known limit.
- One `ps` per release, and per poll only while tmux is silent or the pane is gone.
