# @software-factory/cli (`sf`)

The factory from a terminal: log in, list the operations, and call any operation your token's
scope allows (the new core's `flow.*` operations included). Spec
[07](../../docs/specs/07-cli.md), [ADR 0340](../../docs/adr/0340-a-cli-for-people-gates-stay-in-the-browser.md).

**Decisions stay in the app.** Browser-only operations (approving a login, for one) are refused
from the CLI, whatever the token.

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
sf login --write    # ask for write
sf status           # engine, app, login, scope, expiry (never the token)
sf logout           # revoke the token on the factory, then delete it here
```
`sf login` prints a code and a link, and opens the link on macOS (`--no-open` to skip). Check the
code matches, choose the scope and approve. **Your choice in the app wins** over what the CLI
asked for, and `sf login` says which scope you got. The token lasts 30 days. It's saved in
`~/.config/software-factory/cli.json` (or under `$XDG_CONFIG_HOME`), mode 0600 in a 0700
directory. `--url <engine>` and `--app-url <app>` point at another factory and are remembered.
`sf call cliToken.list` lists your tokens, and `sf call cliToken.revoke '{"tokenId":"…"}'`
revokes one.

### Agent sessions
Give an agent session a **read** token, never your write login. Either run `sf login` (read is
the default) in an account the agent uses, or hand it a token in the environment:
```sh
SF_TOKEN=sfc_… sf call org.list
```
`SF_TOKEN` overrides the stored token.

## Commands
| Command | |
|---|---|
| `sf login`, `sf logout`, `sf status` | See above |
| `sf ops` | Every operation, its risk, and which are browser-only |
| `sf call <op> [json \| @file \| -]` | Call any operation; prints its result as JSON |

`status` and `ops` take `--json`.

## Errors
Errors print as `code: message` and exit 1 (2 for a usage mistake).
- `unauthenticated`: the token is missing, expired, revoked or unknown. Run `sf login`.
- `forbidden` for a browser-only operation: `sf` says to do it in the app.
- `forbidden` for a write with a read token: `sf login --write`.

## Environment
| Variable | |
|---|---|
| `SF_TOKEN` | A token; overrides the stored one |
| `SF_URL` | The engine (default `https://sf-engine.zerobsai.com`) |
| `SF_APP_URL` | The app, for the login link (default `https://software-factory.zerobsai.com`) |
| `XDG_CONFIG_HOME` | Where `software-factory/cli.json` lives (default `~/.config`) |
| `SF_NODE` | The Node 24 binary `bin/sf` runs |

## Layout
| Path | What |
|---|---|
| `src/main.ts` | The commands, and the hints on refused calls |
| `src/api.ts` | The `/cli/v1` client |
| `src/device-login.ts` | `sf login`'s device flow |
| `src/config.ts` | `cli.json` and the environment overrides |
| `test/` | Everything against a fake engine (vitest, Node) |
