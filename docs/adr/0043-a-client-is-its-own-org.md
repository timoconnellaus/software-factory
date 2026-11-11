# ADR 0043: A client is its own org

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
[ADR 0032](0032-scope-and-isolation.md) left open whether a client gets its own org or a factory
inside the owner's org.

## Decision
- **Each client is its own org**, with its own members (the client's people as guests or members),
  its own GitHub App installation, its own floor and its own evidence policy
  ([ADR 0039](0039-per-project-evidence-policy.md)).
- Runners are shared into a client org only explicitly, through the owner's allowlist
  ([ADR 0038](0038-runner-sharing-is-an-owner-allowlist.md)).
- Factories stay as the layer between org and project.

## Consequences
- Resolves ADR 0032's open question.
- Working across clients relies on the "All factories" view across orgs ([ADR 0024](0024-identity-orgs-and-multi-session.md)).
