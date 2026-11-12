# ADR 0008: Autonomy presets and the floor

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Different projects deserve different autonomy: a side project can auto-merge dependency bumps, a
client repo cannot. Borrowed from Relationship OS's Cautious, Balanced and Autonomous presets.

## Decision
- Each project picks a **preset** in its `.factory/` config and may override it.
- The global factory config sets a **floor** that can only tighten what a project allows.
- Merge, deploy and self-modify are `alwaysReview`: they always go to an approver, whatever the preset.
- A malformed or missing policy fails closed.
- Loosening policy is a human-only operation. Agents cannot configure policy.

## Consequences
- Policy is evaluated in the gate ([ADR 0004](0004-invoke-pipeline-and-gate.md)).
- Projects show each resolved value with its source: preset, `.factory/` or floor.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): vocabulary: a **preset** of this kind is now called an **autonomy policy** (shipped ones:
> Cautious, Balanced, Autonomous). The repo-practice bundles are **project templates**
> ([ADR 0026](0026-repo-practice-via-presets.md)). The floor is unchanged. A client org has its own
> floor ([ADR 0043](0043-a-client-is-its-own-org.md)). Policy is read from the default branch only
> ([ADR 0036](0036-policy-from-the-default-branch.md)). Spike ADR 0110 asks whether an unknown
> policy name should deny every call; this ADR's "fails closed" answers yes.

> Amended 2026-11-11 (V1 step 4, [ADR 0230](0230-check-only-incident-fixes-auto-merge.md)): one exception to "merge always needs a person": a factory incident's fix that only **adds** checks under `.factory/checks/` and regression cases under `evals/regressions/` may merge through `pr.autoMerge` (risk class `check-merge`) once CI and `factory/verify` are green on its head, and only in a project whose `.factory/policy.json` opts in. Every shipped autonomy policy denies `check-merge`; the floor still applies.

> Amended 2026-11-12 ([ADR 0353](0353-the-factory-improves-its-own-practice.md), spec 08 M3): "agents cannot configure policy" still holds for **policy** (what's allowed). The factory may change **practice** (how work is done) itself, as trials with automatic rollback. Loosening stays human-only. The adjudicator ([ADR 0354](0354-the-adjudicator-earns-approval-in-shadow-mode.md)) may approve some gates once it has earned it in shadow mode, never merge, deploy or self-modify.
