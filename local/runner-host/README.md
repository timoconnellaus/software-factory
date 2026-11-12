# @software-factory/runner-host

The runner host daemon (`sf-runner`). It runs on a person's machine, connects **outbound** to the
factory over the signed channel (`https://sf-engine.zerobsai.com/runner/v1/*`, ADR 0016), and drives a
runner adapter. It wires `runner-local` (git worktrees + tmux, no desktop app) with the
`harness-claude` harness. Decisions:
[ADR 0250](../../docs/adr/0250-runner-host-pushes-and-harness-projection.md),
[ADR 0350](../../docs/adr/0350-runner-local-tmux-and-hook-status.md).

## What it does
Every ~20 s it heartbeats: the manifest, capacity, and the jobs it holds with their fencing tokens.
The heartbeat renews each lease (10 min), and cancel/drain commands come back on the response.
While it has room it claims jobs; a retried claim reuses its `claimId`. For each job (`src/job.ts`):

1. It fetches a **job token** (`run.issueToken`): a GitHub App installation token for the one repo.
2. It fetches the item branch into the checkout this machine already has for the repo: the git repo
   directly under one of the `checkouts` dirs in `runner.json` whose `origin` is the job's repo
   (canonical remote identity, ADR 0260). It fetches by URL, into
   `refs/software-factory/heads/<branch>`, with the token only in that git process's environment, and
   never changes that checkout's config, remotes, branches or working tree. Only when no checkout
   matches does it clone, once, into `~/.local/state/software-factory/runner/repos/<owner>/<name>`
   (push URL disabled, no credential helper), and keeps it.
3. runner-local adds a git worktree of that checkout at
   `~/.local/state/software-factory/runner/worktrees/sf-<jobId>` on the run branch
   `factory/<n>-<slug>-run-<k>` (hooks off, no upstream written) and projects `harness-claude`'s
   per-run settings into it. Claude Code then starts in the tmux session `sf-<jobId>` on the
   factory's own tmux server (`tmux -L software-factory`, never your default one or your
   `~/.tmux.conf`), with the harness's own flags, and is checked before it gets the prompt
   (ADR 0270). The prompt goes in `.factory-prompt.md`; the terminal gets one line pointing at it.
   **Take a run over** with the hint the run shows:
   `tmux -L software-factory attach -t sf-<jobId>` (detach with `C-b d`; the job still ends and
   hands back normally).
   **Build only:** before the session the host fetches the job's `repo.defaultBranch` too and
   merges it into the run branch (a merge commit, never a rebase, ADR 0320). A conflict is left in
   progress for the session to resolve; unmerged paths at the end fail the run with no push.
4. It streams events (state, agent status, tools, terminal output) with the fencing token. Agent
   status comes from the harness's status hook (`<runDir>/status.jsonl`), not the screen: a tool
   call is a `tool` event, a permission or idle notification is `waiting_input` (15 min, then the
   run fails), and `Stop` after the prompt ends the session.
5. When the session ends it reads `.factory-result.json`, passes it through untouched, and deletes it.
6. **Build only:** it commits any leftovers, then pushes `HEAD` to the run branch, and only there,
   with a *fresh* job token. It never forces.
7. It uploads artifacts: the diff, the terminal screen, check output from Claude's transcript, and a summary.
8. It hands back `{ branch, headSha, result }`, releases the workspace, revokes the tokens and calls `release`.

A `409 fenced|killed`, or a cancel command, stops the session at once: no push and no hand-back.

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
  - deny `git push`, `gh`, `ssh`, `wrangler`, cloud CLIs, `tmux`, `orca`, `security` and similar;
  - deny reads of `~/.ssh`, `~/.config/gh`, this runner's key and its clones.
- Before pushing, the host compares the push-relevant git config (remotes, URL rewrites, credential
  helpers, `http.*`, includes, hooks path) with what it was before the session. If anything changed,
  it refuses to push and fails the run.
- The tmux session inherits the runner host's environment (under launchd: `PATH` and `HOME`). The
  launch script unsets the credential variables and `CLAUDE_CODE_PLUGIN_DIRS`; the sandbox
  (ADR 0270) is what confines it. The status hook runs outside the sandbox, as every hook does: it
  only appends to the run's status file and always answers `{}`.

## Connecting: `sf-runner login` (ADR 0056)
From a checkout of software-factory with `pnpm install` done, on Node ≥ 24:
```sh
local/runner-host/bin/sf-runner login            # --name m5, --no-install, --no-open, --url <engine>
```
It prints a code and a link (and opens it on macOS). Open the link, check the code matches, name the
runner and approve. The CLI then receives its key (once), proves it with a signed heartbeat, saves
`~/.config/software-factory/runner.json` (0600) and installs the launchd service. Nothing is copied.
If `checkouts` isn't set yet, `login` sets it once: the parent directories of the repos the Orca
desktop app knows, when it is installed, else `[]` (edit it to list where you keep your clones).

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
   concurrency) and restarts the service if one is installed. Pass the key on stdin, not as an
   argument, so it stays out of your shell history.
