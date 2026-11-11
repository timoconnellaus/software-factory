# ADR 0020: Verification defaults and the review packet

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Review overload is a core pain. An approver should be able to decide on a PR from one page.

## Decision
- Verification defaults: tests, lint and typecheck; CI green; an independent reviewer on a different
  model; visual evidence (screenshots from a runner with the `browser` capability, Orca in v1); and
  each acceptance criterion checked one by one.
- Every PR gets a **review packet**. Its sections are configured per project in `.factory/`
  (`reviewPacket.sections`): verdict row, what changed, criteria + evidence, reviewer notes,
  screenshots, risk flags, inline diff (collapsed), deploy preview link.
- A required `factory/verify` check and branch protection apply to every PR, whatever its source.

## Consequences
- Projects can override the defaults but not drop below the floor ([ADR 0008](0008-autonomy-presets-and-floor.md)).

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): verification is less of a closed loop: **holdout acceptance tests**
> ([ADR 0034](0034-holdout-acceptance-tests.md)) join the defaults; `factory/verify` is **pinned to
> the App and bound to the head SHA**, and relies on CI the cloud can read
> ([ADR 0037](0037-factory-verify-pinned-and-sha-bound.md)); the packet in the app **is the merge
> gate** and links to the GitHub PR ([ADR 0041](0041-in-app-review-packet-is-the-merge-gate.md));
> what evidence may be stored follows the project's **evidence policy**
> ([ADR 0039](0039-per-project-evidence-policy.md)); the deploy preview link waits for preview
> environments ([ADR 0045](0045-preview-environments-later.md)).

> Amended 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)): the review packet gains a **Drift** section comparing the build with the approved spec, and the merged spec gets an "As built" note ([ADR 0306](0306-verify-checks-drift-from-the-spec.md)).
