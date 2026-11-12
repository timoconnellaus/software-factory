# Spec 39: the runner host re-adopts its live jobs after a restart

Read first: ADRs [0520](../adr/0520-runners-keep-claiming-while-an-update-waits.md) and spec
[38](38-runner-updates-without-draining.md), [0360](../adr/0360-runners-update-themselves-to-the-deployed-commit.md),
[0380](../adr/0380-runner-local-tmux-and-hook-status.md) (jobs in tmux on `-L software-factory`),
[0035](../adr/0035-lease-fencing-and-one-branch-per-run.md) (fencing),
[0052](../adr/0052-job-tokens-and-branch-confinement.md) (job tokens),
[0350](../adr/0350-how-the-planning-loop-is-wired.md) (the planning relay),
[0430](../adr/0430-a-container-per-job.md), [0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md),
[0450](../adr/0450-a-stream-json-session-mode-with-a-chat-view.md); `local/runner-host/src/host.ts`,
`job.ts`, `live-jobs.ts`, `cli.ts` (`shutdown`), `packages/runner-local/src/adapter.ts`, `stream.ts`,
`reap.ts`. Spec only: no code yet.

## Goal
A runner host process that stops (a self-update, a crash, `launchctl kickstart`, a reboot of the
service but not the machine) comes back and carries on with the jobs it was running, instead of
cancelling or reaping them. The agent's session lives in tmux, which survives the host process, so
nothing about the job has to stop. Then an update needs no idle moment: the host updates as soon
as one is pending, and the caps in spec 38 only matter for sessions that can't be re-adopted.

## Scope
- **What a job leaves on disk, written as it runs** (`<runsDir>/<jobId>/`, 0600, under the state
  dir the harness denies):
  - `job.json`: the `Job` as claimed (stage, branch, repo, lease with its fencing token, limits),
    updated when the heartbeat renews the lease. Never the job token.
  - `host.json`: the host's progress: the phase (`preparing`, `running`, `collecting`,
    `handing-back`), the workspace handle and session handle (tmux session name, or the container
    and proxy names), the start SHA and `ahead`, the last event `seq` the engine accepted, the
    `status.jsonl` byte offset and the `capture-pane` position already sent, and the planning
    relay's port and secret for a planning job.
  - What is already there: `launch.json` (the launch record), `claude.pid`, `status.jsonl`,
    `.factory-prompt.md`, the result file.
  `live-jobs.json` keeps naming the jobs and the writer's pid; a job in it with a `host.json` is a
  candidate for re-adoption.
