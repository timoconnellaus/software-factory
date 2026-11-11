# ADR 0039: Per-project evidence policy

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
Review packets carry transcripts, logs and screenshots. For a client app (for example one holding
health data) those can contain the client's data, and storing them in Cloudflare is a data
residency decision the client should make.

## Decision
- Each project has an **evidence policy** in `.factory/`: which kinds of evidence (transcript,
  logs, screenshots, diff) may leave the runner and be stored by the control plane, how long they
  are kept, and whether screenshots must use seeded test data.
- Evidence the policy keeps local stays on the runner; the packet shows that it exists and where.
- A client org sets its own floor for evidence ([ADR 0043](0043-a-client-is-its-own-org.md)).
- The default for a personal project is to store everything for 90 days.

## Consequences
- The review packet must render with some sections marked "kept on runner".
