# Fly Sprite per-workspace environment

`orca.yaml` declares an Orca environment recipe, `sprite` ("Fly Sprite"). Picking it under **Run
on** gives the new workspace its own [Fly sprite](https://docs.fly.io/sprites): a fresh Ubuntu VM
running a headless Orca server, which your desktop Orca pairs with over the sprite's public URL.

The composer reads `environmentRecipes` from the primary checkout, so the option shows up only
once `orca.yaml` is on `main`.

## One-time setup (on your Mac)

1. Install the `sprite` CLI and run `sprite login`. If you have more than one Sprites org, set
   `org` in `sprite-state.json` (or `ORCA_SPRITE_ORG`).
2. Log `gh` in (`gh auth login`). Its token goes to each sprite for git and `gh`.
3. Create a long-lived Claude Code token and keep it in the Keychain:

   ```sh
   claude setup-token
   security add-generic-password -s orca-sprite-claude-token -a "$USER" -w   # paste the token at the prompt
   ```

   `CLAUDE_CODE_OAUTH_TOKEN` in the environment overrides the Keychain entry.

Check the wiring with `orca vm recipe doctor sprite --json` (static, free), or run it end to end
with `--provision`, which creates a real sprite, checks the result and destroys it.

## What each step does

| Step | Script | What happens |
| --- | --- | --- |
| create | `sprite-create.sh` | `sprite create orca-<recipe>-<instance>`, sets its URL to public, runs `remote/provision.sh` (the checksum-verified `orca-server-linux-*` release pinned by `orcaServerVersion`, pnpm 10.23.0, `gh` as git's credential helper, a clone of the repo at `projectRoot`), then `remote/start-serve.sh` (`orca-ide serve --port 8080 --pairing-address wss://<sprite-url> --recipe-json`) |
| suspend | `sprite-suspend.sh` | Stops orca serve (`remote/stop-serve.sh`) so nothing keeps the sprite awake; Sprites then pause it and stop billing compute. Files stay, and the terminal daemon keeps running, so terminals survive |
| resume | `sprite-resume.sh` | Restarts orca serve and prints fresh recipe JSON |
| destroy | `sprite-destroy.sh` | `sprite destroy --force`. It works out the name from the instance id when `create` never returned |

Orca then makes a linked worktree from that checkout and runs `scripts.setup` (`pnpm install
--frozen-lockfile`) in it, as it does locally.

`sprite-state.json` holds non-secret wiring only: org, repo URL and ref, project root, port and the
Orca server version. Each value can be overridden by an env var (`ORCA_SPRITE_ORG`,
`ORCA_SPRITE_REPO_URL`, `ORCA_SPRITE_REPO_REF`, `ORCA_SPRITE_PROJECT_ROOT`, `ORCA_SPRITE_PORT`,
`ORCA_SERVER_VERSION`).

## Credentials

- The Claude and GitHub tokens are read on your Mac when the step runs and sent to the sprite on
  stdin. They exist only in the environment of the `orca serve` process, never in a file, an
  argv, the state file or the recipe result. Agents and terminals Orca starts there inherit them.
  `gh auth git-credential` reads `GH_TOKEN` when git needs it.
- That GitHub token is your own `gh` login, so a workspace sprite can do whatever you can on
  GitHub. That's fine for personal dev workspaces. It is not the factory's runner path, which
  takes per-job App tokens (ADR 0010, 0025, 0033).
- The sprite's URL is public because Orca can't send Fly org auth; the one-time pairing code
  gates the Orca server.

## Why not snapshots

The Orca skill's usual pattern builds a base image, signs the agent in and snapshots it, and every
workspace boots from that snapshot. Sprites can't create a new sprite from another sprite's
checkpoint (checkpoints only restore in place), so each workspace sprite is built fresh. The base
image already has Node 24, git, gh and Claude Code, so a create takes about two minutes. The Claude
token replaces the signed-in snapshot.

## Upgrading Orca

`orca-server-linux-*` tarballs are published from Orca 1.4.257. Keep `orcaServerVersion` in step
with your desktop app. New workspaces pick up a change; existing ones keep their version.
