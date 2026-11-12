# ADR 0460: A sprite per job, provisioned by the owner's runner host

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
(piece 7, and "Joining"). Spec [36](../specs/36-sprites-sandboxes.md). Builds on
[0430](0430-a-container-per-job.md), [0380](0380-runner-local-tmux-and-hook-status.md),
[0400](0400-watch-and-steer-runs-from-the-dashboard.md), [0440](0440-a-web-terminal-relayed-through-a-durable-object-per-job.md),
[0410](0410-claude-accounts-live-on-the-host.md), [0033](0033-per-job-github-app-tokens.md),
[0052](0052-job-tokens-and-branch-confinement.md), [0250](0250-runner-host-pushes-and-harness-projection.md),
[0023](0023-runners-owned-by-users-and-requester-routing.md) and [0014](0014-runners-are-adapters.md).

## Context
A container per job (ADR 0430) gives each job its own repo, no host credentials, an egress
allowlist and permissions off in every stage. But it still runs on the owner's Mac, so the Mac's CPU
caps how many jobs run at once. The plan's piece 7 moves jobs into cloud sandboxes on **Sprites**,
Fly.io's sandbox product: Linux microVMs with persistent disks and checkpoints, driven by an HTTP
and WebSocket API.

Two rules make this harder than "call an API":
- **Model credentials stay with the owner (ADR 0023).** The factory must never store the owner's
  Claude token, and a Sprites account is the owner's too. A sandbox the *factory* creates would need
  both to come from somewhere.
- **No ambient authority (ADR 0033, 0052).** The agent must not hold a GitHub token. The host
  pushes the run branch with a per-job token (ADR 0250).

The plan also asked: one sprite per job, or one per project restored from a checkpoint?

