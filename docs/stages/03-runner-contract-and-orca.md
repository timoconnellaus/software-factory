# Stage 3: Runner contract, signed channel and `runner-orca`

Read first: ADRs [0014](../adr/0014-runners-are-adapters.md),
[0015](../adr/0015-scheduler-runtime-pool-and-capabilities.md),
[0016](../adr/0016-signed-runner-channel.md), [0017](../adr/0017-harness-adapters.md),
[0023](../adr/0023-runners-owned-by-users-and-requester-routing.md); the runner write-ups under
`spikes/` once they land.

## Goal
The implement stage runs Claude Code in an Orca worktree on the Mac mini, through a contract that
knows nothing about Orca.

## Scope
- `packages/runner-contract`: the contract operations (claim job, prepare workspace, start harness
  session, stream events, collect artifacts, hand back, report capacity and capabilities) and the
  capability manifest type.
- Signed channel: HMAC over method, path, body hash and timestamp, valid 5 minutes, idempotent by
  request id. The runner host connects outbound only.
- `local/runner-host`: registers a runner (owner, capacity, capabilities), polls or holds a
  connection for jobs, loads adapters.
- `packages/runner-orca` (promoted from the spike): worktree + branch, start Claude in a terminal,
  send the prompt, wait, collect output. Declares `browser`, `ui-takeover`, `auto-register`.
- `packages/harness-claude`: starts a Claude Code session with the work item's spec and acceptance
  criteria injected, and reports its capability manifest.
- Scheduler in `sf-engine`: place a stage job on a runner with the needed capabilities, requester's
  runners first, then the shared pool, else queue. Respect capacity.

## Out of scope
`runner-local`, elastic runners, live steering and takeover (R2), artifacts beyond logs and the
branch.

## Acceptance criteria
1. No file in `packages/core`, `packages/runner-contract` or `apps/*` imports Orca or
   `runner-orca` (an import-boundary check in `pnpm lint`).
2. A request with a bad signature, a stale timestamp (> 5 min) or a replayed request id is refused.
3. A runner at capacity gets no new job; a job that needs `browser` never goes to a runner without it.
4. With `route: requester-first`, a job goes to the requester's runner when it has a slot, else to
   the pool, else it queues.
5. End to end on the Mac mini: an approved work item produces a branch `factory/<id>-<slug>` with
   commits from Claude Code, and the work item moves to verify.
6. A sketch of `runner-local` against the same contract typechecks, proving the contract is
   Orca-free.
7. The factory stores no harness or provider credentials.
