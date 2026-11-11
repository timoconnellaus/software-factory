# Spec 03: Runner contract, signed channel and `runner-orca`

Read first: ADRs [0014](../adr/0014-runners-are-adapters.md),
[0015](../adr/0015-scheduler-runtime-pool-and-capabilities.md),
[0016](../adr/0016-signed-runner-channel.md), [0017](../adr/0017-harness-adapters.md),
[0023](../adr/0023-runners-owned-by-users-and-requester-routing.md),
[0033](../adr/0033-per-job-github-app-tokens.md),
[0035](../adr/0035-lease-fencing-and-one-branch-per-run.md),
[0038](../adr/0038-runner-sharing-is-an-owner-allowlist.md),
[0040](../adr/0040-web-push-and-wip-backpressure.md); spike ADR 0100 and the write-up in
`spikes/runner-orca/`.

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): runs push with a per-job App token, under a fencing
> token, to their own branch; the harness has no owner git or cloud credentials; runners are
> owner-only unless allowlisted; the scheduler applies WIP backpressure and skips rate-limited
> runners. Criterion 2 is amended: a replayed request id is answered from the idempotency store,
> not refused. Part of R1 milestone (a), except criterion 4 (milestone (c)).
>
> Amended 2026-11-11 ([spec wi-1](wi-1-let-s-also-make-it-so-work-items-can-hav.md), [ADR 0310](../adr/0310-work-item-attachments.md)): the channel has two
> more job calls, `attachments` (list) and `attachment` (one file), never stored in the idempotency
> store, behind the optional capability `work-item-attachments`. `runner-orca` declares it and puts
> the files outside the worktree; adapters without it run unchanged.

## Goal
The implement stage runs Claude Code in an Orca worktree on the Mac mini, through a contract that
knows nothing about Orca.

## Scope
- `packages/runner-contract`: the contract operations (claim job, prepare workspace, start harness
  session, stream events, collect artifacts, hand back, report capacity, capabilities and state) and
  the capability manifest type, including `hooks` and `headless`. Runner state includes
  "rate-limited until T".
- Signed channel: HMAC over method, path, body hash and timestamp, valid 5 minutes, idempotent by
  request id: a replay gets the stored first response. The runner host connects outbound only.
- Jobs carry a **job token** (GitHub App installation token for the one repo, minted by the GitHub
  connector, expiring with the lease or after an hour) and the current **fencing token**. Every
  call back from the run carries the fencing token.
- `local/runner-host`: registers a runner (owner, capacity, capabilities), polls or holds a
  connection for jobs, loads adapters. Starts the harness with a **scrubbed environment** (no
  `GH_TOKEN`, SSH agent, cloud CLI config or keychain git helper) and a git credential helper that
  serves only the job token.
- `packages/runner-orca` (promoted from the spike): worktree on the run branch, start Claude in a
  terminal, send the prompt, wait, collect output. Declares `browser`, `ui-takeover`,
  `auto-register`, `hooks`.
- `packages/harness-claude`: starts a Claude Code session with the work item's spec and acceptance
  criteria injected, projects a per-run `.claude/settings.json` (allowed tools, denied commands,
  hooks), and reports its capability manifest.
- Branches: each run pushes `factory/<id>-<slug>-run-<n>`; on a hand-back with the current fencing
  token, the control plane fast-forwards `factory/<id>-<slug>` to it through the App.
- Scheduler in `sf-engine`: place a stage job on a runner with the needed capabilities, the
  requester's runners first, then runners whose sharing allowlist covers the project, else queue.
  Respect capacity, skip rate-limited runners, and start no new build for a project at its WIP limit.

## Out of scope
`runner-local` beyond the sketch, elastic runners, live steering and takeover UI (R2), artifacts
beyond logs and the branch, the sharing UI (spec 11, milestone (c)).

## Acceptance criteria
1. No file in `packages/core`, `packages/runner-contract` or `apps/*` imports Orca or
   `runner-orca` (an import-boundary check in `pnpm lint`).
2. A request with a bad signature or a stale timestamp (> 5 min) is refused. A replayed request id
   is answered from the idempotency store with the first response, and the handler does not run
   again.
3. A runner at capacity gets no new job; a job that needs `browser` never goes to a runner without
   it; a rate-limited runner gets no job until its time passes.
4. _(milestone (c))_ With `route: requester-first`, a job goes to the requester's runner when it has
   a slot, else to a runner whose allowlist covers the project, else it queues. A runner with no
   allowlist entry for the project never gets its job.
5. End to end on the Mac mini: an approved work item produces a run branch
   `factory/<id>-<slug>-run-1` with commits from Claude Code, `factory/<id>-<slug>` is moved to it,
   and the work item moves to verify.
6. A sketch of `runner-local` against the same contract typechecks, proving the contract is
   Orca-free.
7. The factory stores no harness or provider credentials.
8. The harness process has no `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK` or cloud credentials in
   its environment, and its git can push only with the job token (a test on the host's launch).
9. After a takeover bumps the fencing token, the old run's next event or push is refused, the host
   stops it, and its slot is free.
10. A project at its WIP limit gets no new build; the item queues with the reason "waiting on review".
