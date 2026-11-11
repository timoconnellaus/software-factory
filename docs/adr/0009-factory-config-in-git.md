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
