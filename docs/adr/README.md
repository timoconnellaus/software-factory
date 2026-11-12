# Architecture decision records

Each ADR is `NNNN-slug.md` with Status, Context, Decision and Consequences. ADRs are never deleted: when a decision changes, amend it with a dated note.

Numbering: 0001–0099 is the scaffold and docs block (0033–0047 record the [review decisions](../reviews/2026-11-11-review-decisions.md)); 0048–0059 is the V1 core + engine build; 0230–0239 is V1 step 4 (verify + connector + incidents); 0300–0309 is the planning design; spikes use 0100–0199 (0100 runner contract and 0110 Workflow and gate are accepted and promoted here; 0120 auth is still proposed under `spikes/`). Claim a block in [`../parallel-work.md`](../parallel-work.md) before adding one.

| ADR | Title |
| --- | --- |
| [0001](0001-build-our-own-factory.md) | Build our own factory |
| [0002](0002-cloudflare-control-plane.md) | Cloudflare control plane |
| [0003](0003-operations-registry.md) | Operations registry is the one API |
| [0004](0004-invoke-pipeline-and-gate.md) | The invoke() pipeline and gate |
| [0005](0005-hybrid-coordinator.md) | Hybrid coordinator: state machine owns gates, foreman picks the route |
| [0006](0006-work-item-workflows.md) | One Workflow per work item |
| [0007](0007-human-gates-are-pending-actions.md) | Human gates are pending actions |
| [0008](0008-autonomy-presets-and-floor.md) | Autonomy presets (now autonomy policies) and the floor |
| [0009](0009-factory-config-in-git.md) | Factory config lives in git |
| [0010](0010-gatekeepers-for-intake-and-outbound.md) | Gatekeepers (now connectors) for intake and outbound |
| [0011](0011-audit-journal-is-the-metrics.md) | The audit journal is the metrics |
| [0012](0012-outbox-and-notifications.md) | Outbox and notifications |
| [0013](0013-triage-sizes-the-spec-gate.md) | Triage sizes the spec gate |
| [0014](0014-runners-are-adapters.md) | Runners are adapters |
| [0015](0015-scheduler-runtime-pool-and-capabilities.md) | Scheduler, runtime pool and capabilities |
| [0016](0016-signed-runner-channel.md) | Signed runner channel |
| [0017](0017-harness-adapters.md) | Harness adapters |
| [0018](0018-model-roles.md) | Model roles, not model ids |
| [0019](0019-repo-shape-and-tooling.md) | Repo shape and tooling |
| [0020](0020-verification-and-review-packet.md) | Verification defaults and the review packet |
| [0021](0021-governed-local-sessions.md) | Governed local sessions |
| [0022](0022-mcp-surface.md) | MCP surface |
| [0023](0023-runners-owned-by-users-and-requester-routing.md) | Runners are owned by users; requester-first routing |
| [0024](0024-identity-orgs-and-multi-session.md) | Identity, orgs and multi-session |
| [0025](0025-github-app-per-org.md) | A GitHub App per org |
| [0026](0026-repo-practice-via-presets.md) | Repo practice, installed via presets (now project templates) |
| [0027](0027-evals.md) | Evals |
| [0028](0028-planning-built-in.md) | Planning is built in |
| [0029](0029-decision-domains.md) | Decision domains |
| [0030](0030-deferred-from-v1.md) | Deferred from v1 |
| [0031](0031-dashboard-stack-and-inbox-first.md) | Dashboard stack and inbox-first home |
| [0032](0032-scope-and-isolation.md) | Scope and isolation |
| [0033](0033-per-job-github-app-tokens.md) | Per-job GitHub App tokens; runners run without the owner's credentials |
| [0034](0034-holdout-acceptance-tests.md) | Holdout acceptance tests |
| [0035](0035-lease-fencing-and-one-branch-per-run.md) | Lease fencing tokens and one branch per run |
| [0036](0036-policy-from-the-default-branch.md) | Policy is read from the default branch only |
| [0037](0037-factory-verify-pinned-and-sha-bound.md) | `factory/verify` is pinned to the App and bound to the head SHA |
| [0038](0038-runner-sharing-is-an-owner-allowlist.md) | Runner sharing is an owner-only allowlist |
| [0039](0039-per-project-evidence-policy.md) | Per-project evidence policy |
| [0040](0040-web-push-and-wip-backpressure.md) | Notifications by web push, and WIP backpressure |
| [0041](0041-in-app-review-packet-is-the-merge-gate.md) | The in-app review packet is the merge gate |
| [0042](0042-one-question-object.md) | One Question object; interview sessions are views |
| [0043](0043-a-client-is-its-own-org.md) | A client is its own org |
| [0044](0044-kill-switch-scope.md) | Kill switch per org and per project |
| [0045](0045-preview-environments-later.md) | Preview environments later, never against prod data |
| [0046](0046-content-cut-from-v1.md) | Content is cut from v1 |
| [0047](0047-jev-injection-check-follow-up.md) | A Jev prompt-injection check on intake (follow-up) |
| [0050](0050-kysely-and-batch-guards.md) | Kysely for typed D1 access, and batch guards for atomic conditional writes |
| [0051](0051-operations-rpc-on-the-engine.md) | Operations run in sf-engine; sf-app calls them over RPC |
| [0052](0052-job-tokens-and-branch-confinement.md) | Minting job tokens, and confining pushes to the run branch |
| [0053](0053-workflow-versioning.md) | Versioning the work-item Workflow across deploys |
| [0054](0054-factory-policy-file.md) | `.factory/policy.json`: the project's autonomy policy file |
| [0055](0055-github-installations-are-org-records.md) | GitHub App installations are org records, connected through GitHub's install flow |
| [0056](0056-runner-device-login.md) | Runners connect by device login |
| [0230](0230-check-only-incident-fixes-auto-merge.md) | A factory incident's check-only fix may merge without a person (amends 0008) |
| [0231](0231-verify-verdict-and-the-github-connector.md) | The verify verdict, `factory/verify` and the GitHub App connector |
| [0240](0240-v1-app-sign-in-and-server-functions.md) | V1 app: GitHub-only sign-in for one user, and one allowlisted server function to the engine |
| [0241](0241-app-runs-next-to-d1-and-loads-pages-in-one-request.md) | sf-app runs next to D1, and a page loads in one request from a cached session |
| [0100](0100-runner-contract.md) | The runner contract (promoted from the spike) |
| [0110](0110-work-item-workflow-and-gate.md) | A Workflow per work item, gated through the operation pipeline (promoted from the spike) |
| [0250](0250-runner-host-pushes-and-harness-projection.md) | The runner host pushes; the harness gets a projected settings file and no credentials |
| [0260](0260-runners-attach-to-the-existing-checkout.md) | Runners attach to the machine's existing checkout of a repo, by canonical identity |
| [0270](0270-the-factory-launches-the-harness-and-verifies-it.md) | The factory launches the harness (its own permission mode, no user settings), sandboxes it, and verifies the live process |
| [0280](0280-protect-main-with-a-generated-ruleset.md) | The factory generates the default-branch ruleset; a person applies it; the factory verifies it (the App stays `administration: read`) |
| [0290](0290-an-outside-pr-is-attached-and-verified.md) | An outside PR is attached to a work item and verified (amends 0021 and spec 04 criterion 3) |
| [0300](0300-planning-is-a-live-session-on-a-runner.md) | Planning is a live agent session on a runner, modelled on kim |
| [0301](0301-runner-capacity-has-heavy-and-light-pools.md) | Runner capacity has heavy and light pools |
| [0302](0302-spec-provenance-coverage-and-critic.md) | Specs carry provenance and coverage, and a critic reviews them before the gate |
| [0303](0303-a-planning-session-can-split-a-work-item.md) | A planning session can split a work item |
| [0304](0304-triage-scores-readiness-and-can-ask.md) | Triage scores readiness and can ask |
| [0305](0305-planning-artifacts-and-the-kim-folder.md) | Planning artifacts are stored in the factory and kept in `.kim/`; mockups render on a sandboxed origin |
| [0306](0306-verify-checks-drift-from-the-spec.md) | Verify checks drift from the approved spec |
| [0310](0310-work-item-attachments.md) | Work item attachments: bytes in R2, uploads through an operation, safe serving, runs read them over the job channel |
| [0370](0370-factory-config-lives-in-the-app.md) | Factory config lives in the app as versions; validated before save, loosening is self-modify, export/import `.factory/` (supersedes 0009, 0036) |
| [0371](0371-workflows-are-presets-over-typed-slots.md) | Workflows are presets over three typed slots in a fixed skeleton (Workflow v6); work steps advisory, gate steps enforced |
| [0372](0372-agents-are-harness-neutral.md) | Agents are harness-neutral (role + tier, instructions, abstract permissions); the runner resolves the model |
| [0373](0373-the-factory-improves-its-own-practice.md) | The factory improves its own practice as trials with auto-rollback; policy stays with people |
| [0374](0374-the-adjudicator-earns-approval-in-shadow-mode.md) | The adjudicator earns gate approvals in shadow mode (≥95% precision), never rejects, never merge/deploy/self-modify |
| [0360](0360-runners-update-themselves-to-the-deployed-commit.md) | Runners update themselves to the deployed commit: when idle, fast-forward only, rolled back by a wrapper if the new code doesn't start (amended by 0520) |
| [0520](0520-runners-keep-claiming-while-an-update-waits.md) | Runners keep claiming while an update waits: the desired version is the last runner-code commit (`RUNNER_SHA`), caps at 30 and 60 minutes, and only a `RUNNER_COMPAT` bump drains at once; the compatibility rule |
| [0380](0380-runner-local-tmux-and-hook-status.md) | Runners run agents in tmux without Orca (`runner-local`, runner-orca deleted); status from Claude Code hooks; checkouts from configured dirs |
| [0420](0420-linux-hosts-run-the-runner-as-a-systemd-user-service.md) | Linux hosts run the same runner as a systemd user service (linger, `KillMode=process`, the shared self-update wrapper); per-platform deny lists; doctor checks bubblewrap and socat |
| [0450](0450-a-stream-json-session-mode-with-a-chat-view.md) | A stream-json session mode beside tmux (per runner, the `chat` capability), events from the structured output, a chat view, takeover by `claude --resume` (`run.takeover`) |
| [0480](0480-a-sprite-per-job-provisioned-by-the-owners-host.md) | A sprite per job (Sprites, Fly.io), provisioned by the owner's runner host with its own Sprites token: a fresh sprite per job (no create-from-checkpoint), the toolchain provisioned at the image's pin, egress by Sprites' network policy ending in a deny-all, the pane bridged to the sprite's TTY, the result back as a git bundle, the host pushes |
| [0430](0430-a-container-per-job.md) | A container per job (Docker): a self-contained job repo with only the job's history, no home or host credentials, an egress proxy with the stage's allowlist, every stage `bypassPermissions`, the launch check inside the container |
| [0490](0490-a-project-is-not-a-repository.md) | A project is not a repository: `core_repositories` (backfilled one per project, project ids unchanged), zero or more per project, an item uses one, config stays per project |
| [0491](0491-work-starts-in-a-backlog-and-is-released.md) | Work starts in a backlog and is released: backlog, ready, queued; `workItem.release` (agents only where config allows); the pull by priority under `activeLimit`, respecting "waits for" links |
| [0492](0492-a-project-runs-one-workflow.md) | A project runs one workflow (config `workflow`); triage no longer picks and there is no per-item override; org-level workflows are a follow-up |
| [0493](0493-shaping-stages-run-before-release.md) | Shaping stages run before release: `workItem.shape` starts the Workflow for triage and interview planning while the item is `shaping` (no slot); Workflow v7 waits for `release-<item>`; the pull wakes it |
| [0390](0390-the-desktop-app-is-the-daily-ui.md) | The desktop app is the daily UI and the runner's supervisor |
| [0391](0391-the-client-door-desktop-devices-and-presence.md) | One client door; desktop devices decide gates with a presence proof |
| [0392](0392-the-website-shrinks-to-auth.md) | The website shrinks to auth, links go through a trampoline |
| [0460](0460-the-desktop-shell-and-look.md) | The desktop shell and look: a `hiddenInset` window, sections as route layouts with a nested list, tabs/pins/org as this Mac's view state, the look as `packages/ui` tokens with a desktop-only mapping, real data only |
| [0530](0530-the-client-door-carries-the-web-terminal.md) | The client door carries the web terminal: `GET /client/v1/terminal/<item>/<run>` for desktop tokens, the same attach as sf-app's route, the token kept in the main process, the terminal view shared from `packages/client` |
| [0400](0400-watch-and-steer-runs-from-the-dashboard.md) | Watch and steer runs from the dashboard: `run.steer` (runner owner only, journalled), a held `steer` call on the channel, `message` events from the transcript, `run.live` polled |
| [0440](0440-a-web-terminal-relayed-through-a-durable-object-per-job.md) | A web terminal relayed through a Durable Object per job: the host connects outbound with a one-use ticket from a held `terminal` call, browsers attach through `run.terminal.attach` (owner types, others watch, enforced in the relay), tmux control mode on the host |
| [0410](0410-claude-accounts-live-on-the-host.md) | Claude accounts live on the host (a config dir or a token each); the owner switches the active one by name, on the host or from the dashboard; usage limits are surfaced, never rotated |
| [0340](0340-a-cli-for-people-gates-stay-in-the-browser.md) | A CLI for people: device login, read/write tokens, `/cli/v1` on sf-engine; gate decisions are browser-only, enforced in `invoke()` |
| [0350](0350-how-the-planning-loop-is-wired.md) | How the planning loop is wired: one planning call on the channel scoped by the job, a host relay for the harness, the log's id as the cursor, held waits, yields and pinned resumes, pools, the PlanningHub, Workflow v5 |
| [0470](0470-planning-steering.md) | How people steer the planning agent: news every 2 s, no gate on stale news, a person's word takes the spec back from the gate, interrupt / stop / pause, finish alone, steers in the record |
| [0471](0471-people-edit-the-plan.md) | People edit the plan and comment on its parts: an edit is a plan version by a person that the planner must keep word for word; it may record the answers an edit settles; comments are chat messages anchored to plan lines |
| [0472](0472-planning-mockups-in-sandboxed-frames.md) | Planning mockups live in D1 by revision and render in sandboxed frames: `srcdoc`, `allow-scripts` only (an opaque origin), a CSP first, a `postMessage` protocol; controls are CSS variables, `data-plan-*` attributes and text slots |
| [0330](0330-the-factory-runs-its-own-merge-queue.md) | The factory runs its own merge queue per project: approved merges land one at a time, the head is updated by GitHub's update-branch and the approval carries over a clean update (Workflow v4) |
| [0320](0320-factory-branches-stay-mergeable.md) | Factory branches merge the default branch before a build; a PR that can't merge goes back to build, and CI that never reports asks a person (Workflow v3) |
| [0540](0540-the-phone-app-is-flutter-in-apps-mobile.md) | The phone app is Flutter in `apps/mobile` (outside pnpm and Turborepo, its own CI); operation types generated from the registry's zod schemas; shared canonical-JSON vectors; hub socket in the foreground, push in the background; only captures queue offline; a signed APK with in-app updates |
| [0541](0541-phone-devices-keystore-keys-and-fingerprint-proofs.md) | Phone devices: a biometric-bound, per-use Keystore key checked by key attestation; pairing by QR (the offer is the approval) or GitHub in the browser; the ADR 0391 presence proof with a fingerprint; one-tap answers and send-back on the phone; amends 0391 |
| [0542](0542-push-through-firebase-cloud-messaging.md) | Push goes through FCM as a data message of `{v, type, item}`, fanned out from `notifyClients`; the phone fetches content and posts it privately; the service account key is a Worker secret |
| [0543](0543-policy-changes-are-approved-on-the-phone-with-a-fingerprint.md) | Chat proposes a config change; a human approver approves it with `config.approve`, whose proof binds the base version and the proposal's digest; amends 0370 |
| [0510](0510-workflows-are-ordered-stages-of-stage-types.md) | Workflows are ordered stages of built-in stage types, defined once per org; floors in code (spec 52, not built) |
| [0511](0511-a-reconciler-runs-the-stage-list.md) | Proposed: a reconciler (a pure function from a D1 snapshot to the next action, on events and a tick) runs the stage list |
| [0512](0512-the-review-packet-is-artifact-evidence-and-decision.md) | Proposed: the review packet is an artifact, its evidence and a decision, all bound to one digest |
| [0513](0513-skills-are-shared-by-the-org-and-attached-where-used.md) | Skills are shared by the org and attached to agents, stages and stage types; the factory proposes edits, a person accepts |
| [0514](0514-autopilots-file-work-they-never-ship-it.md) | Autopilots file work on a trigger; they never merge, deploy or change config, and release only where policy allows |
| [0500](0500-the-factory-guards-the-tests.md) | The factory guards the tests: deleted, skipped or weakened tests, new suppressions and gate-file edits are found in code from the diff, go to a person, and block the check-only auto-merge |
| [0501](0501-the-factory-runs-the-checks-and-only-executed-evidence-proves-a-criterion.md) | The runner host runs the project's checks on the head SHA (through the adapter's `exec`), a failure goes back to the same session, and only executed evidence proves a criterion |
