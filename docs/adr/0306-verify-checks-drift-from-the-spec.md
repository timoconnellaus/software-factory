# ADR 0306: Verify checks drift from the approved spec

Status: accepted, 2026-11-11 (planning interview; prior art: 8090's drift checks, Augment Intent's verifier).

## Context
The verifier checks the acceptance criteria one by one. A build can still drift from the spec's
scope (doing more, or doing it differently) while every criterion passes. Nothing records what was
actually built when it differs from the plan.

## Decision
- **Verify adds a drift section to the review packet.** It compares the diff with the approved
  spec's Scope and Out of scope, and lists:
  - work outside scope;
  - scope items with no matching change;
  - decisions the build made that the spec didn't.
- **Drift is a warning, not a verdict.** It doesn't fail `factory/verify` on its own. The project's
  evidence policy may make it blocking.
- **On merge, an "as built" note is appended to the spec** on the branch, recording accepted drift,
  so the spec in `docs/specs/` matches what shipped.

## Consequences
- Amends [ADR 0020](0020-verification-and-review-packet.md) (a new review packet section).
- Built in [spec 25](../specs/25-verify-drift-check.md).
