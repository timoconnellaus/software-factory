# Architecture decision records

Each ADR is `NNNN-slug.md` with Status, Context, Decision and Consequences. ADRs are never deleted: when a decision changes, amend it with a dated note.

Numbering: 0001–0099 is the scaffold block; spikes use 0100+. Claim a block in [`../parallel-work.md`](../parallel-work.md) before adding one.

| ADR | Title |
| --- | --- |
| [0001](0001-build-our-own-factory.md) | Build our own factory |
| [0002](0002-cloudflare-control-plane.md) | Cloudflare control plane |
| [0003](0003-operations-registry.md) | Operations registry is the one API |
| [0004](0004-invoke-pipeline-and-gate.md) | The invoke() pipeline and gate |
| [0005](0005-hybrid-coordinator.md) | Hybrid coordinator: state machine owns gates, foreman picks the route |
| [0006](0006-work-item-workflows.md) | One Workflow per work item |
| [0007](0007-human-gates-are-pending-actions.md) | Human gates are pending actions |
| [0008](0008-autonomy-presets-and-floor.md) | Autonomy presets and the floor |
| [0009](0009-factory-config-in-git.md) | Factory config lives in git |
| [0010](0010-gatekeepers-for-intake-and-outbound.md) | Gatekeepers for intake and outbound |
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
| [0026](0026-repo-practice-via-presets.md) | Repo practice, installed via presets |
| [0027](0027-evals.md) | Evals |
| [0028](0028-planning-built-in.md) | Planning is built in |
| [0029](0029-decision-domains.md) | Decision domains |
| [0030](0030-deferred-from-v1.md) | Deferred from v1 |
| [0031](0031-dashboard-stack-and-inbox-first.md) | Dashboard stack and inbox-first home |
| [0032](0032-scope-and-isolation.md) | Scope and isolation |
