# @software-factory/runner-host

The runner host daemon (`sf-runner`). It runs on a person's machine, connects **outbound** to the
factory over the signed channel (`https://sf-engine.zerobsai.com/runner/v1/*`, ADR 0016), and drives a
runner adapter. V1 wires `runner-orca` with the `harness-claude` harness. Decisions:
[ADR 0250](../../docs/adr/0250-runner-host-pushes-and-harness-projection.md).

## What it does
Every ~20 s it heartbeats: the manifest, capacity, and the jobs it holds with their fencing tokens.
The heartbeat renews each lease (10 min), and cancel/drain commands come back on the response.
While it has room it claims jobs; a retried claim reuses its `claimId`. For each job (`src/job.ts`):

1. It fetches a **job token** (`run.issueToken`): a GitHub App installation token for the one repo.
2. It fetches the item branch into the checkout this machine's Orca already has for the repo (found
   by canonical remote identity, ADR 0260), by URL, into `refs/software-factory/heads/<branch>`,
   with the token only in that git process's environment. It never changes that checkout's config,
   remotes, branches or working tree. Only when Orca has no repo for the remote does it clone, once,
   into `~/.local/state/software-factory/runner/repos/<owner>/<name>` (push URL disabled, no
   credential helper), which the adapter registers once and keeps.
3. runner-orca makes an Orca worktree, in that repo, on the run branch `factory/<n>-<slug>-run-<k>` and projects
   `harness-claude`'s per-run settings into it. Claude Code then starts in an Orca terminal (you can
   take it over there), with the harness's own flags, and is checked before it gets the prompt
   (ADR 0270).
   **Build only:** before the session the host fetches the job's `repo.defaultBranch` too and
   merges it into the run branch (a merge commit, never a rebase, ADR 0320). A conflict is left in
   progress for the session to resolve; unmerged paths at the end fail the run with no push.
4. It streams events (state, agent status, tools, terminal output) with the fencing token.
5. When the session ends it reads `.factory-result.json`, passes it through untouched, and deletes it.
6. **Build only:** it commits any leftovers, then pushes `HEAD` to the run branch, and only there,
   with a *fresh* job token. It never forces.
7. It uploads artifacts: the diff, the terminal screen, check output from Claude's transcript, and a summary.
8. It hands back `{ branch, headSha, result }`, releases the workspace, revokes the tokens and calls `release`.

A `409 fenced|killed`, or a cancel command, stops the session at once: no push and no hand-back.

### Pools and planning sessions (spec 20, ADR 0301, 0350)
Capacity has two pools: heavy (build, verify; `maxConcurrent`) and light (triage, spec, planning;
`maxLight`, default 6). The heartbeat and claim report both, and the host claims while either has
room; the cloud picks a job for a pool with a free slot.

A **planning** job is a long-lived Claude session that plans one work item with people (ADR 0300):
- The host serves it a **relay** on `127.0.0.1` (`src/planning-relay.ts`) with a per-job bearer
  secret. The harness's planning MCP server and hooks call it; the host adds the job and fencing
  token and signs the call (`/runner/v1/jobs/:id/planning`). The runner key never reaches the
  harness.
- runner-orca puts every job of a session in the same worktree path (`sf-plan-<session>`), so a
  resume (`claude --resume <sessionRef>`) finds the conversation.
- The session idles in its Stop hook between turns. When the factory asks it to yield, the hook calls
  `planning.yield`; the host then ends Claude and hands back `{ planning: "yielded" }`. No result file,
  no diff, no push.

### Credentials (ADR 0033, 0052)
- The harness never sees the job token or the owner's credentials. Git talks to GitHub only from the
  host, with no system or global git config, hooks off, and a credential helper that gives the token
  to `github.com` only. The token is passed in that one git process's environment.
