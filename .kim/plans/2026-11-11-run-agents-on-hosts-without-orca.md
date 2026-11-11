# Run coding agents on hosts, without Orca

## Where we are
- The core is already Orca-free: it only knows the runner contract (ADR 0014, 0100).
- Orca lives in three places: `packages/runner-orca` (worktree, terminal, launch, events, takeover),
  `local/runner-host` (wired to runner-orca; finds checkouts through Orca's repo list, ADR 0260;
  `doctor` checks Orca), and the harness's launch script (unsets Orca's env and plugin dirs).
- Orca gives us: a terminal per run you can take over, an embedded browser, worktree bookkeeping,
  agent status from `orca worktree ps`.

## Goal
The factory runs coding agents on **hosts** it can use, with no Orca anywhere in the path.
Why: more control over how runs execute, watch and isolate.

## Decisions
- **Host kinds (eventually):** your Macs running the daemon; Linux VMs/servers you own; ephemeral
  cloud sandboxes per job (Cloudflare Sandbox, Sprites, Daytona, e2b…).
- **Piece one:** your Macs, same `sf-runner` daemon, with runner-orca swapped for a plain adapter.
- **Joining:** pull for machines (daemon connects outbound, device login, as today);
  factory-provisioned for sandboxes (the factory creates one per job, and the daemon inside connects back
  with a one-job credential).
- **Session, first:** Claude Code's TUI in a tmux session per run, attachable.
- **Session, later:** a stream-json mode with a chat UI in the dashboard, a second way to run (how
  hosted agents do it: structured events, takeover by `claude --resume`). The session mode sits
  behind the adapter from the start so this slots in.
- **Watching and stepping in:** live log/transcript in the dashboard, steer (send a message) from the
  dashboard, take over with `tmux attach` on the host, **and** a web terminal in the dashboard.
- **Isolation:** piece one keeps today's worktree + Claude Code OS sandbox (ADR 0270). A **container
  per job** follows as its own piece (Docker/Podman on Linux; Apple `container` or OrbStack on Mac,
  chosen then): only the worktree mounted, no host credentials, egress allowlist, host still pushes.
  Then every stage can run `bypassPermissions`. Its image and egress rules carry over to cloud sandboxes.
- **Web terminal access:** only the runner's owner can type; others in the org watch read-only.
  Every attach is journalled. It reaches tmux through a relay in sf-engine: the host connects
  outbound over a WebSocket to a Durable Object per job, and the browser connects to the same DO
  (no open ports, works for sandboxes too).
- **Model credentials:** either the host's Claude login or a key/token, per host, **with several
  accounts per host and switching between them** (like Orca). Held on the host only (ADR 0023).
  Switching is **manual**: the owner picks the host's active account and new jobs use it; running
  jobs keep theirs. Switch with `sf-runner account use <name>` on the host or a picker on the
  runner's page in the dashboard (it sends only the name, on the heartbeat). Adding an account is
  host-only (`sf-runner account add`, a `claude` login into its own config dir).
- **runner-orca:** deleted once the new adapter works (with its doctor checks and the launch
  script's Orca special cases). ADR 0260's "attach to Orca's checkout" gets amended. tmux replaces Orca's terminal one for one
  (`new-session`/`send-keys`/`capture-pane`/`attach`), so the ADR 0270 launch-verify-then-prompt flow carries over.
- **Not rebuilding Orca:** only the slice the factory uses. `runner-local` = git worktree + tmux +
  status from Claude Code hooks/transcript (not screen-scraping); the dashboard is where you watch.
  Embedded browser → headless Playwright later if `browser` matters. (proposed, in chat)

## Open questions
None for the plan; each piece's spec settles its own details.

## Pieces (agreed order, one spec + PR each)
1. **runner-local on your Macs**: git worktree + tmux + ADR 0270 launch-verify, prompt as a file,
   status from Claude hooks/transcript, `tmux attach` takeover, host finds its own checkouts;
   delete runner-orca.
2. **Watch and steer from the dashboard**: live transcript/log, send a message into the session.
3. **Claude accounts on a host**, manual switching (each account its own config dir).
4. **Container per job**; every stage runs `bypassPermissions`.
5. **Linux hosts**: systemd service, install script.
6. **Web terminal** in the dashboard.
7. **Cloud sandboxes on Sprites (Fly)**, provisioned by the factory. For that piece's spec: Sprites
   are persistent and checkpointable, so one per job or one per project restored from a checkpoint;
   and since the factory never holds model credentials (ADR 0023), how the owner's Claude token and
   Sprites account reach a sandbox the factory creates.
8. **Chat UI**: stream-json session mode.


## Piece 1 in more detail
- New `packages/runner-local` adapter: `git worktree add` on the run branch inside the host's
  checkout; a tmux session per job (`sf-<job>`) running harness-claude's launch script; the ADR 0270
  check of the live process before the prompt; the prompt as `.factory-prompt.md` with a one-line
  pointer (as #34); agent status from Claude Code hooks writing to a per-run status file, not screen
  reads; `steer()` by `tmux send-keys`; takeover hint `tmux attach -t sf-<job>`; `release` kills
  the session and removes the worktree.
- `local/runner-host`: checkouts come from the host's own clone cache plus optional configured
  paths (`runner.json` `checkouts`), still matched by canonical remote identity (ADR 0260 amended);
  `doctor` checks tmux/git/claude instead of Orca; the launch script drops its Orca special cases.
- Capabilities declared: `hooks`, `headless`, `own-hardware`, `work-item-attachments`, `ui-takeover`.
- Delete `packages/runner-orca`. New ADR for the move; amend 0014, 0260, 0270.
- Done when: a build, a triage and a planning session run end to end on the M5 with Orca quit.

## Next steps
1. Spec 26 (piece 1) in `docs/specs/`, ADR from the claimed block, then build it.
2. Each later piece gets its spec when the one before it lands.
