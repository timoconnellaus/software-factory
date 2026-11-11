# ADR 0100: The runner contract

Status: accepted, 2026-11-11. Proposed by the spike `spikes/runner-orca`; promoted into `packages/runner-contract` by the V1 core + engine build (block B+C+D in [`../parallel-work.md`](../parallel-work.md)).

## Context
The plan's rule is that the factory schedules and runners execute. The core must never import Orca. v1 runs Claude Code through Orca on the Mac mini. Later runners are plain worktrees, dev boxes, CF Sandbox, GitHub Actions and Codex Cloud, and runners are owned by users. Runners sit behind NAT on people's machines, so the cloud can't call them.

## Decision
- **The contract has two layers, and both are in `packages/runner-contract`. It is runtime-neutral, using Web APIs only.**
  1. **Adapter interface** (`RunnerAdapter`): this is all a runner implements. The methods are `manifest()`, `capacity()`, `prepareWorkspace(job)`, `startSession(job, ws)`, `events(job, session)` (an async iterable ending in `session.ended`), `collectArtifacts(job, ws, session)`, `release(job, ws, session)` (must be safe to call twice), and an optional `steer`. Workspace and session handles are adapter-extensible: the core reads `path`, `branch`, `baseSha` and `sessionRef`, and nothing else.
  2. **Wire protocol** between the runner host (`local/runner-host`) and the engine. The host claims, numbers events, accounts for capacity, applies timeouts and always releases, so every adapter gets these for free.
- **Capability manifest:**
  - The manifest is `{ contractVersion, runnerKind, harnesses, capabilities }`.
  - The capabilities are `browser`, `ui-takeover`, `auto-register`, `hooks`, `headless` and `own-hardware`. The names come from the CONTEXT.md glossary; `hooks` and `headless` are new and should be added there.
  - A job lists `requires`. The scheduler only places it on a runner whose manifest covers it, and the host refuses it again on receipt (`canRun`).
  - `runnerKind` is informational: the core never branches on it, and a test enforces that.
- **Lifecycle:** claimed → preparing → running → collecting → handed_back | failed → released. Artifacts are collected after a failure or timeout too, because a partial diff and logs are what a person needs. Release always runs.
- **Outbound-only channel:**
  - The host makes POST calls to `/runner/v1/{heartbeat, claim, jobs/:id/{events,artifacts,handback,release}}`.
  - Cloud → runner commands (`cancel`, `steer`, `drain`) ride back on the heartbeat response.
  - Claiming is **pull**: the host heartbeats with its manifest and capacity, then claims if it has room.
- **Signing** (same construction as Relationship OS ADR 0250):
  - Each runner's key is `base64url(HMAC-SHA256(RUNNER_CHANNEL_SECRET, "sf-runner-channel:<runnerId>:v<keyVersion>"))`. It is derived, not stored; only the key version is stored per runner. Bumping the version revokes that runner alone (ADR 0016: "revoked by rotating its key").
  - Each request carries the headers `x-sf-runner`, `x-sf-timestamp`, `x-sf-idempotency-key` and `x-sf-signature: v1=<hex HMAC(key, "v1\n<runner>\n<ts>\n<METHOD>\n<path>\n<sha256(body)>\n<idempotency key>")>`.
  - Requests more than 5 minutes off are refused, and the signature is compared in constant time.
  - The idempotency key is inside the signature, so it can't be swapped onto another body.
  - **Responses are signed too** (ADR 0016: "every call in either direction"). The response signature is `v1=<hex HMAC(key, "v1-response\n<runner>\n<ts>\n<status>\n<path>\n<sha256(body)>\n<idempotency key>")>`, so a proxy can't hand the host a job or command the cloud never sent, or swap one call's answer onto another. Refusals (401) go out unsigned, and the host treats them as failures.
- **Idempotency:** each call's key is derived from what it means, so a retry after a crash sends the same key:
  - `claim:<runner>:<claimId>`
  - `ev:<job>:<firstSeq>-<lastSeq>`
  - `art:<job>:<content hash>`
  - `hand:<job>`
  - `rel:<job>`

  The cloud stores (runner, key) → (body hash, response). A repeat gets the stored response, and the same key with a different body gets 409. Events are also deduplicated on (job, seq). No nonce is stored: a replay within 5 minutes returns the stored answer and changes nothing.
- **Artifacts:**
  - The kinds are `diff` (patch, base and head SHAs, branch, stats), `pr`, `log`, `screenshot` and `summary`.
  - Each artifact's id is a content hash.
  - The diff is taken against the workspace's `baseSha` with `git add -A`, so commits, edits and new files are all included.

