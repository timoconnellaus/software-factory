# ADR 0410: Claude accounts live on the host; the owner switches by name

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
(piece 3). Spec [32](../specs/32-claude-accounts-on-a-host.md). Builds on
[0023](0023-runners-owned-by-users.md), [0270](0270-the-factory-launches-the-harness-and-verifies-it.md)
and [0380](0380-runner-local-tmux-and-hook-status.md).

## Context
With Orca gone (ADR 0380), runs used whatever `claude` used on the host: one login. The owner has
more than one Claude subscription and wants to move work to another when one hits its usage limit.
Orca did this with a config dir per profile. The factory must never hold the credential (ADR 0023),
and the run's environment must stay credential-free apart from the model credential.

## Decision
1. **Accounts are a host thing.** A host holds named accounts under
   `~/.config/software-factory/accounts/`. A **login** account is a Claude Code config dir of its
   own (`CLAUDE_CONFIG_DIR`), logged into by running `claude` there. A **token** account is a
   `claude setup-token` OAuth token or an API key in a 0600 file, plus a config dir of its own.
   `default` is always there and is whatever `claude` uses with no account set. Adding and
   removing accounts happens only on the host (`sf-runner account …`).
2. **Switching is manual and by name.** The host has one active account, and a job takes it when its
   workspace is prepared and keeps it to the end. The owner switches on the host
   (`sf-runner account use`) or from the dashboard. The dashboard calls `runner.account.use`
   (owner only, journalled). The engine delivers `account.use` on the heartbeat until the host
   reports the switch. The heartbeat carries names and the active one, nothing else.
3. **One model credential reaches the run.** The launch script unsets the model credential
   variables, then sets the account's: `CLAUDE_CONFIG_DIR`, and for a token account the one token
   variable, read from the token file at launch, so no file the harness writes holds it. The token
   file and the accounts' config dirs are under the runner's config dir, which every run already
   denies. The default account leaves the environment untouched.
4. **Usage limits are surfaced, not acted on.** A run that hits a usage limit says so on the run, and
   the host reports it against the account. The owner decides whether to switch. There is no
   automatic rotation.

## Consequences
- The factory still holds no credential. It knows only account names, chosen by the owner.
- The ADR 0270 check is unchanged: the account is in the launch record but changes neither the argv
  nor the settings.
- A token account's token is in Claude's environment, so the commands Claude runs can see it: the
  same exposure as an `ANTHROPIC_API_KEY` the host was started with, which the harness has always
  passed through (ADR 0023). Claude Code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` would hide it, but it
  also forces the permission mode to `default`, which breaks ADR 0270, so it stays off. Prefer login
  accounts, whose credential stays in the Keychain.
- A planning session resumed after a switch carries its conversation file into the new account's
  config dir.
- Orca's per-profile config dirs are no longer read anywhere.
- Containers (piece 4) and sandboxes (piece 7) will need the same account, passed into the box. That
  is their specs' problem; this ADR keeps the account on the host that launches Claude.
