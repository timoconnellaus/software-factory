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
2. It clones or fetches the repo into its own clone (`~/.local/state/software-factory/runner/repos/<owner>/<name>`),
   using the token. The clone's push URL is disabled and it has no credential helper.
3. runner-orca makes an Orca worktree on the run branch `factory/<n>-<slug>-run-<k>` and projects
   `harness-claude`'s per-run settings into it. Claude Code then starts in an Orca terminal (you can
   take it over there).
4. It streams events (state, agent status, tools, terminal output) with the fencing token.
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
- The harness's settings (`.claude/settings.local.json`) do four things:
  - blank or redirect every credential variable (`GH_TOKEN`, `SSH_AUTH_SOCK`, AWS, Cloudflare, …);
  - point `GIT_CONFIG_GLOBAL` at a per-run config with no credential helper, and set `GIT_CONFIG_NOSYSTEM` (on macOS that turns off the keychain helper);
  - deny `git push`, `gh`, `ssh`, `wrangler`, cloud CLIs, `orca`, `security` and similar;
  - deny reads of `~/.ssh`, `~/.config/gh`, this runner's key and its clones.
- Before pushing, the host compares the push-relevant git config (remotes, URL rewrites, credential
  helpers, `http.*`, includes, hooks path) with what it was before the session. If anything changed,
  it refuses to push and fails the run.
- Orca starts Claude with Orca's own environment, so the settings file is defence in depth, not an
  OS sandbox. See the open questions in ADR 0250.

## Pairing (`runner register` → engine)
1. In the app, add a runner. This calls `runner.register` and shows the runner id and key **once**.
2. On this machine, from a checkout of software-factory with `pnpm install` done, run:
   ```sh
   pbpaste | local/runner-host/bin/sf-runner pair --runner-id r_… --key-stdin
   ```
   `pair` sends one signed heartbeat to prove the id and key. It then writes
   `~/.config/software-factory/runner.json` (mode 0600; `--url` for another engine, `--max` for
   concurrency) and restarts the service if one is installed. Pass the key on stdin, not as an
   argument, so it stays out of your shell history.
3. Check it with `sf-runner doctor`, which looks at node ≥ 24, git, orca, claude, Orca being reachable, and the channel.

Until the app's setup screen exists, `runner.register` can only be called through `EngineApi` (the
e2e driver below does this against a local engine).

## Running as a launchd service (macOS)
It's a per-user LaunchAgent, because Orca and Claude Code run in your GUI session:
```sh
local/runner-host/bin/sf-runner install     # ~/Library/LaunchAgents/com.software-factory.runner.plist
local/runner-host/bin/sf-runner status      # config (key redacted) + service state
tail -f ~/Library/Logs/software-factory/runner.log
local/runner-host/bin/sf-runner uninstall
```
- **Install from a checkout you keep**, not a job worktree: the plist runs `src/cli.ts` from it.
- The service gets the `PATH` of the shell you install from (so it finds `node` 24, `orca`, `claude`
  and `git`) and nothing else from that shell.
- It restarts after a crash. An unpaired runner exits cleanly, and launchd leaves it stopped until `pair`.

Node runs the TypeScript directly with `--experimental-transform-types`. Strip-only mode isn't
enough: `runner-contract` uses parameter properties. `bin/sf-runner` and the plist pass the flag.

## Configuration (`runner.json`)
| Key | Default | |
|---|---|---|
| `baseUrl` | `https://sf-engine.zerobsai.com` | The engine |
| `runnerId`, `key` | from `pair` | |
| `maxConcurrent` | 2 | Jobs at once (each is an Orca worktree + a Claude session) |
| `heartbeatMs` | 20000 | |
| `permissionMode` | `dontAsk` for every stage | e.g. `{ "build": "auto" }` to use Claude's auto mode for builds |
| `capabilities` | Orca's: `browser`, `ui-takeover`, `auto-register`, `hooks`, `own-hardware` | |
| `identity` | `Software Factory <software-factory@users.noreply.github.com>` | Commit author |
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
