# Architecture decision records

Each ADR is `NNNN-slug.md` with Status, Context, Decision and Consequences. ADRs are never deleted: when a decision changes, amend it with a dated note.

Numbering: 0001–0099 is the scaffold and docs block (0033–0047 record the [review decisions](../reviews/2026-11-11-review-decisions.md)); 0048–0059 is the V1 core + engine build; 0230–0239 is V1 step 4 (verify + connector + incidents); 0280–0289 is the planning design; spikes use 0100–0199 (0100 runner contract and 0110 Workflow and gate are accepted and promoted here; 0120 auth is still proposed under `spikes/`). Claim a block in [`../parallel-work.md`](../parallel-work.md) before adding one.

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
| [0280](0280-planning-is-a-live-session-on-a-runner.md) | Planning is a live agent session on a runner, modelled on kim |
| [0281](0281-runner-capacity-has-heavy-and-light-pools.md) | Runner capacity has heavy and light pools |
| [0282](0282-spec-provenance-coverage-and-critic.md) | Specs carry provenance and coverage, and a critic reviews them before the gate |
| [0283](0283-a-planning-session-can-split-a-work-item.md) | A planning session can split a work item |
| [0284](0284-triage-scores-readiness-and-can-ask.md) | Triage scores readiness and can ask |
| [0285](0285-planning-artifacts-and-the-kim-folder.md) | Planning artifacts are stored in the factory and kept in `.kim/`; mockups render on a sandboxed origin |
| [0286](0286-verify-checks-drift-from-the-spec.md) | Verify checks drift from the approved spec |