### What Sprites offers, and what this relies on
These are the parts of Sprites the decision depends on, checked against Fly's published API specs
and docs on 2026-11-12. The [Sources](#sources) list has the links.

- **Auth.** Every HTTP call and WebSocket upgrade carries `Authorization: Bearer <token>`. A token is
  an org token from [sprites.dev/account](https://sprites.dev/account) or `sprite login`. The
  factory treats it as an opaque string.
- **Sprites.** `POST /v1/sprites {name}` creates one, `GET /v1/sprites/{name}` reads one,
  `GET /v1/sprites?prefix=` lists them, and `DELETE /v1/sprites/{name}` destroys one.
  - Every sprite boots Fly's own Ubuntu image with Node, Python and the Claude CLI preinstalled. The
    user is `sprite` with passwordless `sudo`, and home is `/home/sprite`.
  - A custom image isn't supported.
  - Each sprite gets 8 vCPUs, memory that autoscales, and 100 GB of disk.
- **Exec.** Commands run over `wss://api.sprites.dev/v1/sprites/{name}/exec?cmd=…&stdin=true&env=K=V&dir=…`.
  - **Without a TTY**, each binary message starts with one stream byte: 0 stdin, 1 stdout, 2 stderr,
    3 the exit code, 4 stdin EOF.
  - **With `tty=true&cols=&rows=`**, both directions carry raw terminal bytes. The client sends
    `{"type":"resize"}`, and the server sends `{"type":"session_info","session_id"}` and
    `{"type":"exit","exit_code"}`.
  - A command keeps running after its socket drops, and `/exec/{session_id}` reattaches to it.
  - `max_run_after_disconnect` bounds how long it keeps running with no client attached. This
    parameter is in the SDK, not the published spec.
- **Network policy.** `POST|GET /v1/sprites/{name}/policy/network` takes
  `{rules: [{domain, action: "allow"|"deny"}]}`.
  - It is a DNS-based egress allowlist. Rules match an exact host, `*.suffix`, or `*`.
  - A name that isn't allowed gets `REFUSED`. Raw IPs are blocked unless they came from an allowed
    name, and private IPs are always blocked.
  - It is enforced outside the VM and is read-only inside it. It has no ports and no per-request log.
- **Checkpoints.** `POST /v1/sprites/{name}/checkpoint` takes one and
  `POST …/checkpoints/{id}/restore` restores it.
  - A checkpoint restores **the same sprite**: there is no create-from-checkpoint.
  - Inside a sprite, `sprite-env checkpoints` can create and restore that sprite's own checkpoints.
- **Lifecycle.** A sprite with no activity for about 30 s pauses, which drops its TCP connections.
  The Tasks API on `/.sprite/api.sock` (`PUT /v1/tasks/<name> {"expire":"5m"}`) keeps it awake.
- **Pricing.** Fly lists $0.0385 per CPU-hour, $0.021875 per GB-hour of memory and about $0.50 per
  GB-month of hot storage, all billed while the sprite is awake. Warm and cold sprites have no
  compute charge.
  - Plans have limits: Hero allows 100 running sprites and 10 creates a minute on pay-as-you-go.
  - These numbers were not checked against a bill. Billing is out of scope here.

## Decision
1. **The owner's runner host is the provisioner. The factory is not.** A runner set to
   `runner.json` `"isolation": "sprites"` claims jobs as now. For each job it makes a sprite with the
   owner's Sprites token, runs the job's Claude in it, and pushes the result itself.
   - **The Sprites token stays on the host.** `sf-runner sprites login` reads it from stdin and keeps
     it in `~/.config/software-factory/sprites.token` (0600). That is the config dir every run's
     harness denies, next to the runner key. It is never in `runner.json`, never sent to the factory
     and never put in a sprite.
   - **The model credential is the job's Claude account's token** (ADR 0410), exactly as for a
     container (ADR 0430 §8). A login account is refused.
   - **The job token never enters the sprite.** The host pushes (ADR 0250, 0033).
   - **So the factory holds neither secret, and the core doesn't change.** It only learns a new
     capability.

   Rejected: **a Sprites connector in the cloud** (`sf-engine` creating sprites with a stored token).
   It would put the owner's Sprites token in the factory. Worse, the Claude token would have to
   reach a sandbox the factory made, either stored by the factory, which ADR 0023 forbids, or
   through Fly's Connectors gateway, which hands it to Fly and has no first-party Anthropic
   connector.

   **Deviation from the plan's "Joining" note** ("the daemon inside connects back with a one-job
   credential"). With no daemon inside the sprite, nothing inside could push without a GitHub token,
   and nothing would need to connect back: the host's channel and the web terminal relay (ADR 0440)
   are already outbound from the host. The cost is that the owner's host must be up while its
   sprites run. It does little work for them: a bridge process and a file pull per job, no CPU-heavy
   builds. So `maxConcurrent` can go well past what the host could build itself (it is capped at 16
   per host).
2. **One fresh sprite per job, destroyed when the session's result is back.** No warm checkpoint.
   - Sprites can't create a sprite from another's checkpoint. A per-project warm checkpoint would
     mean one long-lived sprite per project, restored between jobs.
   - That makes jobs of the same project run one at a time, which defeats the point.
   - It also keeps a sprite whose own checkpoints the previous job's agent could create and restore
     from inside (`sprite-env`).
   - A fresh sprite per job has no state from another job, runs in parallel, and costs nothing once
     destroyed.

   The price is provisioning on every job: the pinned Claude Code install, tens of seconds. A pool of
   per-project sprites restored to a base checkpoint is the follow-up, if start time ever matters
   more than isolation.
3. **The toolchain is provisioned, not imaged.** Sprites can't run the agent image (ADR 0430 §10).
   `packages/runner-local/sprite/provision.sh` reproduces what the Dockerfile installs:
   - git, a compiler, Python, `ps`, curl, jq and ripgrep, installed only if missing;
   - Claude Code at the Dockerfile's pinned `ARG CLAUDE_CODE_VERSION` (read from the Dockerfile, so
     there is one pin), in its own prefix `/opt/software-factory/claude-code-<version>`, never the
     sprite's preinstalled `claude`;
   - a `node` link there for the status hook.

   It runs **first, before the egress policy and before anything of the job is in the sprite**:
   there is no code and no credential to leak yet, and package mirrors don't have to be on the job's
   allowlist.
4. **Egress is Sprites' network policy, set to the container allowlist.** The rules are the job's
   `egressAllowlist` (ADR 0430 §5: the stage's hosts, `api.anthropic.com`, the runner's
   `sprites.allowedHosts`) as `allow` domain rules. There is no `*` and no
   `{"include":"defaults"}`.
   - The policy is put on after provisioning and read back before the job's files go in. The launch
     check reads it again (§7).
   - **Not the in-sprite proxy.** The agent has `sudo` in its own VM and could bypass anything that
     runs inside it. The policy is enforced outside.
   - **Two things are lost against the container.** A port in an allowlist entry can't be kept,
     because the policy is DNS-based, so the host is allowed on any port. And there is no
     per-request log, so instead of an `egress-log` the run gets an `egress-policy` artifact listing
     the rules.
5. **What goes in:** the job repo and the run's own files, nothing else.
   - **Upload.** The host makes the self-contained job repo as for a container (ADR 0430 §3), merges
     the default branch into it (ADR 0320), and projects the harness (`isolation: "container"`:
     every stage `bypassPermissions`, Claude's sandbox off, ADR 0430 §6). It then streams a tar of
     the job dir, the run dir and the attachments into the sprite over exec stdin. The files land at
     **the same absolute paths** as on the host (`sudo mkdir`, then owned by `sprite`), so the
     projected paths hold on both sides. That covers the settings, the launch script, the status
     file and the transcript.
   - **The credential** is written to a 0600 file in the sprite over exec stdin. The sprite's entry
     script reads it, deletes it and hands over to the harness's unchanged launch script. It is
     never in a URL, an argv or the host's disk.
   - **Keeping awake.** The entry script holds a Tasks API task, so a sprite doesn't pause while
     Claude waits on the model.
6. **The session stays a tmux session on the host; its pane is bridged to the sprite.** The pane
   runs `sprite.sh`, which runs `tty-bridge.ts` on the host's Node.
   - **The bridge** opens the sprite's TTY exec with the token from its file and pipes the pane
     through it raw. When the socket drops without an exit it reattaches to the same exec session.
   - **What carries over unchanged:** the start check and the trust dialog, the prompt pointer, a
     steer typed with `send-keys` (ADR 0400), the screen log, takeover by `tmux attach`, and the web
     terminal's tmux control-mode bridge (ADR 0440).
   - **The capabilities** are runner-local's, with `terminal`, minus `own-hardware` (a sprite is not
     the owner's machine, so a project that requires it doesn't route here). Added are
     `container-isolation`, because the VM meets everything that capability means, and the new
     `cloud-sandbox`.
   - **What doesn't move:** stream-json sessions (ADR 0450) aren't available on sprites, as on
     containers, and planning sessions stay on the host (ADR 0350).
7. **The launch check runs in the sprite.** It compares:
   - the live process's argv (`ps` in the sprite) against the launch record;
   - the settings files' sha256 **in the sprite** against the record;
   - the sprite's id against the one the runner created;
   - its network policy against the job's rules.

   Any difference destroys the sprite and fails the job with `harness-config-mismatch`.
   `sf-runner doctor` runs the same check on running sprite jobs. After the check, nothing in the
   sprite is trusted: the agent is effectively root in its VM.
8. **The run's files are mirrored to the host.** A fixed pull script returns what was appended to
   the pid file, `status.jsonl` and each transcript the status hook names, which must be under the
   job's home. The host appends it at the same host paths, about every 500 ms. runner-local's
   events, steering and artifacts then read host files as always. Each file has a cap per pull and
   overall.
9. **The result comes back as git, through the host's git only.** When the session ends, a fixed
   `result` script in the sprite does two things:
   - it snapshots the whole working tree as a commit on the agent's HEAD, using a temporary index
     and `git add -A`, so ignored files stay out exactly as `commitLeftovers` would leave them;
   - it prints a bundle of everything new since the upload.

   The host then:
   - fetches the bundle into its own job repo with its own git (no hooks, no config from the
     sprite);
   - puts the run branch on the agent's HEAD and the working tree on the snapshot, with the index
     at HEAD;
   - pulls `.factory-result.json`;
   - destroys the sprite.

   The host's unchanged steps follow: the merge check (unmerged entries in the sprite fail the job),
   the leftovers commit, the credential scan (ADR 0430 §8), the push with a fresh job token, and the
   diff. The host never unpacks files the sprite sent with anything but git's own checkout.
10. **Reaping by name.** A sprite is named `sf-<runner id>-<job slug>-<hash>`. Reaping and `doctor`
    list sprites with this runner's prefix and destroy those no live job names. The owner's other
    sprites and other hosts' sprites are never touched.
11. **A small provider interface.** `SandboxApi` (create, get, list, destroy, set and get egress,
    exec, a TTY URL) is everything the adapter uses. Sprites is its one implementation
    (`spritesApi`). Another provider would be a second implementation. No wider abstraction is
    built.

## Consequences
- Jobs no longer use the host's CPU. The host only bridges and pulls, so a Mac can run more jobs
  than it could build itself.
- Every job starts slower: a sprite create, the Claude Code install, the upload. That is tens of
  seconds against a container's few. A warm per-project pool would cut it, at the cost in §2.
- The owner's host must stay up and online while its sprites run. If it dies, the sprite's Claude
  stops `max_run_after_disconnect` (10 min) after the bridge goes. The next start's reaping, or
  `sf-runner doctor --fix`, destroys the sprite.
- Egress is per host, not per host and port, and has no request log.
- The model credential is in a cloud VM's environment, on Fly's infrastructure. It is the same
  token the container gets, revocable with `claude setup-token`. Egress and the credential scan
  limit it as for a container.
- Billing is the owner's Sprites account. The factory shows none of it.
- The fake Sprites API (`runner-local/src/sprites/fake.ts`) reproduces the endpoints and framing
  above and runs the runner's fixed scripts for real, so the upload, the pull, the checks and the
  result bundle are tested over real git. These still need a live run, against a real sprite:
  - `sudo` and the absolute paths;
  - the real image's tools;
  - the policy endpoint's exact shape;
  - the Tasks API;
  - the reattach.

## Sources
Checked 2026-11-12.
- Docs: [Sprites on Fly](https://docs.fly.io/sprites/), [networking and the network policy](https://docs.fly.io/sprites/concepts/networking),
  [lifecycle](https://docs.fly.io/sprites/concepts/lifecycle), [checkpoints](https://docs.fly.io/sprites/concepts/checkpoints),
  [keeping a sprite running (Tasks API)](https://docs.fly.io/sprites/keeping-sprites-running),
  [CLI](https://docs.fly.io/sprites/cli/commands), [authentication](https://docs.fly.io/sprites/cli/authentication),
  [connectors](https://docs.fly.io/sprites/concepts/connectors).
- API: [OpenAPI](https://api.sprites.dev/openapi.json), [WebSocket (AsyncAPI)](https://docs.fly.io/sprites/api/asyncapi.json),
  the JS SDK [superfly/sprites-js](https://github.com/superfly/sprites-js) (`src/exec.ts`, `src/websocket.ts`).
- Prior art: [superfly/orca-sprites](https://github.com/superfly/orca-sprites), which runs Orca
  workspaces on sprites and has measured timings.
- Pricing: [fly.io/sprites](https://fly.io/sprites).
