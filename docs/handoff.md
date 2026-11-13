# Handoff

Where the build stands, for a fresh session. Read this first, then
[`parallel-work.md`](parallel-work.md) if you are building alongside other sessions, then the spec
of whatever you pick up.

Last refreshed: 2026-11-11 (spec 05, attach an outside PR). V1 is defined in [`v1-scope.md`](v1-scope.md).

## The product
A software factory on Cloudflare. Work comes in from anywhere, agents take it through triage, spec,
build and verify, and people step in only at gates. Runners are adapters; `runner-local` (git
worktree + tmux on the owner's Macs, ADR 0380) replaced the first one, `runner-orca`. Small
team, multi-org (Better Auth). Plan: [`.kim/plans/2026-11-10-personal-software-factory-design.md`](../.kim/plans/2026-11-10-personal-software-factory-design.md).
Architecture: [`architecture.md`](architecture.md). UI: [`ui-plan.md`](ui-plan.md).

## How we work
- Each slice goes interview → spec in `docs/specs/NN-*.md` → build → PR → merge.
- Builds are done by agents in worktrees, briefed from the spec plus this file. Keep a
  `WIP.md` at the repo root while working so a build can be resumed (it is gitignored).
- **Merge commits only, never rebase or force-push.** Resolve conflicts by keeping both sides.
- Parallel builds use **disjoint migration and ADR number ranges** ([`parallel-work.md`](parallel-work.md)).
- Use **Node 24** (`.nvmrc`). Plain `node` on this Mac may be another version: put
  `$HOME/.nvm/versions/node/v24.21.0/bin` first on `PATH`.

## Standing rules
See [`AGENTS.md`](../AGENTS.md). In short: operations first, no ambient authority, policy in code
and not AI-configurable, model roles not ids, runners are adapters, nothing reaches main except
through `factory/verify` and the merge gate. The repo is public: no secrets, no account IDs.

## Merged on main
| PR | What |
| --- | --- |
| Design | Product plan, architecture diagram, UI plan, mockups, design system, research |
| #2 | Spec 00, scaffold: pnpm + Turborepo + Biome, placeholder apps and packages; AGENTS/CONTEXT; ADRs 0001–0032; specs 00–04 and 10–14 |
| #3 | Spike: auth, orgs and multi-session (`spikes/auth-multisession`, proposed ADR 0120) |
| #4 | CI and deploy workflows, provisioning script ([`deploying.md`](deploying.md)) |
| #5 | Spike: Workflow per work item and the gate (`spikes/workflow-gate`, proposed ADR 0110) |
| #6 | Spike: runner contract, `runner-orca` over the `orca` CLI, `runner-local` sketch (`spikes/runner-orca`, ADR 0100) |
| #7 | [Design review](reviews/2026-11-11-design-review.md) |
| #8 | Custom domain and Worker secrets; `sf-app` and `sf-engine` deployed as placeholders (`/api/health` only) |
| #9 | [Review decisions](reviews/2026-11-11-review-decisions.md) |
| #10 | Review decisions applied to the docs: ADRs 0033–0047, amendments to 0001–0032, vocabulary (connector, autonomy policy, project template, Question, `docs/specs/`), R1 specs split into milestones, spec 15 |
| #11 | [V1 scope](v1-scope.md): the dogfooding factory |
| #13 | V1 step 1, core + engine: `core_*` schema, operations + `invoke()` + gate, the work-item Workflow, the signed runner channel, GitHub App job tokens. ADRs 0050–0054; spike ADRs 0100 and 0110 promoted |
| #14 | V1 step 3, the runner: `local/runner-host` (`sf-runner`: heartbeat, claim, the job lifecycle, run-branch push with the job token, launchd), `packages/runner-orca`, `packages/harness-claude` (per-run settings, no owner credentials). ADR 0250. Verified end to end against a local engine |
| #15 | V1 step 4, verify + GitHub connector + incidents: review-packet assembly from CI on the head SHA, `factory/verify` per SHA, the App webhook (`/webhooks/github`), branch confinement (ruleset + push validation), Workflow v2, incident root causes, the check-only auto-merge (ADR 0230), the evals regression suite. ADRs 0230–0231, migration 0040 |
| #16 | V1 step 2, the app: `sf-app` on TanStack Start + shadcn (`packages/ui`), GitHub sign-in for the allowlisted login with a Personal org, Inbox + runner health line, New work, work item detail with the Planning tab, the review packet (Merge / Send back), Setup (project, policy sync, runner keys). ADR 0240 |
| #18 | Bootstrap fixes, the first factory incidents ([write-up](incidents/2026-11-11-bootstrap.md)): `project.update` (installation id / detect, default branch), installation detection as the App (`GitHubService.findRepoInstallation`) with `installationWarning` on `project.create`, Setup's fix path and runner pairing command, `sf-runner pair` tolerant stdin, `sf-runner install` requires Node ≥ 24 |
| #19 | Onboarding rebuild ([ADR 0055](adr/0055-github-installations-are-org-records.md), [0056](adr/0056-runner-device-login.md)): Connect GitHub through the install flow (installation records, migration 0060), repo picker, policy auto-sync + Create policy PR, `sf-runner login` device flow, Setup as a live checklist and the inbox's Finish setup card |
| #20 | App performance ([ADR 0241](adr/0241-app-runs-next-to-d1-and-loads-pages-in-one-request.md)): `sf-app` (and `sf-engine`'s fetch handlers) pinned next to D1 in SJC, session in the query cache, loaders prefetch everything in one batched `callReads` request, SSR query integration, pending skeletons, `Server-Timing` on server functions and engine RPC; `test/perf.test.ts` guards loaders. Merged with `factory/verify` red (not attached to a work item; the factory had no project or runner yet), as a one-off bootstrap exception the owner approved |
| #21 | Core: fewer D1 round trips per operation (ADR 0241 amendment): `invoke()` resolves scope + the caller's org role in one D1 batch; `workItem.get` and `inbox.list` read in parallel. Also merged with `factory/verify` red, the same bootstrap exception (owner approved) |
| #27 | Fewer D1 requests per page (ADR 0241, second amendment): `readBatch` in `packages/db`; `inbox.list` is one D1 request, `workItem.get` reads its rows in one; GitHub-backed reads (`SLOW_READS`) never batched with database reads. Also merged with `factory/verify` red, the same bootstrap exception (owner approved) |
| #22 | Runner attaches to the existing Orca repo ([ADR 0260](adr/0260-runners-attach-to-the-existing-checkout.md), incident [2026-11-11 #5](incidents/2026-11-11-bootstrap.md#5-the-runner-added-a-second-orca-repo)): jobs run as worktrees of the Orca repo found by canonical remote identity (`runner-contract` `canonicalRepoKey`, `resolveCheckout`), the host fetches by URL into `refs/software-factory/heads/*` without touching the owner's checkout, clone-once fallback, no unregister in `release`, startup migration, `sf-runner status` shows jobs, `sf-runner doctor --fix`; `.factory/checks/` for runner adapters |
| #24 | The factory launches the harness ([ADR 0270](adr/0270-the-factory-launches-the-harness-and-verifies-it.md), incident [2026-11-11 #6](incidents/2026-11-11-bootstrap.md#6-the-launcher-overrode-the-harnesss-permission-mode)): `harness-claude` owns the launch (`claude --permission-mode <stage mode> --setting-sources project,local --settings <run settings>`, no user settings), the Claude sandbox in every stage (build `bypassPermissions` sandboxed; triage/spec/verify `dontAsk`), `.factory/policy.json` → `harness` (modes, allow rules, hosts; on the job as `harness.profile`); runner-orca runs the launch script in an Orca terminal (not `agent launch`), verifies the live process before the prompt, `harness-config-mismatch` kills and fails; `sf-runner doctor` checks running jobs; `.factory/checks/` for both. Merged with `factory/verify` red (not opened by the factory), as a bootstrap exception like #20 and #22: the fix stops jobs running in the owner's own permission mode |
| #26 | Protect `main` ([ADR 0280](adr/0280-protect-main-with-a-generated-ruleset.md)): the factory generates `<repo>-default-branch.json` (PR, `ci` + `factory/verify` pinned and strict, no force push, no deletion, no bypass) and `<repo>-factory-branches.json` as GitHub ruleset imports; Setup's **Protect `main`** step (Download ruleset, Open GitHub rulesets, Check now, Send to the repo admin); `protection.check` / `protection.observe` record verdicts (migration 0070); `repository_ruleset` / `branch_protection_rule` webhooks and a daily cron re-check; the **Protection on `main` changed** inbox card; policy `protection.onRed` (`warn` default, `block` holds builds). The App keeps `administration: read`. software-factory's own switch is in [`deploying.md`](deploying.md#protecting-main) (owner, at V1 step 5) |
| #29 | Unmergeable factory PRs ([ADR 0320](adr/0320-factory-branches-stay-mergeable.md), incident [2026-11-11 #7](incidents/2026-11-11-bootstrap.md)): the runner host merges the default branch before a build, Workflow v3 treats a conflicting PR as its own state (back to build, 3 free rounds) and asks a person when no CI reports. Merged with `factory/verify` red (not opened by the factory), a bootstrap exception the owner approved |
| #23 | Work item #1, attachments ([ADR 0310](adr/0310-work-item-attachments.md), migration 0090), built by the factory; `main` merged in and renumbered by hand after it was stuck (incident #7). Merged with `factory/verify` red (the head moved past the one the factory verified), a bootstrap exception the owner approved |
| #30 | The merge queue ([ADR 0330](adr/0330-the-factory-runs-its-own-merge-queue.md), [spec 06](specs/06-merge-queue.md), migration 0100): approved merges land one at a time per project through Workflow v4; the head is updated by GitHub's update-branch, CI runs once on it, and the approval and review packet carry over. Merged with `factory/verify` red (not opened by the factory), a bootstrap exception the owner approved |
| #28 | Attach an outside PR ([spec 05](specs/05-attach-a-pull-request.md), [ADR 0290](adr/0290-an-outside-pr-is-attached-and-verified.md)): `workItem.attachPr` gives a local session's or a person's PR a work item of kind `attached` (migration 0080); the Workflow's `runAttached` (kind-gated, no version bump) triages it, skips spec and build, verifies the PR's own head and opens the merge gate, never pushing to its branch; a push re-verifies and withdraws a pending merge, closing the PR cancels the item; the unattached `factory/verify` links to sf-app's `/attach`, and New work lists open unattached PRs. Merged with `factory/verify` red as the **last** bootstrap exception (it can't attach itself); every PR after it is attached instead. Merged with `factory/verify` red, the last bootstrap exception: it is what lets outside PRs pass `factory/verify` (the default-branch ruleset was switched off for #30 and #28, then back on) |
| #33, #35, #36, #37 | Spec 20, planning M1 ([ADR 0350](adr/0350-how-the-planning-loop-is-wired.md), migration 0120): planning is a live session on a runner. The planning log, sessions, chat and presence; heavy and light pools; the planning MCP server and kim-style hooks through the runner host's relay; Workflow v5's spec stage; the Planning tab, layout A. Merged with `factory/verify` red (not attached), with the default-branch ruleset switched off by the owner |

## In flight
- **Run agents without Orca** (block W, plan `.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`):
  piece 1, [spec 30](specs/30-runner-local-without-orca.md) / [ADR 0380](adr/0380-runner-local-tmux-and-hook-status.md),
  is built on branch `timoconnellaus/no-orca`: `packages/runner-local` (git worktree + tmux on
  `tmux -L software-factory`, status from the harness's hook file, takeover by `tmux attach`)
  replaces `packages/runner-orca`, which is deleted. Acceptance criteria 1–3 need a live run on the
  M5 with Orca quit (a build, a triage, a planning session; attach and type). To switch the M5:
  `brew install tmux` if missing, `git pull`, `sf-runner doctor --fix` (sets `checkouts` once from
  Orca's repos), then `sf-runner install` with no jobs running. Job worktrees the old runner left in
  Orca (`sf-job:` comments) are removed in Orca by hand. Pieces 2–8 get their own specs.
  Piece 2, [spec 31](specs/31-watch-and-steer-runs.md) / [ADR 0400](adr/0400-watch-and-steer-runs-from-the-dashboard.md)
  (block X, migration 0170), is built on `timoconnellaus/hosts-watch-steer`: the Live tab (transcript
  and terminal from `run.live`, polled), `run.steer` for the runner's owner, the held `steer` call
  on the channel, `message` events from the transcript. Criteria 1 and 2 need a live run on the M5.
  Piece 8, **a chat UI on a stream-json session** (block AC, [spec 37](specs/37-chat-ui-stream-json.md) /
  [ADR 0450](adr/0450-a-stream-json-session-mode-with-a-chat-view.md), migration 0220, branch
  `timoconnellaus/hosts-chat-ui`): `runner.json` `session: "stream-json"` runs Claude headless as a
  two-way stream (runner-local `stream.ts`, the `chat` capability), the Live tab's Chat view, and
  `run.takeover` (stop the stream, show `claude --resume <id>`). Criteria 1–4 need a live run on the M5.
  Piece 3, [spec 32](specs/32-claude-accounts-on-a-host.md) / [ADR 0410](adr/0410-claude-accounts-live-on-the-host.md)
  (block Y, migration 0180), is built on branch `timoconnellaus/hosts-accounts`: Claude accounts on
  a host (`sf-runner account add|use|list|remove`), the active one in each job's launch, the
  dashboard's picker on Setup (`runner.account.use`, delivered as `account.use` on the heartbeat),
  usage limits surfaced per account. Its live checks (a real second login, a switch from Setup) are
  in the PR.
  Piece 5, **Linux hosts** (block Z, [spec 34](specs/34-linux-hosts.md) /
  [ADR 0420](adr/0420-linux-hosts-run-the-runner-as-a-systemd-user-service.md), branch
  `timoconnellaus/hosts-linux`): a systemd user service chosen by platform, Linux log path, the
  harness's per-platform deny lists, Linux doctor checks (bubblewrap, socat, linger), the install
  path in the runner-host README, and `local/runner-host/scripts/linux-check.sh` (the tests in a
  Debian container). Criteria 2–3, 6 and 8 need a live Linux host (README "Running on Linux").
  Piece 4, **a container per job** (block AA, [spec 33](specs/33-container-per-job.md) /
  [ADR 0430](adr/0430-a-container-per-job.md), branch `timoconnellaus/hosts-containers`):
  `runner.json` `"isolation": "container"` runs each job's Claude in a Docker container
  (`packages/runner-local/src/container/`, image `packages/runner-local/container/`). Each job gets a
  self-contained job repo, an egress allowlist proxy, every stage `bypassPermissions`, and the launch
  check inside the container. The host still pushes. Planning sessions stay on the host. Criteria 1
  and 9 need a live run on the M5 with Docker Desktop (runner-host README, "A container per job").
  Piece 7, **Sprites sandboxes** (block AF, [spec 36](specs/36-sprites-sandboxes.md) /
  [ADR 0480](adr/0480-a-sprite-per-job-provisioned-by-the-owners-host.md), branch
  `timoconnellaus/hosts-sprites`): `runner.json` `"isolation": "sprites"` runs each job in a fresh
  sprite made by the owner's host with its own Sprites token (`sf-runner sprites login`, 0600 on the
  host). `packages/runner-local/src/sprites/` holds the API client, the pane-to-sprite TTY bridge,
  the run-file mirror and the result bundle. Egress is Sprites' network policy. The host still pushes.
  Tested against a fake Sprites API. **The mode must not be turned on until spec 36's live-check
  gate has passed** (policy shapes and default deny, bypasses with `sudo`, Fly's internal network,
  `/.sprite/api.sock`, checkpoints, exec framing, create's size, the image); criteria 1, 8
  (`tmux attach`) and 11 (`doctor`) are part of it (runner-host README, "A sprite per job").
  Piece 6, **the web terminal** (block AB, [spec 35](specs/35-web-terminal.md) /
  [ADR 0440](adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md), migration 0210,
  branch `timoconnellaus/hosts-web-terminal`): the Live tab's Web terminal view (xterm.js), the
  `TerminalRelay` Durable Object per job, the held `terminal` call and the host's outbound socket,
  `run.terminal.attach`/`detach`/`host`, the tmux control-mode bridge in runner-local. Criteria 1,
  2 and 6 need a live run on the M5 (engine deployed first, then the runner updated).
- **Factory config in the app** (block U, spec 09): config moves from `.factory/policy.json` to
  versions in the app (ADR 0370), workflows fill typed slots (0371), agents are harness-neutral
  (0372), the factory trials its own practice changes (0373) and an adjudicator earns approvals
  (0374). Plan `.kim/plans/2026-11-11-manage-factory-settings-in-the-ui.md`, mockups
  `.kim/mockups/project-settings.html` and `project-stages.html`. M1 is #45, M2 (workflows, agents,
  Workflow v6) is #48, M3 (usage, trials, the improver) is #50, and M4 (the adjudicator) is stacked on #50. Each PR
  lists what was deferred in spec 09's "As built" sections.
- **Planning design** (`planning-process`, block M): planning rebuilt as a live session on a runner,
  modelled on kim. ADRs 0300–0306, specs 20–25, mockups `.kim/mockups/planning-*.html`, plan
  `.kim/plans/2026-11-11-factory-planning.md`.
- **Desktop app** (`desktop-app`, block W, spec [40](specs/40-desktop-app.md), ADRs 0390–0393): a macOS app
  on Electrobun that is the daily UI and supervises the runner; the website shrinks to auth. The spike
  (`spikes/electrobun`, #44) showed a Keychain token can't prove a person, so gate decisions from the
  desktop need a Secure Enclave presence proof (ADR 0391, amends 0340). Five milestones: M1 the client
  door + desktop devices + presence (cloud), M2 `apps/desktop` shell + runner, M3 screens, M4 signing
  and updates, M5 the website strip-down. **M1 is built** (`desktop-m1`, migration 0160): `/client/v1`,
  `desktop.*`, `desktopDevice.*`, `presence.*`, `/desktop/connect`, `/open/*`, Setup's devices card.
  **M2a is built** (`desktop-m2`): `apps/desktop` (sign-in, the device key, the door client with the
  presence flow, the supervised runner on bundled Node, launchd takeover, the menu bar, badge,
  notifications by polling, login item, deep links) and `sf-runner`'s host lock. **M2b is built** (`desktop-m2b`): the ClientHub Durable Object per person, `/client/v1/live`, `notify`
  fan-out (the assignee, or the org's owners and admins), and the app's live socket. **M3 is built** (`desktop-m3-screens`): the inbox, New work (with
  attachments over the door as `{ $bytes }`), the work item with Planning and its timeline, the
  review packet (Merge and Send back through Touch ID), Setup and attach, ported into
  `apps/desktop`; the shared logic is in `packages/client`.
  **M4a is built** (`desktop-m4`, PR #80): signed, notarized canary releases from
  `.github/workflows/desktop-release.yml` to `downloads.zerobsai.com/desktop` (R2 `sf-desktop-releases`),
  and the in-app updater, which applies only a higher version signed by its own Team ID and
  accepted by Gatekeeper, and never cancels a running job unless the person says so. **Stable is
  off** until the owner does the steps in `docs/deploying.md` ("Before stable releases": `release`
  environment on `main` only, a required reviewer with no admin bypass, a `v*` tag ruleset), then
  sets `DESKTOP_STABLE_ENABLED`. **The canary upload needs a new bucket-scoped R2 token**
  (`DESKTOP_R2_ACCESS_KEY_ID`/`DESKTOP_R2_SECRET_ACCESS_KEY` in the `release` environment; the owner
  creates it, steps in `docs/deploying.md`). The workflow runs in the GitHub environment `release`,
  whose other secrets are set: `MACOS_CERT_P12`/`MACOS_CERT_PASSWORD` (the Developer ID Application
  identity only), `MACOS_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, and the notarization key `ASC_KEY_P8`,
  `ASC_KEY_ID`, `ASC_ISSUER_ID`. Electrobun signs and notarizes itself; signing from a build hook
  breaks the seal (it rewrites `Resources/version.json` after every hook). The download zip is the
  plain notarized app, not Electrobun's self-extracting wrapper (whose Setup window waited for a click
  and failed when translocated). The Developer ID is in the M5's login keychain, for local signed
  builds; CI is where releases are signed. After the first canary release, check that
  `https://downloads.zerobsai.com/desktop/canary-macos-arm64-update-v2.json` and
  `…/canary-macos-arm64-Software-Factory.zip` load, and that an installed canary updates to the next.
  **M4b is back on (2026-11-12):** the owner kept gate approvals on the desktop with Touch ID
  (`.userPresence`). Spec 40 M4b and ADR 0394 have the design and the owner's steps (an App ID
  `com.software-factory.desktop.keys`, a Developer ID profile in `MACOS_KEYS_PROFILE`, not set yet: the
  owner is redoing a profile whose bundle id was mistyped). The first build PR is the signing spike
  (where `SF Keys.app` can sit and at which Electrobun hook it can be signed so it survives
  `electrobun build`); every CI step that needs the profile skips cleanly without it. **On hold:** M5 (the website keeps everything
  until the desktop app has the Factory and Settings sections). Signed builds use a software key and
  the engine refuses software keys for gate decisions (`DESKTOP_ALLOW_SOFTWARE_KEYS` stays empty in
  production). Why it stays empty: tested on the M5, no keychain restriction protects the desktop
  token or the software key from a local agent, because the app's `bun` runs any script under the
  app's signature. So gate decisions are not available from a signed desktop build; the owner is
  deciding between approving on the phone, the Touch ID helper, or container-only runners.
  **`MACOS_KEYS_PROFILE` is set (2026-11-13)** in the `release` environment: the owner created the
  App ID `com.software-factory.desktop.keys` and its Developer ID profile, verified
  (application-identifier `TEAMID.com.software-factory.desktop.keys`, keychain-access-groups
  `TEAMID.*`, expires 2044), ready for the M4b build steps that need it (spec 40 M4b, PR #89).
  app's signature. So gate decisions are not available from a signed desktop build until M4b ships.
  **The version handshake is built** (`desktop-handshake`, PR #81, ADR 0393): the app sends
  `x-sf-client-protocol`; below sf-engine's `DESKTOP_MIN_PROTOCOL` the door answers 426
  `update_required` and the app checks for an update. Bump `DOOR_PROTOCOL` when the app needs
  something new from the door; raise the floor only when old builds must stop. Traps in `apps/desktop`:
  stage files explicitly on branches without its `.gitignore` (a `git add -A` once committed 138k
  lines of `.hutch/` and `build/`); Electrobun's request proxy is a function, so RPC names like `call`
  hit `Function.prototype` (use `bunRequests`, `src/mainview/request.ts`).
- **The desktop shell and look** (block AD, [spec 41](specs/41-desktop-shell-and-look.md),
  [ADR 0460](adr/0460-the-desktop-shell-and-look.md), branch `timoconnellaus/desktop-shell`): slice 1
  of the approved design (`docs/design/factory-ui/`). The window shell (toolbar, tabs, ⌘K, org rail,
  sidebar, nested lists, status bar, focus mode), the look as `packages/ui` tokens (`desktop.css`),
  and the existing screens restyled. Later slices wait on specs 50 and 51, chat and the hosts web
  terminal (spec 41 lists them).
- The runner (#14) hasn't run against the deployed engine yet: that needs a registered runner (the
  app's setup screen) and a project with `.factory/policy.json` (step 5). See `local/runner-host/README.md`. Spike ADRs 0100 and 0110 are promoted into `docs/adr/`; 0120 (auth) moves when
  the app session promotes it.

## Contracts for the V1 sessions (from V1-1, core + engine)
Everything below exists on `main`, with tests. Read the package READMEs for detail.

**Every session**
- State changes only through operations (`packages/core`, `describeOperations()` lists them). In V1
  they all run in `sf-engine` (ADR 0051). Refusals are `OperationError` codes: `invalid_input`,
  `forbidden`, `denied`, `killed`, `fenced`, `conflict`, `not_found`, `unavailable`, `bad_approval`.
- D1 is `software-factory`; migrations live in `packages/db/migrations` (blocks in
  [`parallel-work.md`](parallel-work.md)); typed access via `createDb` (Kysely, ADR 0050).
- A project's policy is `.factory/policy.json` on its default branch (ADR 0054). A project with no
  valid policy refuses new work and every agent call (fail closed).

**App session (step 2: sign-in, Inbox, New work, work item detail, review packet)**
- Better Auth on `core_user` / `core_session` / `core_account` / `core_verification` /
  `core_organization` / `core_member` / `core_invitation`: field mapping in
  [`packages/db/README.md`](../packages/db/README.md). Fill `core_user.github_login` on GitHub sign-in.
  Create the Personal org with `kind = 'personal'` and the user as `owner`.
- Bind D1 `software-factory` (no `migrations_dir`: the engine applies them) and a service binding
  `ENGINE` → `sf-engine`, entrypoint `EngineApi`. Call
  `env.ENGINE.invoke(name, input, { actor: { type: "human", id: userId }, origin: { surface: "app" } })`;
  it returns `{ ok: true, result }` or `{ ok: false, error: { code, message } }`. Pass an
  `idempotencyKey` for form submits.
- Operations by screen:
  - Setup (ADR 0055, 0056): `setup.status { orgId }` (the checklist), `github.connectStart` (GitHub's
    install URL with a single-use state; GitHub returns to `/integrations/github/setup`, which calls
    `github.connectInstallation` server-side), `github.repos` (the repo picker), `project.create
    { orgId, installationRecordId, repoId }` (refuses unreachable repos; reads the policy),
    `policy.resync`, `policy.proposeTemplate` (the Create policy PR button), `project.list`,
    `runner.deviceLookup` / `runner.approveDevice` / `runner.denyDevice` (`/runners/connect`), and the
    key fallback `runner.register`, `runner.rotateKey`, `runner.list`. `project.update` is an admin
    fix only; the UI never shows an installation id.
  - New work: `workItem.previewRouting { projectId }`, `workItem.create { projectId, title?, body, source: "app", eventId }`,
    and the project's open unattached PRs `github.openPullRequests { projectId }`, each with Attach.
  - Attach (spec 05, ADR 0290): `/attach?repo=<owner>/<repo>&pr=<n>` (the unattached
    `factory/verify` check's Details link) reads `workItem.previewAttach { repo, prNumber }` and
    attaches with `workItem.attachPr { projectId, prNumber }`, then opens the work item.
  - Inbox: `inbox.list { orgId? }` (gates and questions assigned to you, running items, your runners'
    health, WIP holds). Decide with `spec.approve`, `spec.requestChanges { note }`,
    `review.merge { openedFullDiff }`, `review.sendBack { note, openedFullDiff }`, `approval.decide`,
    `question.answer`, `question.acceptDefaults`. A repeat decision returns `alreadyDecided: true`.
  - Work item detail: `workItem.get` (item, stages with the spec-skip reason, spec, questions, gates,
    runs, latest review packet; since V1-2 also `policy` with the review packet section order,
    `approvers` with their rule, and `viewer`), `workItem.timeline` (the audit journal), `workItem.cancel`.
  - Kill switches: `killSwitch.set { scope: "org" | "project", id, on }`.
- Deep links the outbox `notify` rows carry: `/?item=<workItemId>` and `/work/<workItemId>`.

**Runner session (step 3: runner-host, runner-orca, harness-claude; runner-orca since replaced by runner-local, ADR 0380)**
- Build against `@software-factory/runner-contract`: `httpControlPlane` (signed client),
  `RunnerAdapter`, the wire schemas, `RESULT_FILE` and the stage result schemas. The host's loop is
  in [`packages/runner-contract/README.md`](../packages/runner-contract/README.md).
- Channel: `https://sf-engine.zerobsai.com/runner/v1/*`. Runner id and key come from
  `runner.register` (a person, through the app). Heartbeat every ~20 s; the lease lasts 10 minutes.
- The job carries no token: call `token(jobId, fencingToken)` for a repo-scoped App token, push only
  `job.branch`, hand back `{ branch, headSha, result }`. A `409 fenced|killed` means stop now.
- Prompts already end with the result file and its JSON shape; the harness writes it, the host
  passes it through untouched and never commits it.

**Verify + GitHub connector + incidents (step 4): built** (ADRs 0230, 0231)
- `reviewPacket.record` now assembles the packet and returns `{ verdict, ciState, reasons }`: it
  passes only with green CI on the head SHA (from GitHub) and a complete packet. Its `sections`
  carry `verdict { verdict, reasons, warnings }`, `ci`, `changed`, `risk`, `runner`, `warnings`; the
  app's packet screen renders these. `risk_flags` are computed from GitHub's compare.
- `factory/verify` is posted from the App per SHA (`core_verify_checks`); `verify.refresh`
  re-evaluates it on PR, CI and re-run events. `ci.read` reads CI for a work item's head.
- Workflow v2 opens the PR before verify, waits for CI, goes by the packet's verdict, and tries
  `pr.autoMerge` for incident items (ADR 0230). v1 instances run unchanged.
- The webhook is `sf-engine` `/webhooks/github`, on `software-factory.zerobsai.com/webhooks/*` by a
  Workers route (sf-app untouched). `push.observe` does branch confinement and the default-branch
  `policy.sync`; `github.installation` tracks the App's installations.
- Incidents carry `root_cause` and `proposed_fix`; `incident.open` returns `rootCause`.
- Onboarding: `project.checkGitHub { projectId }` → `{ ok, problems }`, now the ADR 0280 ruleset verdict; `protection.check` records it.
- Not built: holdout tests (spec 04 criterion 8, ADR 0034), the evidence policy (criterion 11).

**Attach an outside PR (spec 05): built** (ADR 0290, migration 0080)
- `workItem.attachPr { projectId, prNumber }` gives an open same-repo PR into the default branch a
  work item of kind `attached` (branch = the PR's head ref, `pr_number`, `head_sha`; source `pr`;
  dedupe key `github:<owner>/<repo>#<n>`). Forks, closed or merged PRs, `factory/*` branches and
  projects without a valid policy are refused.
- The Workflow's `runAttached` (chosen by kind for every Workflow version; it merges directly, not through the merge queue, since the App can't update a person's branch): triage, spec and build skipped
  with "attached PR: built outside the factory", then verify on the PR's head → merge gate. No
  `branch.ensure`/`branch.advance`, no build jobs. Fail or send-back → `workItem.awaitHead` (status
  `waiting` with the reason) until a push; a push withdraws a pending merge gate (decision
  `withdrawn`). `verify.refresh` records the new head and sends `pr-head-<item>`; `pull_request
  closed` without a merge cancels the item.
- `GitHubService.getPullRequest` / `listOpenPullRequests` (no new App permissions or events).

**Unmergeable PRs (ADR 0320, incident 2026-11-11 #7)**
- Jobs carry `repo.defaultBranch`; the runner host merges it into the run branch before a build
  (conflicts left for the session; unresolved ones fail without a push).
- Workflow **v3** (`WORKFLOW_VERSION = 3`): `ci.read` also returns the PR's `mergeable`; a conflict
  at PR open or during the CI wait sends the item back to build (3 free rounds); CI still missing
  asks a blocking `operations` Question (Re-check CI / Stop this work item), no build retry.
- Merge queue: built, see below (ADR 0330).

**Runners update themselves (ADR 0360, spec 08, incident #9)**
- The deploy passes `DEPLOYED_SHA` (the deployed commit) to sf-engine. `runner.heartbeat` answers
  it as `desiredVersion` and records the runner's reported `version` (migration 0130:
  `core_runners.version`, `auto_update`, `update_state`, `update_target`, `update_reason`).
- Amended by ADR 0520 (spec 38): `desiredVersion` is `RUNNER_SHA`, the last commit that changed
  runner code (the deploy computes it); runners keep claiming while an update waits (light only
  after 30 min, nothing after 60) and drain at once only for a `minRunnerCompat` above their
  `RUNNER_COMPAT`. The engine enforces it too (migration 0290, `core_runners.compat`), places no
  planning job on a `waiting` runner, and asks its idle planning sessions to yield once it claims
  nothing. Spec 39 (re-adopt live jobs after a restart) is written, not built.
- The runner host updates itself: idle → fast-forward to exactly that commit → `pnpm install
  --frozen-lockfile` → exit 75. launchd runs `local/runner-host/bin/sf-runner-service`, which rolls
  back after three unconfirmed starts. It reports `blocked` (with the reason) instead of guessing.
- `runner.list`, the inbox's runner health line and `sf-runner status` show it.
- An existing runner moves onto the wrapper with one `sf-runner install`, which now adds Orca's bin
  directory to `PATH` and retries the bootstrap.

**Prompts travel as a file (incident 2026-11-11 #8)**
- The runner adapter (runner-orca then, runner-local now) writes the job's prompt to `.factory-prompt.md` in the worktree (in
  `PRIVATE_WORKTREE_FILES`, so it's excluded from git) and types only `PROMPT_POINTER`, one line,
  after the live-process check. Typing the whole prompt truncated it to its tail, and every job
  since #24 ran on a fragment.
- The M5's runner needs updating to pick it up: `git pull`, then `sf-runner install` with no jobs
  running.

**The `sf` CLI (ADR 0340, spec 07)**
- `local/cli` (`sf`): `login [--write]`, `logout`, `status`, `ops`, `call <op>`, `inbox`, `ls`,
  `show`, `timeline`, `queue`, `new`, `attach`, `cancel`, `open`. See its README.
- `sf-engine` `/cli/v1`: `device/start`, `device/poll` (unsigned, as `CLI_DEVICE_ACTOR`), `call`
  (Bearer `sfc_…`; actor `human`, surface `cli`; a `read` token reaches only `read`-risk ops), `ops`.
- New reads the CLI needs: `org.list` (your orgs and role) and `workItem.list { number }`.
- Operations: `cli.deviceStart/devicePoll/deviceLookup/approveDevice/denyDevice`,
  `cliToken.list/revoke`; migration 0110 (`core_cli_device_codes`, `core_cli_tokens`, hashes only).
  The app approves codes at `/cli/connect`, where the person picks the scope.
- `browserOnly` on an operation: `invoke()` refuses it for a human on any surface but `app`
  (`test` too). Marked: spec/merge decisions, `approval.decide`, question answers, runner and CLI
  device approval, `runner.register`/`rotateKey`, and `killSwitch.set` with `on: false`.

**Merge queue (ADR 0330, spec 06)**
- Workflow **v4** (`WORKFLOW_VERSION = 4`): an approved merge enters `core_merge_queue` (migration
  0100) instead of merging; only the head is updated (GitHub's update-branch, accepted only as a clean
  merge of the default branch into the approved head), CI runs on it, then `pr.merge` lands it with
  the same approval. The review packet carries over (`sections.carriedFrom`).
- Operations: `mergeQueue.enter`, `.position`, `.list { projectId }`, `.update`, `.leave`.
  `pr.merge` / `pr.autoMerge` refuse a queued item that isn't the head. `workItem.get` has
  `mergeQueue { position, ahead }`; finish and cancel release the entry and wake the next head.
- A conflict or red CI at the head leaves the queue and goes back to build. The App has no
  `workflows` permission, so an update that brings in `.github/workflows/` changes is refused.

**Planning, the loop (spec 20, ADRs 0300, 0301, 0302, 0350)**
- Workflow **v5** (`WORKFLOW_VERSION = 5`): the spec stage is a planning session. `planning.start`
  queues a light `planning` job; each round waits for the agent's `planning.ready`
  (`planning-ready-<item>-<k>`, escalating open blocking questions on each question timeout), then
  the spec gate. Request changes → `planning.note` (a chat message from the approver, same
  session); approval or rejection → `planning.end`. Cancelling or finishing the item also ends it.
  v1–v4 keep V1's spec rounds and `planning_round`.
- The planning job's operations go over `/runner/v1/jobs/:id/planning`, scoped by the job and
  fenced by its lease: `question.ask/update/delete/reorder/focus`, `spec.revise`, `chat.reply`,
  `planning.news/wait/yield/ready`. People: `question.answer { note? }` (planning answers can be
  revised), `chat.send`, `planning.presence`, `planning.move` (Continue on another runner),
  `planning.get` (the Planning view). Live updates: `EngineApi.planningStream(workItemId)` (SSE from
  the work item's PlanningHub). `inbox.list` has `planning` (sessions with a first draft) and each
  runner's `light` pool.
- Runners report `capacity.light`; the scheduler places light jobs (triage, spec, planning) and
  heavy ones (build, verify) apart, pins a resume to its runner, and asks the oldest idle session to
  yield when the light pool is full. The host relays the harness's planning calls; the harness
  projects the planning MCP server and the hooks (`sf-runner --max-light`, default 6).
- `spec.commit` writes Assumptions, Coverage and Clarifications sections and keeps the provenance
  tags.
- The app's Planning tab is layout A (`components/planning.tsx`, logic in `lib/planning.ts`):
  questions (by kind, with a note; planning answers can be changed) | the spec (provenance chips,
  assumptions highlighted, what changed since the last revision, coverage, clarifications) | chat,
  with the gate bar, the session pill, Continue on another runner, full screen (F / Esc) and phone
  tabs. It re-reads `planning.get` on each Server-Sent Event from `/api/work/<id>/planning/live`
  and heartbeats `planning.presence`. The inbox shows "Planning is ready" cards.

## Next
R1 is built in three internal milestones ([`specs/README.md`](specs/README.md)):
1. **(a) Core loop**, one user and one repo: spec 01 first (everything builds on it), then 02 and 03
   in parallel, then 04; 15 and the (a) parts of 10–14 alongside. The security changes (job tokens,
   fencing, `factory/verify` pinning) are part of 03 and 04, not a separate track.
2. **(b) Orgs and multi-session**: the (b) parts of 10–14.
3. **(c) Decision domains, clarification and shared runners**: the (c) parts of 10–14.

First projects to run through the factory: crm (Relationship OS), software-factory (itself),
channel-manager.

## Open questions
Resolved by the review decisions (2026-11-11):
- Kill-switch scope (0006): per org and per project ([ADR 0044](adr/0044-kill-switch-scope.md)).
- How `.factory/` changes reach the control plane (0009): read from the default branch only, cached
  by SHA, refreshed by the push webhook ([ADR 0036](adr/0036-policy-from-the-default-branch.md)).
- What "small" means for skipping the spec (0013): the LLM triage judgement, logged with its reason.
- Mid-run local takeover (0021): the fencing token is bumped and the cloud run stops
  ([ADR 0035](adr/0035-lease-fencing-and-one-branch-per-run.md)).
- Runner push credentials (0025): per-job, repo-scoped App tokens ([ADR 0033](adr/0033-per-job-github-app-tokens.md)).
- Decision domains with no owner (0029): the project approver, as backup owner ([ADR 0042](adr/0042-one-question-object.md)).
- Client as org vs factory (0032): its own org ([ADR 0043](adr/0043-a-client-is-its-own-org.md)).
- Planning scope in v1 (0028): settled by the UI interview and ADR 0042.

Answered by V1-1 (core + engine):
- Job transport to runners (0016): pull, heartbeat then claim.
- Where the model-role map lives (0018): `packages/core/src/model-roles.ts`, overridable per project in `.factory/policy.json`.
- Lease length (0021): 10 minutes, renewed by heartbeat.

Still open:
- How review should work on the first projects (crm, software-factory, channel-manager).
- Cascade and depth limits (0006).
- Token usage reporting (0011).
- Project template tiers between `minimal` and `product` (0026).
- Whether holdout tests are committed after merge (0034).
- Whether harness subscription terms allow unattended or team use of a runner (0033).
- Whether `presets/` should be renamed now that "preset" is retired as a word.
- Speculative continuation past a gate: designed for (0007), not built in R1.

## Needs the human
- **The GitHub App's Setup URL**: `https://software-factory.zerobsai.com/integrations/github/setup`
  with "Redirect on update" on (GitHub → Settings → Developer settings → GitHub Apps →
  software-factory-zerobsai → General). Then Setup → **Connect GitHub**.
- **`RUNNER_CHANNEL_SECRET`** as a repo secret (`openssl rand -base64 48 | gh secret set RUNNER_CHANNEL_SECRET`):
  the deploy syncs it to `sf-engine`. Until then the runner channel answers 503.
- The GitHub App's settings (ADR 0231, `docs/deploying.md`): webhook URL
  `https://software-factory.zerobsai.com/webhooks/github` with the `GH_APP_WEBHOOK_SECRET`; permissions
  checks (write) and administration (read) on top of contents and pull requests; events pull request,
  check suite, check run, push, installation, installation repositories.
- At the bootstrap (V1 step 5): make `factory/verify` (App 5705909) a required check on `main`
  (command in `docs/deploying.md`). Not done yet on purpose: it fails every PR the factory didn't
  open, which would block the sessions still building V1. The repo ruleset confining App pushes to
  `factory/*` is applied (2026-11-11).
- The Mac mini set up as the first runner (tmux + Claude Code signed in; Orca not needed), with no `gh`, SSH agent or
  cloud credentials visible to the harness (ADR 0033).
- Pair the M5's runner once the app can register one: `pbpaste | local/runner-host/bin/sf-runner pair
  --runner-id r_… --key-stdin` (the launchd service is installed and waits, unpaired, until then).
- VAPID keys for web push as Worker secrets (spec 15).
