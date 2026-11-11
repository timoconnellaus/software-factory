# Spike: runner contract + runner-orca

Goal: show that the **runner contract** is runner-agnostic and that an Orca adapter can implement it (plan, Next steps 3).

This is a standalone pnpm package and isn't in the workspace yet. Node ≥ 24 runs the `.ts` files directly.

```
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # unit tests, no Orca needed
pnpm e2e:orca                              # real run: needs Orca running and `orca` on PATH
E2E_TIMEOUT_MS=4000 pnpm e2e:orca          # same job cut off mid-session, to check cleanup
pnpm e2e:local                             # real run on runner-local: needs `claude` logged in
```

## Layout

| Path | What |
|---|---|
| `src/contract/types.ts` | The contract: `Job`, `CapabilityManifest`, `Capacity`, `WorkspaceHandle`, `SessionHandle`, events, artifacts, `Handback`, and the `RunnerAdapter` interface. |
| `src/contract/channel.ts` | The signed channel. It has per-runner HMAC keys with a version, so one runner can be revoked. Requests **and responses** are signed and verified within a 5-minute window. `handleRunnerCall` verifies, checks idempotency, runs the handler and signs the reply. Web Crypto only, so it runs in Workers and Node. |
| `src/contract/protocol.ts` | Wire calls (heartbeat, claim, events, artifacts, handback, release), their idempotency keys, and `httpControlPlane`, a signed client. |
| `src/host/runner-host.ts` | The generic runner host (`local/runner-host` later). `hostTick` sends a heartbeat, applies commands and claims a job. `runJob` takes it through prepare → start → stream → collect → hand back → release. Nothing here is Orca-specific. |
| `src/host/fake-cloud.ts` | The cloud end of the channel, in memory. It serves the real signed protocol through a `fetch` function. |
| `src/host/git.ts`, `exec.ts` | Shared host helpers: the diff artifact and branch deletion, plus an injectable `exec`. |
| `src/runner-orca/` | `orca-cli.ts` (a typed `--json` wrapper) and `adapter.ts` (the adapter). |
| `src/runner-local/adapter.ts` | A sketch that uses `git worktree` and headless `claude -p --output-format stream-json`. |
| `test/` | Unit tests for the channel, idempotency, the runner host's lifecycle and failure paths, the Orca adapter against a scripted CLI, stream-json parsing, and a **boundary guard**. The guard checks that `src/contract` imports nothing outside itself, uses no `node:` modules, and names no runner in code. Biome enforces the same import rule. |
| `scripts/e2e-*.ts` | End-to-end runs against a throwaway git repo. |

## What works (verified on this machine, 2026-11-11, Orca 1.4.256, Claude Code 2.1.322)

- **`pnpm e2e:orca` passes**, about 11–15 s per job. The steps:
  1. A throwaway repo is created.
  2. The fake cloud queues a job.
  3. The host heartbeats and claims it over the signed channel. Each run makes about 20 calls, with the request and the response both signed and verified.
  4. runner-orca registers the repo in Orca, creates a worktree tagged `sf-job:<id>`, and launches Claude Code in an Orca terminal with the prompt.
  5. It streams agent status, tool, log and done events, which arrive in seq order.
  6. It collects the `git diff` (`+hello from runner-orca`), the terminal screen, and a **screenshot from Orca's embedded browser** (the `browser` capability).
  7. It hands back and releases.

  The script then checks that **nothing is left**: no Orca worktree or terminal, the repo is unregistered from Orca, no git worktree, no branch, and no empty `~/orca/workspaces/<repo>/` folder.