3. Check it with `sf-runner doctor`, which looks at node ≥ 24, git, tmux ≥ 3.2, claude, the channel,
   and the checkouts: `checkouts` set and present, one checkout per remote under them, and no
   `sf-*` job worktree or tmux session without a live job. `sf-runner doctor --fix` sets `checkouts`
   once if it is unset (as `login` does) and kills and removes the orphans. It never touches your
   own checkouts: two of yours for one remote are reported, not fixed. While a service is running that
   doesn't report its jobs (one from before this change), it treats every job as live.
   It also checks each running job's Claude against its launch record (permission mode, setting
   sources, settings hash) and reports `harness-config-mismatch` (ADR 0270).
   Job worktrees an older runner made in Orca (`sf-job:` comments) aren't this runner's to reap:
   remove them in Orca.

The e2e driver below calls `runner.register` through `EngineApi` against a local engine.

## Running as a launchd service (macOS)
It's a per-user LaunchAgent, because Claude Code runs as you, with your Claude login:
```sh
local/runner-host/bin/sf-runner install     # ~/Library/LaunchAgents/com.software-factory.runner.plist
local/runner-host/bin/sf-runner status      # config (key redacted), service state, jobs running
tail -f ~/Library/Logs/software-factory/runner.log
local/runner-host/bin/sf-runner uninstall
```
- **Install from a checkout you keep**, not a job worktree: the plist runs `src/cli.ts` from it.
- `install` refuses to run on Node < 24 and says how to fix it (`nvm use 24`, or
  `SF_RUNNER_NODE=/abs/path/to/node24 local/runner-host/bin/sf-runner install`). The plist pins
  that absolute Node.
- The service gets the `PATH` of the shell you install from (so it finds `tmux`, `claude` and `git`),
  with the pinned Node's directory first and tmux's directory added if it wasn't there (Homebrew's
  `/opt/homebrew/bin`, say), and nothing else from that shell.
- It restarts after a crash. An unpaired runner exits cleanly, and launchd leaves it stopped until `pair`.
- `install` restarts the service, which cancels running jobs. To upgrade, wait until `status` shows no
  jobs running and no job sessions in tmux, then pull and `install`.
- On start it reaps orphans (`sf-*` tmux sessions on its socket and `sf-*` worktrees it isn't
  running) before claiming work. It records the jobs it is running in
  `~/.local/state/software-factory/runner/live-jobs.json`.

Node runs the TypeScript directly with `--experimental-transform-types`. Strip-only mode isn't
enough: `runner-contract` uses parameter properties. `bin/sf-runner` and the plist pass the flag.

## Configuration (`runner.json`)
| Key | Default | |
|---|---|---|
| `baseUrl` | `https://sf-engine.zerobsai.com` | The engine |
| `runnerId`, `key` | from `pair` | |
| `maxConcurrent` | 2 | Jobs at once (each is a git worktree + a Claude session in tmux) |
| `heartbeatMs` | 20000 | |
| `checkouts` | set once by `login` / `doctor --fix` | Directories whose immediate git repos are your checkouts, e.g. `["~/code", "~/orca/projects"]`. A job runs as a worktree of the one whose `origin` is its repo; none → the runner's own clone |
| `capabilities` | `hooks`, `ui-takeover`, `own-hardware`, `work-item-attachments` | No `browser`: screenshot evidence is skipped |
| `identity` | `Software Factory <software-factory@users.noreply.github.com>` | Commit author |
| `repoUrlMap` | — | Test only: clone and push a local bare repo in place of GitHub |

## End-to-end test (local engine)
`e2e/` runs the real engine (`apps/engine/src`) under `wrangler dev` with its in-D1 fake GitHub, next
to a test-only driver Worker. The driver does three things:
- seeds a user, org, project, policy and runner;
- invokes operations through `EngineApi`;
- mirrors each real push into the fake GitHub, so the engine's hand-back and fast-forward checks run unchanged.

A bare repo on disk stands in for GitHub's git side. The test files one small work item and lets the
runner triage, build and verify it with real Claude sessions in tmux. It stops at the merge gate,
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
| `src/runner.ts` | Wires config → channel client + git + runner-local (the only file naming an adapter) |
| `src/checkouts.ts` | The `checkouts` dirs: `~` expansion and the one-time default |
| `src/config.ts`, `src/cli.ts`, `src/launchd.ts` | `sf-runner pair/run/status/doctor/install/uninstall` |
| `test/` | The lifecycle against a fake cloud serving the real signed protocol and a local bare repo |
| `e2e/` | The end-to-end test above |
