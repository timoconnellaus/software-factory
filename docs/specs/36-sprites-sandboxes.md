# Spec 36: Sprites sandboxes

Read first:
- the plan, [`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
  (piece 7, "Joining");
- ADRs [0480](../adr/0480-a-sprite-per-job-provisioned-by-the-owners-host.md),
  [0430](../adr/0430-a-container-per-job.md), [0380](../adr/0380-runner-local-tmux-and-hook-status.md),
  [0400](../adr/0400-watch-and-steer-runs-from-the-dashboard.md),
  [0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md),
  [0410](../adr/0410-claude-accounts-live-on-the-host.md), [0033](../adr/0033-per-job-github-app-tokens.md)
  and [0023](../adr/0023-runners-owned-by-users-and-requester-routing.md);
- spec [33](33-container-per-job.md);
- the code in `packages/runner-local` (`src/container/`) and `local/runner-host`.

This is piece 7 of 8 in the plan. It reuses piece 4's job repo, egress allowlist, token-only
credential and pre-push scan (spec 33), piece 3's Claude accounts (spec 32), piece 2's steering
(spec 31) and piece 6's web terminal (spec 35).

## Goal
On a runner set to Sprites isolation, each job's Claude Code runs in its own fresh sprite on the
owner's Sprites account, made by the owner's runner host. The factory never holds the Sprites token
or the Claude token, and the sprite never holds the job's GitHub token: the host still pushes. The
sprite sees only the job's own repo and run files and reaches only the stage's allowed hosts and the
model API. Steering, `tmux attach` and the web terminal work as on a container job. Capacity is no
longer the host's CPU.

## Scope
- **`runner.json`:**
  - `"isolation": "sandbox" | "container" | "sprites"`;
  - `"sprites"` takes two keys: `apiUrl` (default `https://api.sprites.dev`) and `allowedHosts`
    (more egress hosts for every job on this runner). There is no token key.
- **`sf-runner sprites login | status | logout`.** `login` reads the token from stdin, checks it
  against the API (`--no-check` skips that) and keeps it in
  `~/.config/software-factory/sprites.token` (0600). `status` shows the token (a prefix only), the
  API and this runner's sprites. `logout` removes the file.
- **`packages/runner-local/src/sprites/`**, a separate module like `container/`:
  - **`api.ts`:** `SandboxApi`, the small provider interface, and `spritesApi` over Sprites' HTTP
    and exec WebSocket. Create, get, list by prefix, destroy, set and get the network policy, exec
    without a TTY (stdin in, stdout, stderr and exit code out), and the TTY exec URL.
  - **`scripts.ts`:** the fixed scripts the runner runs in a sprite (`upload`, `write`, `sha256`,
    `pull`, `result`), each taking every path as an argument, plus `sprite/provision.sh` (the
    Dockerfile's toolchain and pinned Claude Code, in `/opt/software-factory/claude-code-<v>`).
  - **`tty-bridge.ts`:** the job's pane on the host, bridged to the sprite's TTY exec. It reads the
    token from its file, sends resizes and reattaches by session id after a drop.
  - **`mirror.ts`:** pulls what was appended to the pid file, `status.jsonl` and the transcripts
    under the job's home into the same host paths.
  - **`result.ts`:** the result script's snapshot commit and bundle, and the host-side import (fetch
    with the host's safe git, branch on the agent's HEAD, working tree on the snapshot, index at
    HEAD, the merge state).
  - **`adapter.ts`:** `createSpritesRunner(config)`, a `RunnerAdapter` reusing runner-local's tmux
    session, status hook, events, artifacts, steering and terminal:
    - `prepareWorkspace` makes the job repo under `<spritesDir>/sf-<jobId>/` and projects the
      harness with `isolation: "container"`, the sprite's Claude and Node, and `platform: "linux"`.
      It writes `sprite.json`, `sprite-entry.sh` (the sprite's side), `sprite-tty.json` and
      `sprite.sh` (the pane's side). A login account or a missing Sprites token fails here, before
      anything is made. A planning job goes to runner-local unchanged.
    - `startSession` creates the sprite, provisions it, sets and reads back the egress policy,
      uploads the job's files after the host's merge, writes the credential file, starts the mirror
      and runs runner-local's start. The launch check adds `spriteChecks`: the sprite's id, its
      policy, the settings hashes in the sprite. The prompt goes into the sprite too
      (`writeRunFile`). Any failure destroys the sprite.
    - `events` stops the mirror on `session.ended`, pulls the stage result and fetches and imports
      the result bundle, then destroys the sprite. It checks the job git dir and scans for the
      credential before passing the end on. A problem turns the outcome to `failed`, so nothing is
      pushed.
    - `collectArtifacts` adds `egress-policy`.
    - `release`, safe twice, kills the tmux session, destroys the sprite, and removes the job dir,
      run dir and attachments.
    - `manifest` declares runner-local's capabilities minus `own-hardware`, plus
      `container-isolation` and `cloud-sandbox`.
  - **`reap.ts`:** `reapSprites` and `diagnoseSprites` act on this runner's sprites, by name prefix
    `sf-<runner>-`, and on job dirs that no live job accounts for.
  - **`fake.ts`** (testing): the fake Sprites API described under acceptance criterion 13. It
    covers the endpoints and framing above with bearer auth, runs the fixed scripts for real in a
    directory per sprite, and includes `fakeClaude` and `bridgeSpawn`. **`ws-server.ts`** is the
    minimal WebSocket server it uses.
- **`packages/runner-local/src/adapter.ts`** (additive): `writeRunFile` on a workspace, so the
  prompt also reaches where the session runs. **`src/testing.ts`:** `scriptedTmux`'s `spawn`, so a
  pane can run the real bridge.
- **`packages/runner-contract`:** the capability `cloud-sandbox`.
- **`local/runner-host`:**
  - `buildRunner` wires `createSpritesRunner` when `isolation` is `sprites`. It passes the token
    file, `paths().spritesDir`, the prefix from the runner id and `hostModelCredential` (a token
    account's token), and forces tmux sessions.
  - Reaping also reaps sprites.
  - `doctor` on a sprites runner checks the token and the API, leftover sprites (`--fix` destroys
    them) and the credential, and runs the launch check on running sprite jobs.
  - `paths()` gains `spritesTokenFile` and `spritesDir`.

## Out of scope
- A provisioner in the cloud (a Sprites connector in `sf-engine`), and a daemon inside the sprite
  (ADR 0480 §1).
- A warm per-project pool restored from checkpoints (ADR 0480 §2).
- Planning sessions in a sprite. Stream-json sessions on sprites.
- Sprites billing or usage in the dashboard. Other sandbox providers beyond the `SandboxApi`
  interface.
- Per-port egress rules and an egress request log (Sprites' policy is DNS-based).

## Acceptance criteria
1. With `"isolation": "sprites"`, a build job runs end to end from the M5 on Sprites, and a triage
   job does too:
   - a fresh sprite;
   - the pinned Claude Code;
   - the job's allowlist;
   - the launch verified in the sprite;
   - the prompt sent;
   - the result back, pushed by the host with the job token;
   - hand-back with artifacts.

   The PR goes green through `factory/verify` (live check).
2. Each job gets a fresh sprite, provisioned at the agent image's pinned Claude Code before
   anything of the job goes in, and destroyed once its result is back. Tested.
3. The sprite's egress policy is exactly the job's allowlist as domain rules (no `*`). It is set
   before the job's files go in and read back. A policy that differs (an extra `*`) destroys the
   sprite before the prompt. Tested. A host off the allowlist is refused in a real sprite (live
   check).
4. The sprite never holds the Sprites token, the job's GitHub token, or the owner's other branches
   or uncommitted work. The model credential arrives only as a 0600 file that the entry script reads
   and deletes. Tested.
5. A live process in the sprite whose argv doesn't match the launch record fails the job with
   `harness-config-mismatch`, and so does a sprite whose settings, id or policy differ. The sprite
   is destroyed and nothing is pushed. Tested.
6. The run branch comes back to the host's job repo on the agent's HEAD, and what the agent didn't
   commit becomes an uncommitted change there. The host commits the leftovers and pushes only the
   run branch, with the job token. Ignored files stay in the sprite, and the owner's checkout is
   unchanged. Tested with the runner host's real git.
7. A session that writes the model credential into the repo fails without a push. Tested.
8. The following work through the pane's bridge:
   - the prompt pointer and a steer typed with `send-keys`;
   - the web terminal's tmux control-mode bridge, which reads output and types;
   - the session's exit.

   Tested with the real tmux and the bridge as its own process. `tmux attach` takes over a live
   sprite session (live check).
9. A dropped terminal socket reattaches to the same exec session, and typing still reaches it.
   Tested.
10. `release` twice leaves no sprite, job dir, run dir or tmux session. Reaping destroys only this
    runner's sprites with no live job, never the owner's other sprites or another runner's. Tested.
11. `sf-runner sprites login` refuses a token the API rejects and keeps a good one 0600. `status`
    lists this runner's sprites without printing the token. `logout` removes it. Tested. `doctor`
    on a sprites runner reports the token, the API and the credential (live check).
12. A sprites runner declares `cloud-sandbox` and `container-isolation` and not `own-hardware`,
    and `runner.json` takes no token. A runner without `isolation` behaves exactly as before.
    Tested.
13. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. Every Sprites call in the tests goes to the
    fake API.
