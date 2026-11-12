# @software-factory/runner-contract

The runner contract (ADRs 0014, 0016, 0100, 0052): what a runner adapter implements, the capability
manifest, the wire shapes of the signed channel (zod), the signing and idempotency helpers, an HTTP
client for the runner host, and the result each stage hands back. Runtime-neutral (Web APIs + zod);
it names no runner, and a guard test keeps Orca out of it, `packages/core` and `apps/*`.

## The workspace resolution rule (ADR 0260)
A runner makes a job's workspace inside the checkout its machine already has for the job's repo,
found by canonical identity (`canonicalRepoKey(job.repo)` → `github.com/<owner>/<name>`, lower-cased;
`canonicalKeyFromUrl` for a remote URL). The adapter names it from `resolveCheckout(job)`; the host
fetches the base into it (never writing the token to its config) instead of cloning. Only when there
is none does the host clone, and the adapter registers that clone once and keeps it. Per-job state is
a worktree and a branch; `release` never unregisters or deletes a checkout.

## The runner host's loop (`local/runner-host`)
1. `heartbeat` every ~20 s with the manifest, capacity, `rateLimitedUntil` and `activeJobs`
   (`{ jobId, fencingToken }`): renews each lease (10 min) and returns `cancel` commands for jobs the
   cloud stopped (cancelled, taken over, kill switch).
2. `claim { claimId }` when there's room. The `Job` names the run branch (`job.branch`, the only
   branch it may push), its base (`job.repo.baseRef`, the work item branch; `job.repo.defaultBranch`, optional, is merged into a build's run branch before the session, ADR 0320), the role and model, the
   prompt and context, and `lease.fencingToken`.
3. `token(jobId, fencingToken)`: a fresh GitHub App token for the one repo, `contents: write`. Never
   cached by the cloud. Give the harness a git credential helper that serves only this token, in a
   scrubbed environment (no `GH_TOKEN`, SSH agent, cloud credentials). Revoke it when done.
4. With the `work-item-attachments` capability (ADR 0310), after `prepareWorkspace`:
   `attachments(jobId, fencingToken)` lists the work item's files and `attachment(jobId,
   fencingToken, id)` fetches one (base64). Neither answer is stored by the cloud. The adapter's
   `attachFiles` puts them outside the git tree and returns the prompt section (labelled
   `untrustedData` blocks). Adapters without the capability skip this.
5. Run the adapter; send `events` and `artifact`s with the fencing token. Events include
   `message` (what the agent said, from its transcript) and `log` with `screen: true` for the
   visible screen (ADR 0400). With the `steer` capability and `adapter.steer`, keep
   `steers(jobId, { fencingToken, waitMs })` open while the session runs: the cloud holds it until
   the runner's owner sends a message from the dashboard (or ~25 s), and the host types each one
   with `adapter.steer(session, steerText(text))`. Not stored by the cloud; at most once. A 404 (an
   older engine) means stop asking. A steer of `kind: "takeover"` (from `run.takeover`, ADR 0450)
   is not typed: the host calls `adapter.takeover(session)`.
   A runner with `chat` (a stream-json session, ADR 0450) also sends `tool` with an `id`,
   `tool.result` (output ≤ 4,000), `turn` (outcome, time, token counts) and, after a takeover,
   `takeover` (the resume command); its `session.started` says `mode: "stream"`.
6. Read the stage result from `RESULT_FILE` (`.factory-result.json`, never committed), push the run
   branch, then `handback { branch, headSha, result }` and `release`.
7. Any `409` with code `fenced` or `killed`: stop the session, release the workspace, drop the job.

`httpControlPlane({ baseUrl: "https://sf-engine.zerobsai.com", runnerId, key })` implements all of
these with signed requests and verified responses.