- **Timeout path against real Orca** (`E2E_TIMEOUT_MS=4000`): the job ends `timed_out`, the partial diff and screenshot are still collected, and everything is still cleaned up.
- **`pnpm e2e:local` passes**: the same job, host and fake cloud, with runner-local in place of runner-orca. The adapter declares only `headless` and `own-hardware`, and the contract is unchanged. This is the evidence that the contract has no Orca-specific parts.
- Unit tests (29) cover:
  - request and response signatures (tampered body, path or idempotency key; another runner's key; a revoked key version; stale ±300 s);
  - idempotency (a replay returns the stored answer, a different body under the same key gets 409, and a re-sent claim returns the same job);
  - lifecycle order;
  - refusal on missing capabilities;
  - release after a failed prepare;
  - timeout;
  - cancel commands from the heartbeat;
  - the Orca adapter's stale-`done` race and double release.

**Not done:**
- `output: "pr"`: the artifact type exists, but neither adapter pushes or opens a PR yet.
- Lease renewal: the active-job list in the heartbeat is meant to renew the lease, but the cloud side isn't built.
- The real engine Worker and storage.
- Large-artifact upload: everything is inline JSON today.
- The `--environment` path to a paired remote Orca: supported by the wrapper, not tested.

## Findings about the Orca CLI

The Orca CLI was good to build on. The JSON envelope is the same on every command (`{ ok, result, error: { code, message } }`), so one wrapper covers all of it, and every step of the contract has a matching command. Rough edges, roughly in order of how much they matter to a runner:

1. **No per-worktree agent state.** `worktree show` has no `agents`, so completion is detected by polling the global `worktree ps --limit 10000` and filtering by worktree id. That's O(all workspaces) every poll. *Ask:* `worktree ps --worktree <sel>`, or `agent show/wait --pane <paneKey> --for done`.
2. **`terminal wait --for tui-idle` races the prompt.** In the probe it returned "satisfied" about 2 s after launch, which can be before the prompt's turn starts. `agent launch` reports `prompt.outcome: handed-to-terminal`, which doesn't prove the turn started, and unlike `terminal send` it has no `--wait-submit`. The adapter therefore treats the job as finished only when the agent's state is `done` **and** it was seen `working` or its `stateStartedAt` is after the launch. *Ask:* a launch receipt with a turn id, plus `agent wait --turn <id>`.
3. **Agent state values are undocumented.** Seen: `working`, `done`. The adapter maps anything containing wait/permission/input to `waiting_input` and anything unknown to `idle`. *Ask:* an enum in `agent-context --json`.
4. **No `repo rm`.** The only way to unregister a repo is `project setup-delete --setup <repoId> --force`. `--force` is needed even when no job worktrees remain, because the main checkout counts as "saved workspace details". The `--help` for `setup-delete` also describes `--setup` as "Setup policy run|skip|inherit", which looks like a copy-paste mistake.
5. **`worktree rm` leaves the per-repo folder** (`~/orca/workspaces/<repo>/`) behind even when it's empty. The adapter `rmdir`s it, which only works on an empty folder. The local branch also survives `worktree rm`; that's expected, and the adapter deletes it.
6. **Branch names:**
   - By default they are prefixed with `<git user>/`.
   - `--branch` overrides that.
   - A taken name **gets a numeric suffix without warning**, so the adapter reads the real branch back from the result. The contract's `WorkspaceHandle.branch` exists for this reason.
7. **There's no control over the harness's permission mode.** `agent launch` passes no extra CLI arguments, so Claude runs with the host user's own settings. On this machine that's auto mode, so the run is unattended. On a host where it isn't, a permission prompt would stall the run until takeover or timeout. *Ask:* `--agent-args`, or a per-launch permission profile. Until then, the runner owner's Claude settings are part of the runner's setup.
8. **`terminal read` without `--screen` turns a TUI into fragments.** It's fine for "something is happening" log events, but the useful log is a `--screen` read at the end. The cursor is easy to misuse: page with `nextCursor`, not `latestCursor`; I got this wrong first.
9. **The `screenshot --json` field for the file path isn't documented.** The adapter looks for any `.png` or `.jpg` path in the result. `tab create` returns `browserPageId` and `wait --page <id> --load load` works.
10. **Job tagging uses the worktree comment** (`sf-job:<id>`). This lets capacity and cleanup be rebuilt from Orca after a host restart, but a comment is visible to the user and they can edit it. *Ask:* a machine-only label or metadata field on worktrees.
11. Worktrees made by the CLI show up in the Orca sidebar as unread "in-progress" workspaces. That's good for takeover but noisy at 4 concurrent jobs. Worktrees always go under `~/orca/workspaces/<repoName>/`, wherever the repo lives.
12. Each CLI call takes about 0.1–0.3 s. At a 1.5 s poll with two calls per tick this is fine. At high concurrency, use the cheaper per-worktree query asked for in finding 1.

## Proposed ADR 0100: the runner contract

**Status:** proposed, 2026-11-11 (spike `spikes/runner-orca`). Copy it to `docs/adr/0100-runner-contract.md` when the repo gets its ADR folder.

### Context
The plan's rule is that the factory schedules and runners execute. The core must never import Orca. v1 runs Claude Code through Orca on the Mac mini. Later runners are plain worktrees, dev boxes, CF Sandbox, GitHub Actions and Codex Cloud, and runners are owned by users. Runners sit behind NAT on people's machines, so the cloud can't call them.

### Decision
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

### Consequences
- A new runner is one adapter file. runner-local is under 200 lines, with no contract changes, and passes the same end-to-end job.
- Orca-only features stay as capabilities. Takeover is exposed as an opaque `{ label, hint }` on the session, so the UI never learns what an Orca terminal handle is.
- Pull-based claiming adds up to one heartbeat interval of latency per job. That's acceptable for jobs that last minutes.
- Rotating `RUNNER_CHANNEL_SECRET` re-keys every runner, as in CRM ADR 0250. To revoke one runner, bump its key version instead.

### How this sits with the accepted ADRs
- It **implements** ADR 0014 (runners are adapters), 0015 (capabilities on the manifest; capacity in the heartbeat) and 0016 (signed channel). It also answers 0016's open question about how jobs are assigned: **pull**, meaning heartbeat then claim. A WebSocket to a Durable Object can replace the polling later without changing the calls.
- Stage 3 acceptance criterion 2 says a replayed request id is "refused". This spike instead **answers a replay from the idempotency store and never runs it twice**. Refusing it would break the host's retry after a lost response (for example a claim whose reply never arrived). A different body under the same key *is* refused (409). See open question 7.
- Stage 3 criterion 6 (a `runner-local` sketch type-checks against the same contract) is met, and it also runs end to end.

### Open questions (picked a default; revisit)
1. **Harness vs runner split.** The plan has a `harness-claude` package. In this spike, runner-orca hands the harness to Orca (`agent launch --agent claude`) and runner-local runs `claude -p` itself. Should a harness adapter produce the launch command or arguments and the event parser, with runners only hosting it? Orca's launch API doesn't take arbitrary arguments today (finding 7).
2. **Leases.** The job carries a lease. My working proposal is that the heartbeat's `activeJobIds` renews every listed lease, so there's no separate renew call. Cloud side not built.
3. **Who issues a runner's id and key version.** Registration (owner, capacity) belongs in `local/runner-host` and an operation such as `runner.register`. Should the key be shown once at registration, as with an API token, or derived on the host from a one-time pairing code?
4. **Concurrent duplicate calls.** The in-memory idempotency store does get then put. The engine should use a Durable Object per runner, or `INSERT … ON CONFLICT DO NOTHING`, so two simultaneous identical calls can't both run.
5. **Large artifacts.** Screenshots and patches are inline base64 JSON. The real system should upload them to R2 via a signed upload URL returned by the artifacts call.
6. **Diff vs PR.** Should the runner push and open the PR (runner owner's git credentials), or should the cloud do it through the GitHub App from the diff? The plan says "agents never hold raw tokens", which points to the cloud applying the diff.
7. **Replay semantics vs stage 3.** Should the stage 3 wording change from "a replayed request id is refused" to "a replayed request id is answered from the store and never re-executed"? This spike recommends the change.
8. **Capability names.** The task brief used `takeover` and `autoRegisterSessions`. The glossary says `ui-takeover` and `auto-register`, and the spike follows the glossary.