## Consequences
- A new runner is one adapter file. runner-local is under 200 lines, with no contract changes, and passes the same end-to-end job.
- Orca-only features stay as capabilities. Takeover is exposed as an opaque `{ label, hint }` on the session, so the UI never learns what an Orca terminal handle is.
- Pull-based claiming adds up to one heartbeat interval of latency per job. That's acceptable for jobs that last minutes.
- Rotating `RUNNER_CHANNEL_SECRET` re-keys every runner, as in CRM ADR 0250. To revoke one runner, bump its key version instead.

## How this sits with the accepted ADRs
- It **implements** ADR 0014 (runners are adapters), 0015 (capabilities on the manifest; capacity in the heartbeat) and 0016 (signed channel). It also answers 0016's open question about how jobs are assigned: **pull**, meaning heartbeat then claim. A WebSocket to a Durable Object can replace the polling later without changing the calls.
- Stage 3 acceptance criterion 2 says a replayed request id is "refused". This spike instead **answers a replay from the idempotency store and never runs it twice**. Refusing it would break the host's retry after a lost response (for example a claim whose reply never arrived). A different body under the same key *is* refused (409). See open question 7.
- Stage 3 criterion 6 (a `runner-local` sketch type-checks against the same contract) is met, and it also runs end to end.

## Open questions (picked a default; revisit)
1. **Harness vs runner split.** The plan has a `harness-claude` package. In this spike, runner-orca hands the harness to Orca (`agent launch --agent claude`) and runner-local runs `claude -p` itself. Should a harness adapter produce the launch command or arguments and the event parser, with runners only hosting it? Orca's launch API doesn't take arbitrary arguments today (finding 7).
2. **Leases.** The job carries a lease. My working proposal is that the heartbeat's `activeJobIds` renews every listed lease, so there's no separate renew call. Cloud side not built.
3. **Who issues a runner's id and key version.** Registration (owner, capacity) belongs in `local/runner-host` and an operation such as `runner.register`. Should the key be shown once at registration, as with an API token, or derived on the host from a one-time pairing code?
4. **Concurrent duplicate calls.** The in-memory idempotency store does get then put. The engine should use a Durable Object per runner, or `INSERT … ON CONFLICT DO NOTHING`, so two simultaneous identical calls can't both run.
5. **Large artifacts.** Screenshots and patches are inline base64 JSON. The real system should upload them to R2 via a signed upload URL returned by the artifacts call.
6. **Diff vs PR.** Should the runner push and open the PR (runner owner's git credentials), or should the cloud do it through the GitHub App from the diff? The plan says "agents never hold raw tokens", which points to the cloud applying the diff.
7. **Replay semantics vs stage 3.** Should the stage 3 wording change from "a replayed request id is refused" to "a replayed request id is answered from the store and never re-executed"? This spike recommends the change.
8. **Capability names.** The task brief used `takeover` and `autoRegisterSessions`. The glossary says `ui-takeover` and `auto-register`, and the spike follows the glossary.

> Amended 2026-11-11 (V1 core + engine, promotion): the contract now lives in
> `packages/runner-contract` (`types.ts`, `wire.ts` zod schemas, `channel.ts`, `protocol.ts`,
> `stage-results.ts`), `CONTRACT_VERSION` is `"1"`. Changes from the spike:
> (1) every job carries `lease.fencingToken` and every job-scoped call sends it; a stale one is
> answered 409 `fenced` and the host must stop the run ([ADR 0035](0035-lease-fencing-and-one-branch-per-run.md));
> the heartbeat's `activeJobs` lists `{ jobId, fencingToken }` and renews each current lease
> (open question 2: answered yes, no separate renew call);
> (2) a new call, `POST /runner/v1/jobs/:id/token`, mints the **job token** and is never stored in the
> idempotency store ([ADR 0052](0052-job-tokens-and-branch-confinement.md)); the job itself carries no token;
> (3) `output: "diff" | "pr"` is gone: a run pushes its own branch `factory/<n>-<slug>-run-<k>` with the
> job token and hands back `branch` + `headSha`; the control plane moves the work item branch and opens
> the PR through the App (open question 6: neither the runner nor the owner's credentials open PRs);
> (4) `Handback.result` carries the stage's structured result (`stage-results.ts`), which the harness
> writes to `.factory-result.json` (`RESULT_FILE`) and the host never commits;
> (5) the idempotency store is `begin/complete/abandon` and the engine's is D1 with
> `INSERT … ON CONFLICT DO NOTHING` (open question 4); 5xx answers are not stored;
> (6) runners are registered with `runner.register` by their owner, who gets the key once; the key is
> still derived, never stored (open question 3); `runner.rotateKey` bumps the version;
> (7) the channel is served by `sf-engine` at `https://sf-engine.zerobsai.com/runner/v1/*`.
> Open questions 1 (harness vs runner split), 5 (large artifacts to R2) and 8 stay as they were.