- **On start, before reaping and before the first claim,** the host re-adopts each candidate:
  1. **Is it still ours?** One heartbeat that reports the candidates with their fencing tokens. A
     `cancel` for one (fenced, run ended, kill switch) means it isn't: release it as today. The
     lease is 10 minutes (`LEASE_TTL_MS`), so a restart that takes longer loses the job to the
     Workflow's retry, which is the correct outcome.
  2. **Is the session the one it launched?** The tmux session `sf-<jobId>` exists on the factory
     socket, and `verifyLaunch` against `launch.json` passes for the live process (the ADR 0270
     check, run again). A mismatch fails the job with `harness-config-mismatch`, as at launch.
  3. **Resume the job loop from its phase,** with the same fencing token: tail `status.jsonl` from
     the saved offset, continue `capture-pane` deltas, send events from `seq + 1`, renew the lease
     on each heartbeat, take steers on the held call again, and serve the web terminal's held call
     again (the tmux control-mode bridge is per host process, so it is opened anew). A job in
     `preparing` (no session yet) or `handing-back` is safer redone: release and let the Workflow
     retry, or finish the hand-back if the run branch is already pushed (the engine's hand-back is
     idempotent on its key).
  4. **The job token:** never persisted. It is short-lived, so the resumed job mints a new one with
     `run.issueToken` (the channel's `token` call, with the fencing token) when it next pushes or
     reads the repo, as it does today.
  5. **Planning jobs:** the relay is an HTTP server in the host process on 127.0.0.1. The host
     re-binds it on the saved port with the saved secret, so the session's MCP server and hooks
     keep working; if the port is taken, the job ends and the planning session resumes on the
     pinned runner as any yielded session does (ADR 0300).
  Only jobs that pass all of this count as running; the rest are released, and `reapOrphans` then
  runs as today on what is left.
- **Isolation modes.**
  - **sandbox (tmux):** as above.
  - **container:** the tmux pane runs `docker run -it`, and the egress proxy is its own container,
    so both survive the host. Re-adoption also runs the container side of the launch check
    (`checkRunningContainer`: the agent container and the proxy are the ones the record names). The
    post-session git-dir check and credential scan run when the session ends, as today.
  - **Sprites** (spec 36, when merged): the sprite is remote and outlives the host by design. The
    saved session handle names the sprite; re-adoption reconnects to it through the owner's Sprites
    API credential and checks it against its launch record the same way. If spec 36's session
    stream can't be reattached, those jobs drain like stream-json ones (below).
- **stream-json sessions don't survive.** The session is a child process with piped stdin and
  stdout (`stream.ts`). When the host process exits, the pipes close and Claude exits at EOF, so
  there is nothing to re-adopt. Two ways out; this spec picks the first and leaves the second for
  later:
  1. **They still drain:** a host with a live stream-json job updates only when that job ends
     (spec 38's rules, caps included), and a crash fails the job as today. The session's
     transcript survives, so a person can still `claude --resume` it.
  2. Later: run the stream session under a small supervisor (one per job, a separate process that
     owns the pipes and exposes them on a unix socket in the run dir). The host then re-adopts it
     like a tmux session. Its own ADR, since it adds a long-lived process per job.
- **SIGTERM no longer cancels.** Today `shutdown` calls `host.stop({ cancel: true })`, which aborts
  every job and releases it. With re-adoption, SIGTERM (launchd/systemd stopping or restarting the
  service) stops the loop, flushes events and `host.json`, and exits, leaving the sessions running.
  An explicit `sf-runner stop --cancel` (and `uninstall`) keeps today's behaviour. SIGINT in a
  terminal asks which.
- **Updates no longer wait to be idle.** When every running job can be re-adopted (no stream-json
  session, none in `preparing` or `handing-back`), the self-updater applies a pending update at the
  next heartbeat and exits 75; the new code re-adopts the jobs. With one that can't, spec 38's rules
  hold. A `minRunnerCompat` drain still claims nothing new, but it too updates without waiting when
  the jobs can be re-adopted. The rollback wrapper is unchanged; a rolled-back start re-adopts the
  jobs too, on the old code.
- **Compatibility of the files.** `job.json` and `host.json` carry a format version. New code that
  reads a version it doesn't know, or that has a lower `RUNNER_COMPAT` than the job was claimed
  under, doesn't re-adopt: it releases the job (the Workflow retries it).

## Out of scope
- Re-adopting across a machine reboot (tmux dies with the machine; the lease expires and the
  Workflow retries, as today).
- Moving a live job to another host.
- The stream-json supervisor (option 2 above).

## Acceptance criteria
1. A build running in tmux survives `kill -TERM` of the host: the session keeps running, and the
   restarted host reports the job on its first heartbeat with the same fencing token, renews its
   lease, sends events from the next `seq` (none lost or duplicated) and hands back normally. The
   PR goes green through `factory/verify`.
2. The same with a self-update between the two processes: a pending update applies with a job
   running, the new code re-adopts the job, and the job finishes on its original session.
3. A restart that takes longer than the lease (or a job fenced meanwhile) releases the job and kills
   its session; the Workflow retries it elsewhere.
4. A re-adopted session whose live process doesn't match `launch.json` fails with
   `harness-config-mismatch`, before any further event is sent.
5. No job token is written to disk; the first push after re-adoption mints a fresh one.
6. A planning session re-adopted after a restart keeps answering its MCP calls through the
   re-bound relay.
7. A container job is re-adopted with its agent and proxy containers checked; a Sprites job (once
   spec 36 is merged) reconnects to its sprite.
8. A host with a live stream-json job does not apply an update until that job ends (spec 38's
   rules), and its crash fails that job as today.
9. `sf-runner stop --cancel` cancels and releases every job, as SIGTERM does today; plain SIGTERM
   cancels none.
