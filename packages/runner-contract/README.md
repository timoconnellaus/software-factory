# @software-factory/runner-contract

The runner contract (ADRs 0014, 0016, 0100, 0052): what a runner adapter implements, the capability
manifest, the wire shapes of the signed channel (zod), the signing and idempotency helpers, an HTTP
client for the runner host, and what a `flow` run hands back. Runtime-neutral (Web APIs + zod); it
names no runner, and a guard test keeps Orca out of it, `packages/core` and `apps/*`.

## One stage: `flow` (spec 70)
A job is a run of an agent-owned status in the new core (`JOB_STAGES` is `["flow"]`). It may have a
`repo` and a `branch` (the item's branch, `factory/flow-<key>-<n>`, see `isFlowBranch`), or neither
(`hasRepo(job)` tells them apart). Without one the runner gives the job a fresh empty directory,
removed on release, and skips every git step. With one it makes a worktree on the item's branch,
commits what the session left and pushes the branch. Either way the result is read from
`RESULT_FILE` and is `flowResultSchema`, `{ outcome: "done" | "rejected", summary }`. A flow job
takes a slot in the light pool.

Capability names the old pipeline used stay in `CAPABILITIES` so a runner on older code is not
refused before it updates itself (ADR 0520); nothing acts on them.

## The workspace resolution rule (ADR 0260)
A runner makes a job's workspace inside the checkout its machine already has for the job's repo,
found by canonical identity (`canonicalRepoKey(job.repo)` → `github.com/<owner>/<name>`, lower-cased;
`canonicalKeyFromUrl` for a remote URL). The adapter names it from `resolveCheckout(job)`; the host
fetches the base into it (never writing the token to its config) instead of cloning. Only when there
is none does the host clone. Per-job state is a worktree and a branch; `release` never unregisters
or deletes a checkout.

## The runner host's loop (`local/runner-host`)
1. `heartbeat` every ~20 s with the manifest, capacity, `rateLimitedUntil` and `activeJobs`
   (`{ jobId, fencingToken }`): renews each lease and returns `cancel`, `drain` and `account.use`
   commands, the desired runner version and the engine's `minRunnerCompat`.
2. `claim { claimId }` when there's room. The `Job` carries the prompt, the model and effort, MCP
   servers, the lease's fencing token and, with a repository, `repo` and `branch`.
3. With a repository, `token(jobId, fencingToken)`: a fresh GitHub App token for the one repo,
   `contents: write`, for the item's branch only. Never cached by the cloud. Revoke it when done.
4. Run the adapter; send `events` and `artifact`s with the fencing token. Events include `message`
   (what the agent said) and `tool`; a stream-json session (`chat`, ADR 0450) also sends
   `tool.result` and `turn` (token counts).
5. Read the result from `RESULT_FILE` (`.factory-result.json`, never committed); with a repository
   commit what is left and push the branch if the run made commits; then `handback { branch,
   headSha, result }` and `release`.
6. Any `409` with code `fenced` or `killed`: stop the session, release the workspace, drop the job.

`httpControlPlane({ baseUrl: "https://sf-engine.zerobsai.com", runnerId, key })` implements all of
these with signed requests and verified responses.