- Claude starts with `--permission-mode <stage mode> --setting-sources project,local --settings <run
  settings>`: never your user settings, so your own Claude mode, hooks and plugins don't apply to a
  run. The runner checks the live process against that before sending the prompt; a difference kills
  it and fails the job (`harness-config-mismatch`). The mode per stage comes from the project's
  `.factory/policy.json` (`harness`), not from `runner.json`; an old `permissionMode` there is ignored.
- Every Bash command runs in Claude Code's sandbox: writes only to the worktree and temp, network
  only to the npm registry, GitHub, the Cloudflare API and the project's hosts.
- The harness's settings also do four things:
  - blank or redirect every credential variable (`GH_TOKEN`, `SSH_AUTH_SOCK`, AWS, Cloudflare, …);
  - point `GIT_CONFIG_GLOBAL` at a per-run config with no credential helper, and set `GIT_CONFIG_NOSYSTEM` (on macOS that turns off the keychain helper);
  - deny `git push`, `gh`, `ssh`, `wrangler`, cloud CLIs, `orca`, `security` and similar;
  - deny reads of `~/.ssh`, `~/.config/gh`, this runner's key and its clones.
- Before pushing, the host compares the push-relevant git config (remotes, URL rewrites, credential
  helpers, `http.*`, includes, hooks path) with what it was before the session. If anything changed,
  it refuses to push and fails the run.
- Orca's terminal gives Claude Orca's environment. The launch script unsets the credential variables
  and Orca's plugin dirs; the sandbox (ADR 0270) is what confines it.

## Connecting: `sf-runner login` (ADR 0056)
From a checkout of software-factory with `pnpm install` done, on Node ≥ 24:
```sh
local/runner-host/bin/sf-runner login            # --name m5, --no-install, --no-open, --url <engine>
```
It prints a code and a link (and opens it on macOS). Open the link, check the code matches, name the
runner and approve. The CLI then receives its key (once), proves it with a signed heartbeat, saves
`~/.config/software-factory/runner.json` (0600) and installs the launchd service. Nothing is copied.

## Pairing with a key (fallback)
1. In the app (Setup → "Can't use a login code? Pair with a key instead"), register a runner. This calls `runner.register` and shows the runner id and key **once**.
2. On this machine, from a checkout of software-factory with `pnpm install` done: press **1. Copy
   command** in Setup and paste it here (don't run it yet), press **2. Copy key**, then press Enter:
   ```sh
   pbpaste | local/runner-host/bin/sf-runner pair --runner-id r_… --key-stdin
   ```
   stdin takes the bare key or the two-line `runner id: …` / `key: …` block. If the block's runner id
   isn't `--runner-id`, `pair` says so instead of failing with `401 bad signature`.
   `pair` sends one signed heartbeat to prove the id and key. It then writes
   `~/.config/software-factory/runner.json` (mode 0600; `--url` for another engine, `--max` for
   heavy slots, build and verify, default 2; `--max-light` for light slots, triage and planning
   sessions, default 6: ADR 0301) and restarts the service if one is installed. Pass the key on stdin, not as an
   argument, so it stays out of your shell history.
3. Check it with `sf-runner doctor`, which looks at node ≥ 24, git, orca, claude, Orca being reachable,
   the channel, and Orca's repos: a project (canonical remote) with more than one source repo, and
   `sf-job:` worktrees with no live job. `sf-runner doctor --fix` removes the orphaned worktrees and
   retires a clone the runner registered next to your own checkout (ADR 0260). It never touches your
   own checkouts: two of yours for one remote are reported, not fixed. While a service is running that
   doesn't report its jobs (one from before this change), it treats every job worktree as live.
   It also checks each running job's Claude against its launch record (permission mode, setting
   sources, settings hash) and reports `harness-config-mismatch` (ADR 0270).

The e2e driver below calls `runner.register` through `EngineApi` against a local engine.

