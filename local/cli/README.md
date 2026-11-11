# @software-factory/cli (`sf`)

The factory from a terminal: the inbox, a work item's state and timeline, the merge queue, new
work, attaching a PR, cancelling, and any operation your token's scope allows. Spec
[07](../../docs/specs/07-cli.md), [ADR 0340](../../docs/adr/0340-a-cli-for-people-gates-stay-in-the-browser.md).

**Gate decisions stay in the browser.** Approving a spec or a merge, answering questions,
approving a login and turning a kill switch off are refused from the CLI, whatever the token.
`sf open <n>` takes you to the page where you make them.

It's a thin client of `sf-engine`'s `/cli/v1`. The engine decides everything: who you are, what
the token's scope allows, the browser-only rule, and the audit.

## Install
From a checkout of software-factory with `pnpm install` done, on Node ≥ 24. No build step:
`bin/sf` runs the TypeScript directly with `--experimental-transform-types`.
```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/local/cli/bin/sf" ~/.local/bin/sf     # with ~/.local/bin on your PATH
sf --help
```
Keep the link pointing at a checkout you keep, not a job worktree. If `node` on your PATH isn't
24, set `SF_NODE=/abs/path/to/node24`.

## Log in
```sh
sf login            # a read token (the default; right for agent sessions)
sf login --write    # ask for write: also create, attach and cancel work
sf status           # engine, app, login, scope, expiry (never the token)
sf logout           # revoke the token on the factory, then delete it here
```
`sf login` prints a code and a link, and opens the link on macOS (`--no-open` to skip). Check the
code matches, choose the scope and approve. **Your choice in the app wins** over what the CLI
asked for, and `sf login` says which scope you got. The token lasts 30 days. It's saved in
`~/.config/software-factory/cli.json` (or under `$XDG_CONFIG_HOME`), mode 0600 in a 0700
directory. `--url <engine>` and `--app-url <app>` point at another factory and are remembered.
`sf tokens` lists your tokens, and `sf tokens revoke <id>` revokes one.

### Agent sessions
Give an agent session a **read** token, never your write login. Either run `sf login` (read is
the default) in an account the agent uses, or hand it a token in the environment:
```sh
SF_TOKEN=sfc_… sf show 12
```
`SF_TOKEN` overrides the stored token. Even a write token can't decide a gate, so an agent can't
approve its own work.

## Commands
| Command | |
|---|---|
| `sf inbox` | Gates and questions waiting on you (with app links), running items, your runners |
| `sf ls [--project p] [--all] [--limit n]` | Work items, newest first; live ones unless `--all` |
| `sf show <n>` | Stage, status and reason, kind, PR, merge queue place, open gates with links, runs, the review packet's verdict |
| `sf timeline <n>` | The event log, oldest first, in the dashboard's words: time, what happened, who, and the detail, outcome and reason |
| `sf queue [--project p]` | The merge queue, head first (every project's without `--project`) |
| `sf new "<title>" [--body t \| --body-file f\|-] [--project p]` | File work (source `cli`) |
| `sf attach <pr> [--project p]` | Attach a PR opened outside the factory |
| `sf cancel <n> --reason <text>` | Cancel a work item |
| `sf open <n> [--review]` | Print the item's page (or its review packet) and open it on macOS |
| `sf ops` | Every operation, its risk, and which are browser-only |
| `sf call <op> [json \| @file \| -]` | Call any operation; prints its result as JSON |

Data commands take `--json` for the operation's raw output.

**`<n>`** is a work item's number in its project (`12` or `#12`), or its `wi_…` id. Numbers are per
project, so `--project <name|slug|id>` names it. Without `--project`, your only project is used;
with several, `sf` lists them and asks.

**Your org** is inferred from what's running in your inbox. No operation lists your orgs yet, so
when nothing of yours is running, pass `--org <orgId>` or set `SF_ORG` (or use `--project prj_…`).

## Errors
Errors print as `code: message` and exit 1 (2 for a usage mistake).
- `unauthenticated`: the token is missing, expired, revoked or unknown. Run `sf login`.
- `forbidden` for a browser-only operation: `sf` prints the app page to do it on.
- `forbidden` for a write with a read token: `sf login --write`.

## Environment
| Variable | |
|---|---|
| `SF_TOKEN` | A token; overrides the stored one |
| `SF_URL` | The engine (default `https://sf-engine.zerobsai.com`) |
| `SF_APP_URL` | The app, for links (default `https://software-factory.zerobsai.com`) |
| `SF_ORG` | Your org, when it can't be inferred |
| `XDG_CONFIG_HOME` | Where `software-factory/cli.json` lives (default `~/.config`) |
| `SF_NODE` | The Node 24 binary `bin/sf` runs |

## Layout
| Path | What |
|---|---|
| `src/main.ts` | The commands, and the hints on refused calls |
| `src/api.ts` | The `/cli/v1` client |
| `src/device-login.ts` | `sf login`'s device flow |
| `src/config.ts` | `cli.json` and the environment overrides |
| `src/resolve.ts` | Project names and work item numbers to ids |
| `test/` | Everything against a fake engine (vitest, Node) |
