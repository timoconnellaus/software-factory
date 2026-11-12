# Spec 32: Claude accounts on a host, with manual switching

Read first: the plan ([`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)),
ADRs [0410](../adr/0410-claude-accounts-live-on-the-host.md), [0023](../adr/0023-runners-owned-by-users.md),
[0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md) and
[0380](../adr/0380-runner-local-tmux-and-hook-status.md); spec [30](30-runner-local-without-orca.md)
(what piece 1 built); `local/runner-host`, `packages/runner-local`, `packages/harness-claude`.

This is piece 3 of 8 in the plan. Piece 2 (watching and steering from the dashboard) is built
alongside it; the later pieces get their own specs.

## Goal
A host holds several Claude accounts and the owner picks which one new jobs use, on the host or
from the dashboard. Credentials never leave the host: the factory sees account names only.

## Scope
- **Accounts on the host** (`local/runner-host`, `accounts.ts`). Two kinds:
  - **login**: a Claude Code login in its own config dir,
    `~/.local/share/software-factory/accounts/<name>/`, used as `CLAUDE_CONFIG_DIR`.
    `sf-runner account add <name>` creates the dir (0700) and runs `claude` there so the owner logs
    in (`--no-login` skips that).
  - **token**: a `claude setup-token` OAuth token or an Anthropic API key, read from stdin by
    `sf-runner account add <name> --token-stdin` and kept in
    `~/.config/software-factory/accounts/<name>.token` (0600). The kind is detected from the prefix
    (`sk-ant-oat…` → `CLAUDE_CODE_OAUTH_TOKEN`, `sk-ant-api…` → `ANTHROPIC_API_KEY`), or set with
    `--oauth` / `--api-key`. It also gets its own config dir, seeded so Claude skips first-run
    onboarding (and, for an API key, its "use this key?" prompt, which Claude records by the key's
    last 20 characters).
  - **default** always exists and can't be removed: whatever `claude` uses with no account set.
    The launch is exactly as before, so a host with no accounts works with zero setup.
  - The registry is `~/.config/software-factory/accounts.json` (0600): the active account's name
    and each account's kind. It holds no secret.
  - `sf-runner account list | add | remove | use`. `remove` refuses the active account and an
    account a running job uses. `status` shows the active account.
  - Names: lower-case letters, digits and `-`, up to 32 characters.
- **Switching is manual.** The active account applies to jobs prepared after the switch. Running
  jobs keep theirs. Two ways to switch:
  - `sf-runner account use <name>` on the host;
  - a picker in the runner's row on Setup ("Your runners"), owner only. It calls the operation
    `runner.account.use { runnerId, name }` (human, signed-in, owner-only, journalled with the
    before and after names). The engine keeps the request on the runner and sends
    `{ kind: "account.use", name }` on each heartbeat response until the host reports that account
    active, or reports accounts without it (the request is dropped).
- **Heartbeat** (`runner-contract`): optional `accounts: { names, active, limits }`. `limits` lists
  accounts whose last run hit a usage limit (name, when, the message). Never a credential. Older
  hosts omit it, and the operation refuses a runner that hasn't reported accounts. Older hosts
  ignore the new command.
- **Engine** (migration 0180): `core_runners.accounts` (the last report, JSON),
  `account_requested`, `account_requested_at`. `runner.list` returns
  `accounts: { names, active, requested, limits } | null`.
- **Harness** (`harness-claude`):
  - `projectHarness` takes the run's account (`HarnessAccount`). The launch script, before `exec`:
    unsets every model credential variable (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
    `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`), then exports `CLAUDE_CONFIG_DIR` and, for a
    token account, the one token variable read from the token file (the script never holds the
    secret). The default account leaves the environment as it was. (Claude Code's
    `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is not used: it forces the permission mode to `default`,
    which would break ADR 0270.)
  - The rest of the credential-free environment is unchanged. The token file is under the runner's
    config dir, which every run already denies, and the harness also denies it by name, along with
    the account's `.credentials.json` (where a login keeps its credentials when there's no
    Keychain). The account's config dir itself stays readable, as `~/.claude` always was: Claude's
    sandboxed shell reads its snapshots from there.
  - The launch record names the account (`account`, `configDir`), never the token. The ADR 0270
    check (argv and settings hashes) is unchanged.
  - The transcript finder reads the run's account config dir (default: `CLAUDE_CONFIG_DIR` or
    `~/.claude`). The Orca profile homes are gone.
  - The status hook also records a failure's error type (`StopFailure`'s `error`).
- **runner-local**: asks the host for the active account when it prepares a workspace and keeps it
  for the whole job. A planning session resumed on another account gets its conversation file
  copied into the active account's config dir first, so `claude --resume` finds it.
- **Usage limits (surfaced, never acted on):** a `StopFailure` with `rate_limit`, or a final
  message that says the usage limit was reached, reports an `agent.status` error naming the
  account. The host records it against the account and reports it on the heartbeat; Setup shows it
  next to the picker. A later run that ends cleanly on that account clears it. Nothing rotates
  accounts on its own.

## Out of scope
- Automatic rotation or failover between accounts.
- Adding or removing accounts from the dashboard (host only), and any way to send a credential to
  the factory.
- Dashboard live view and steering (piece 2), containers (piece 4), Linux (piece 5), the web
  terminal (piece 6), Sprites (piece 7), the chat UI (piece 8).
- Per-project or per-stage account choice.

## Acceptance criteria
1. A host with no accounts runs jobs exactly as before: the launch script sets no account variable
   and `sf-runner account list` shows `default` active.
2. `sf-runner account add work` makes `~/.local/share/software-factory/accounts/work/` (0700) and runs
   `claude` with `CLAUDE_CONFIG_DIR` set to it. `sf-runner account add ci --token-stdin` stores the
   token 0600, outside any config dir, and nothing else on disk or on the wire carries it (bar
   Claude's own approval record of an API key's last 20 characters).
3. After `sf-runner account use work`, the next job's launch script exports
   `CLAUDE_CONFIG_DIR=<accounts>/work` and unsets the other model credentials. A job already running
   keeps its account. A token account's launch reads the token from its file into the one variable,
   and the token is in no file the harness writes.
4. The launched Claude still passes the ADR 0270 check, and a mismatch still fails the job with
   `harness-config-mismatch`.
5. The heartbeat reports account names and the active one, never a credential (a test checks the
   wire body for the token).
6. The owner switches the active account from Setup: `runner.account.use` is refused for someone
   else's runner, an unknown name, or a runner that hasn't reported accounts; it is journalled; the
   next heartbeat carries `account.use`; the host makes it active; the request clears once the host
   reports it.
7. The transcript finder reads the run's account config dir; no Orca profile path is left.
8. A run that hits a usage limit shows it on the run and next to that account in Setup; the owner
   switches by hand.
9. Device login, pairing, self-update and `sf-runner install` work as before. `pnpm lint`,
   `pnpm typecheck` and `pnpm test` pass.
