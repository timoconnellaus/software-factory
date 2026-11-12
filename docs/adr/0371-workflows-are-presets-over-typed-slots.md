# ADR 0371: Workflows are presets over typed slots in a fixed skeleton

Status: accepted, 2026-11-12 (interview and [review](../reviews/2026-11-12-config-and-workflows-review.md)).
Spec [09](../specs/09-factory-config-in-the-app.md) M2. Amends [ADR 0005](0005-hybrid-coordinator.md),
[ADR 0006](0006-work-item-workflows.md) and [ADR 0053](0053-workflow-versioning.md).

## Context
The pipeline is fixed in the engine: triage → spec → spec gate → build → verify → merge gate → merge
queue. The owner wants named workflows ("Ship a feature", "Fix a bug") whose steps hand to an agent
or a person, mainly so the factory can improve its own process (ADR 0373).

A fully declared step graph run by an interpreter would make the gates data, which the standing
rules forbid. It would also cost a lot in Workflow determinism and versioning.

## Decision
1. **The skeleton stays code** (Workflow v6). The skeleton is triage → spec (when sized) → spec gate
   → build → verify → merge gate → merge queue.
2. **It has three typed slots:** `afterSpec`, `beforeVerify` and `afterVerify`. A slot holds an
   ordered list of steps. A step is one of two kinds:
   - **`work`**: hands to an agent (ADR 0372), with instructions. Its verdict is advisory: `pass`,
     `sendBack` (to build, which counts against the retry limit) or `ask` (a question to a person).
   - **`gate`**: hands to a person (a named user or `approvers`, the backup owner on timeout), and
     is enforced as a pending action through `invoke()`.
3. **A workflow is a named preset**: per slot, a list of steps, each with an optional condition
   (size at least, or decision domain touched).
   - Workflows only add steps. The spec gate (from size and `spec.requiredFrom`), verify and the
     merge gate always come from the skeleton.
   - The default workflow is empty slots, which behaves exactly like Workflow v5.
4. **Triage picks the workflow** from the project's list, falling back to the default. This is a
   binding foreman decision, logged with its reason (ADR 0005's table). A person can change it until
   build starts. A wrong pick can only add steps, never skip a gate.
5. **Core-step prompts stay in code.**
   - A project may append instructions to core steps through their agents.
   - Project text never reaches the verify or reviewer prompts.
6. **A work item pins its workflow's shape** at creation, as part of its config version (ADR 0370).
   Step names derive from the slot and the step's index, so replay is deterministic.

## Consequences
- Every invariant is structural; there is no validator to get wrong.
- v1 to v5 instances drain unchanged. v6 adds the slot loop, and its step names are frozen in
  `workflow-versions.test.ts`.
- Parallel steps and branches beyond conditions are out of scope.

> Amended 2026-11-12 (spec 09 M2, as built): work steps run as `verify`-stage jobs (read-only).
> Gate steps go through `workflow.gate`, which carries `alwaysReview` so `invoke()` asks a person
> even when overrides would allow it. `core` names only the build agent: triage picks the
> workflow, so it can't take an agent from one.
