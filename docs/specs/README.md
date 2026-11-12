# Specs

Each spec is one buildable slice. Format (borrowed from Relationship OS): **Read first / Goal /
Scope / Out of scope / Acceptance criteria**. The acceptance criteria are the definition of done,
and the factory's own planning stage writes specs in this same format.

**Rules every spec with a setup or onboarding screen carries in its acceptance criteria**
([incident 2026-11-11-bootstrap](../incidents/2026-11-11-bootstrap.md)):
- **Onboarding must never ask users for ids the system can fetch.** Installations, repos, branches
  and keys come from the provider's own flow (install redirect, picker, device login), never a text
  field.
- Every value a setup screen writes has an update operation, and a save that leaves the entity
  degraded is refused or shown on the entity, never only in a toast.
- Any text a person carries from one component to another is specified verbatim, and both ends are
  tested against it. Better: don't make them carry it. (This folder was
`docs/stages/` until 2026-11-11; "stage" now means only a step in a work item's pipeline.)

| # | Spec | Depends on |
| --- | --- | --- |
| [00](00-scaffold.md) | Scaffold (this repo's skeleton) | — |
| [01](01-operations-and-store.md) | Operations, invoke pipeline, work-item store, audit journal, outbox, leases with fencing | 00 |
| [02](02-work-item-workflow.md) | CLI/chat intake, the work-item Workflow, triage, spec gate, questions | 01 |
| [03](03-runner-contract-and-orca.md) | Runner contract, signed channel, runner host, `runner-orca`, `harness-claude`, job tokens, scheduler | 01; the `spikes/` runner work |
| [04](04-verify-and-pr.md) | Verify, holdout tests, review packet, PR through the GitHub connector, `factory/verify` check | 02, 03 |
| [05](05-attach-a-pull-request.md) | Attach an outside PR (a local session's or a person's) to a work item: verify on its head, the merge gate, `/attach` | 04 |
| [06](06-merge-queue.md) | The merge queue: approved merges land one at a time per project (Workflow v4) | 04 |
| [09](09-factory-config-in-the-app.md) | Factory config in the app (versions, Settings), workflows and agents (v6), run usage and the improver, the adjudicator — four milestones | 01, 04, 06 |
| [07](07-cli.md) | The `sf` CLI: see and act on work from a terminal; gate decisions stay in the browser | 01 |
| [08](08-runner-auto-update.md) | Runners update themselves to the deployed commit, when idle, with rollback | 03 |
| [10](10-r1-sign-in-and-org-switcher.md) | R1: sign-in and the org & account switcher | 01 |
| [11](11-r1-new-work.md) | R1: New work | 02, 10 |
| [12](12-r1-inbox.md) | R1: Inbox (grouped by project, runner health line) | 02, 10 |
| [13](13-r1-work-item-detail.md) | R1: Work item detail | 02, 10 |
| [14](14-r1-review-packet.md) | R1: Review packet (the merge gate) | 04, 13 |
| [15](15-r1-notifications-backpressure-and-metrics.md) | R1: web push, WIP backpressure, early metrics | 01, 03, 12 |
| [20](20-planning-loop.md) | Planning M1: the loop (a live session on a runner, hooks, questions, living spec, chat, light pool) | 02, 03, 13 |
| [21](21-planning-visuals.md) | Planning M2: mockups, option cards, live controls, canvas, pinned comments | 20 |
| [22](22-planning-system-designs.md) | Planning M3: system designs and `.kim/` write-back | 21 |
| [23](23-triage-questions-and-critic.md) | Planning M4: triage questions, the readiness check and the spec critic | 20 |
| [24](24-planning-splits.md) | Planning splits a work item | 20 |
| [25](25-verify-drift-check.md) | Verify checks drift from the spec | 04 |
| [51](51-verify-from-the-factorys-own-evidence.md) | Verify decides from evidence the factory produced: the tests-intact guard, checks run by the runner host on the head SHA, criteria Proven only by executed evidence | 04, 25, 09 |
| [30](30-runner-local-without-orca.md) | runner-local: agents in tmux on the host, status from hooks, no Orca (piece 1 of the hosts plan) | 03 |
| [31](31-watch-and-steer-runs.md) | Watch and steer runs from the dashboard: the Live tab (transcript, terminal), `run.steer` for the runner's owner (piece 2 of the hosts plan) | 30 |
| [32](32-claude-accounts-on-a-host.md) | Claude accounts on a host: several per host, manual switching on the host or from Setup, credentials never leave the host (piece 3 of the hosts plan) | 30 |
| [33](33-container-per-job.md) | A container per job: Docker, only the job's workspace mounted, an egress allowlist, every stage `bypassPermissions` (piece 4 of the hosts plan) | 30 |
| [34](34-linux-hosts.md) | Linux hosts: the runner as a systemd user service, Linux paths, the harness sandbox and doctor checks on Linux, the install path (piece 5 of the hosts plan) | 08, 30 |
| [35](35-web-terminal.md) | A web terminal in the dashboard: the job's tmux pane in the Live tab through a Durable Object relay, the owner types and others watch, every attach journalled (piece 6 of the hosts plan) | 30, 31 |
| [36](36-sprites-sandboxes.md) | Sprites sandboxes: a fresh sprite per job made by the owner's runner host, the egress policy, the pane bridged to the sprite, the result back as a git bundle (piece 7 of the hosts plan) | 30, 33, 35 |
| [37](37-chat-ui-stream-json.md) | A chat UI on a stream-json session: a second session mode beside tmux, the Chat view on the Live tab, takeover by `claude --resume` (piece 8 of the hosts plan) | 30, 31 |
| [38](38-runner-updates-without-draining.md) | Runner updates without draining on every deploy: keep claiming until idle, caps at 30 and 60 minutes, `minRunnerCompat`, `RUNNER_SHA` from the deploy | 08 |
| [39](39-runner-host-readopts-live-jobs.md) | The runner host re-adopts its live jobs after a restart, so an update needs no idle moment (spec only) | 30, 38 |
| [40](40-desktop-app.md) | The desktop app (Electrobun): the client door, desktop devices with Touch ID presence proofs, `apps/desktop`, the website shrinks to auth | 07, 08 |
| [60](60-mobile-app.md) | The phone app (Android first, Flutter): phone devices with attested Keystore keys and fingerprint proofs, pairing by QR or GitHub, push through FCM, policy approval on the phone, `apps/mobile`, a build plan in small PRs | 40, 09, 26, 50 |
| [41](41-desktop-shell-and-look.md) | The desktop shell and look: slice 1 of the approved UI design (toolbar, org rail, sidebar, nested lists, status bar, tokens), the existing screens restyled; later slices listed | 40 |
| [50](50-projects-backlog-and-release.md) | Projects, repositories, backlog and release: a project has zero or more repositories, work starts in a backlog and is released, the factory pulls queued items by priority under an active limit, "waits for" links, a project runs one workflow | 05, 06, 09 |
| [wi-1](wi-1-let-s-also-make-it-so-work-items-can-hav.md) | Work item attachments (picker, drag-and-drop, paste; R2; runs read them) | 01, 03, 13 |
| [wi-4](wi-4-let-s-improve-the-event-log-so-it-s-usef.md) | A readable event log: one pure module (`packages/timeline`) words each audit entry for the dashboard's timeline and `sf timeline` | 07, 13 |

Specs 01–04 together are the **MVP backend slice**: CLI/chat intake → triage → implement (Claude
Code via `runner-orca`) → verify (review packet) → PR in one repo. Specs 10–15 are UI release
**R1** ([`docs/ui-plan.md`](../ui-plan.md)). The MVP's "simple web inbox" is spec 12.

## R1 milestones
R1 keeps everything planned (orgs, multi-session, decision domains, clarification, shared runners)
but is built in three internal milestones
([review decisions](../reviews/2026-11-11-review-decisions.md), ADR 0031 as amended). Each R1
spec splits its scope and acceptance criteria by milestone.

| Milestone | What | Specs |
| --- | --- | --- |
| **(a) Core loop** | End to end for one user and one repo: intake → triage → spec gate → build → verify → review packet → merge, with web push, WIP backpressure, inbox grouped by project, runner health line and early metrics. Usable as soon as it lands. | 01–04, 15; the (a) parts of 10–14 |
| **(b) Orgs + multi-session** | Orgs, the switcher, "All factories" across signed-in accounts, per-session actions. | the (b) parts of 10–14 |
| **(c) Domains, clarification, shared runners** | Decision domains routing questions and approvals, guests and clarification views, runner sharing allowlists and requester-first fallback. | the (c) parts of 10–14; spec 03 criterion 4 |

Mockups for every R1 screen are in [`.kim/mockups/`](../../.kim/mockups/); the design system is in
[`.kim/design-system/`](../../.kim/design-system/).

## Planning
Specs 20–25 make planning work the way kim does ([ADR 0300](../adr/0300-planning-is-a-live-session-on-a-runner.md), plan in [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)). Build them in order: 20 → 21 → 22, then 23; 24 and 25 can run alongside after 20 and 04.
[Spec 26](26-planning-loop-to-kim.md) fixes what 20 built weaker than kim and adds the design's steering; it comes before 21 ([audit](../reviews/2026-11-12-planning-against-kim.md)).

## Workflows from stage types
[Spec 52](52-workflows-from-stage-types.md) is a design for later: workflows built from built-in
stage types and defined per org, skills and autopilots, the generic review packet and a reconciler
([ADRs 0510–0514](../adr/0510-workflows-are-ordered-stages-of-stage-types.md)). Don't build it until
its "When to start" holds.
