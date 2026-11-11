# ADR 0009: Factory config lives in git

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Factory behaviour should be reviewable, versioned and portable, like code ("factory-as-code").

## Decision
- A global factory repo holds the presets and the floor. Each project commits a `.factory/` directory.
- The dashboard shows config read-only and links to the file in git. Edits happen in git.
- Self-improvement arrives as PRs to these files, each with an impact summary (for example
  "widens permissions: merge"). Anything that widens permissions waits for an approver.

## Consequences
- Config changes go through the same gate as code ([ADR 0021](0021-governed-local-sessions.md)).
- The control plane reads config from git; it caches but never owns it.
- Open question: how the control plane learns that `.factory/` changed (push webhook vs read on each run).

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): the control plane reads `.factory/` and the global autonomy policies **only from the
> default branch**, cached by commit SHA and refreshed by the push webhook; a diff to `.factory/` is
> self-modify ([ADR 0036](0036-policy-from-the-default-branch.md)). That resolves the open question.
> The global factory repo holds autonomy policies, project templates and the floor.