## Running as a launchd service (macOS)
It's a per-user LaunchAgent, because Orca and Claude Code run in your GUI session:
```sh
local/runner-host/bin/sf-runner install     # ~/Library/LaunchAgents/com.software-factory.runner.plist
local/runner-host/bin/sf-runner status      # config (key redacted), service, jobs, version and update state
tail -f ~/Library/Logs/software-factory/runner.log
local/runner-host/bin/sf-runner uninstall
```
- **Install from a checkout you keep**, not a job worktree: launchd runs
  `/bin/sh bin/sf-runner-service` from it, and that checkout is what self-update moves (below).
  Keep it on `main` (or detached) with no local changes, e.g. `~/software-factory-runner`.
- `install` refuses to run on Node < 24 and says how to fix it (`nvm use 24`, or
  `SF_RUNNER_NODE=/abs/path/to/node24 local/runner-host/bin/sf-runner install`). The plist pins
  that absolute Node (`SF_RUNNER_NODE`).
- The service gets the `PATH` of the shell you install from (so it finds `pnpm`, `orca`, `claude`
  and `git`), with the pinned Node's directory first, and nothing else from that shell. If `orca`
  isn't on that `PATH` (an SSH session), `install` adds Orca's bin directory: `orcaBin`'s from the
  config, else `/Applications/Orca.app/Contents/Resources/bin` (incident #9).
- `install` replaces a running service (`bootout`, then `bootstrap`, retried up to 5 times when
  launchd is still tearing the old one down). That cancels running jobs, so run it when `status`
  shows none. You only need it once per machine: after that the runner updates itself.
- It restarts after a crash, and after a self-update (exit 75). An unpaired runner exits cleanly,
  and launchd leaves it stopped until `pair`.
- On start it reaps orphaned job worktrees, then retires any clone it registered earlier next to your
  own Orca repo for the same remote (ADR 0260), before claiming work. It records the jobs it is
  running in `~/.local/state/software-factory/runner/live-jobs.json`.

## Updating itself (spec 08, ADR 0360)
The engine answers each heartbeat with `desiredVersion`: the commit it was deployed from, which
passed CI, `factory/verify` and the merge gate. The runner reports its own commit and update state
on each heartbeat, and when it is behind:
1. **It checks it can.** Otherwise it reports `blocked` with the reason and carries on claiming on
   its current code. Blocked when:
   - `autoUpdate` is `false` in `runner.json`;
   - the checkout has local changes (anything in `git status --porcelain`, untracked files too);
   - it is on a branch other than `main` (detached is fine);
   - the desired commit isn't on `origin/main` (it fetches `origin main` to find out);
   - the move isn't a fast-forward (it would go backwards, or the checkout has its own commits);
   - it isn't the launchd service (`sf-runner run` in a terminal reports, but never updates);
   - the update to that commit already failed (retried after an hour) or was rolled back (never
     retried).
2. **It waits** (`waiting`): no new claims; the jobs it holds finish. None is cancelled.
3. **Once idle it updates** (`updating`): it writes the update record, moves the checkout to
   exactly that commit (`git merge --ff-only`, or `checkout --detach` if detached), runs
   `pnpm install --frozen-lockfile` and exits 75, and launchd starts the new code. If the move or
   the install fails it moves back, reports `blocked` and carries on.
4. **The new code's first successful heartbeat confirms it** (`current`).

**Rollback.** launchd runs `bin/sf-runner-service`, a small `sh` wrapper, which counts the starts
of an unconfirmed update. On the fourth (three starts without a heartbeat) it resets the checkout
to the previous commit, reinstalls and starts that; the runner then reports `rolled_back` and never
tries that commit again. The next deploy is taken as usual.

The record is a few one-line files in `~/.local/state/software-factory/runner/update/` (`status`:
`pending`, `confirmed`, `failed`, `rolled_back`; `from`, `to`, `mode`, `starts`, `at`, `reason`),
and rolled-back commits are listed in `update-rolled-back`. The plist passes the state directory as
`SF_RUNNER_STATE_DIR` so the wrapper and Node agree on it.

**Turn it off** with `"autoUpdate": false` in `runner.json` (then restart the service:
`launchctl kickstart -k gui/$(id -u)/com.software-factory.runner`). The runner keeps reporting its
version, as `blocked: auto-update is off`.

**Moving an existing runner onto the wrapper** (once): with no jobs running, from the runner's
checkout on Node 24:
```sh
git pull --ff-only && pnpm install --frozen-lockfile && local/runner-host/bin/sf-runner install
```
Over SSH this works too: `install` adds Orca's bin directory and retries the bootstrap.

**Reading `sf-runner status`:**
```
version: 1a2b3c4d5e6f (auto-update on)
desired: 9f8e7d6c5b4a
update: waiting (waiting for running jobs to finish)
```
`version` is the checkout's commit, `desired` what the engine runs, and `update` the state with its
reason (`current`, `waiting`, `blocked`, `updating`, `rolled_back`), as of the last heartbeat. A
pending update also shows how many starts it has had without a confirmation.

Node runs the TypeScript directly with `--experimental-transform-types`. Strip-only mode isn't
enough: `runner-contract` uses parameter properties. `bin/sf-runner` and `bin/sf-runner-service` pass the flag.

## Configuration (`runner.json`)
| Key | Default | |
|---|---|---|
| `baseUrl` | `https://sf-engine.zerobsai.com` | The engine |
| `runnerId`, `key` | from `pair` | |
| `maxConcurrent` | 2 | Heavy jobs at once: build and verify (each an Orca worktree + a Claude session) |
| `maxLight` | 6 | Light jobs at once: triage, spec and planning sessions (ADR 0301). An idle planning session holds one |
| `heartbeatMs` | 20000 | |
| `permissionMode` | `dontAsk` for every stage | e.g. `{ "build": "auto" }` to use Claude's auto mode for builds |
| `capabilities` | Orca's: `browser`, `ui-takeover`, `auto-register`, `hooks`, `own-hardware` | |
| `identity` | `Software Factory <software-factory@users.noreply.github.com>` | Commit author |
| `autoUpdate` | `true` | Update the runner's checkout to the deployed commit when idle (ADR 0360); `false` reports `blocked` instead |
| `repoUrlMap` | — | Test only: clone and push a local bare repo in place of GitHub |

## End-to-end test (local engine)
`e2e/` runs the real engine (`apps/engine/src`) under `wrangler dev` with its in-D1 fake GitHub, next
to a test-only driver Worker. The driver does three things:
- seeds a user, org, project, policy and runner;
- invokes operations through `EngineApi`;
- mirrors each real push into the fake GitHub, so the engine's hand-back and fast-forward checks run unchanged.

A bare repo on disk stands in for GitHub's git side. The test files one small work item and lets the
runner triage, build and verify it with real Claude sessions in Orca. It stops at the merge gate,
cancels the item, and checks that nothing is left behind.
```sh
cd local/runner-host/e2e
W=../../../apps/engine/node_modules/.bin/wrangler
$W d1 migrations apply software-factory --local -c engine.wrangler.jsonc --persist-to .wrangler-state
$W dev -c driver/wrangler.jsonc -c engine.wrangler.jsonc --persist-to .wrangler-state --ip 127.0.0.1 --port 8977 &
cd .. && node --experimental-transform-types --no-warnings e2e/e2e.ts --driver http://127.0.0.1:8977
```

## Layout
| Path | What |
|---|---|
| `src/host.ts` | The daemon loop: heartbeat, commands, claims, concurrency, stop |
| `src/job.ts` | One job's lifecycle, fencing, the result file, push, hand-back, release |
| `src/git.ts` | The host's clone, the token-only credential helper, the run-branch push, the config check, the diff, token revocation |
| `src/runner.ts` | Wires config → channel client + git + runner-orca (the only file naming an adapter) |
| `src/config.ts`, `src/cli.ts`, `src/launchd.ts` | `sf-runner pair/run/status/doctor/install/uninstall` |
| `test/` | The lifecycle against a fake cloud serving the real signed protocol and a local bare repo |
| `e2e/` | The end-to-end test above |
