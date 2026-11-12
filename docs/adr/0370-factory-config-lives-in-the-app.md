# ADR 0370: Factory config lives in the app, as versions

Status: accepted, 2026-11-12 (interview
[`.kim/plans/2026-11-11-manage-factory-settings-in-the-ui.md`](../../.kim/plans/2026-11-11-manage-factory-settings-in-the-ui.md),
[review](../reviews/2026-11-12-config-and-workflows-review.md)). Spec [09](../specs/09-factory-config-in-the-app.md).
**Supersedes** [ADR 0009](0009-factory-config-in-git.md) and [ADR 0036](0036-policy-from-the-default-branch.md),
and amends [ADR 0054](0054-factory-policy-file.md).

## Context
ADR 0009 kept factory config in git, as `.factory/` on the default branch (ADR 0036), so that it
was reviewable and versioned, and so that an agent couldn't loosen its own policy from its diff.

The owner wants to manage config in the app, and wants the factory to improve its own config
without a person approving every change (ADR 0373). Under git, every change is a PR, a work item, a
verify run and a merge. The review found most of the risk in that path:
- push webhooks applied out of order;
- an invalid policy reaching `main`, which halts the project, including work already running;
- settings PRs conflicting with each other;
- a validator that only exists as a CI check.

Trials and one-click rollback, which self-improvement needs, are cheap with versioned rows and
awkward as commits.

## Decision
1. **A project's config is a sequence of versions in D1**, written only through operations.
   - A version holds the policy document (today's `projectPolicySchema`, plus workflows and agents
     from ADR 0371 and ADR 0372).
   - Each version records its author, source (`app`, `import`, `migrated`, `improver`,
     `rollback`), a note and its parent version.
   - The project points at its current version. `core_project_policies` holds the versions, keyed
     `v<N>` in the old `sha` column so every existing reader keeps working.
2. **Saving validates first.** An invalid document is refused (`invalid_input`) and never becomes
   current. A save names the version it was edited from, and a stale base is a `conflict`.
3. **The impact summary is computed on the server.**
   - `policyImpact(old, new, floor)` diffs `decide()` over every actor and risk class, and compares
     approvers, gates, the harness, protection and the review packet.
   - Anything more permissive, and any change it can't classify, counts as **loosening**.
4. **A loosening save is `self-modify`**, so it waits for an approver as a pending action (ADR
   0007), judged under the **current** version's rules, never the proposed one.
   - Other saves are `write` and apply at once.
   - Any org member may save. The project may only tighten who approves a loosening; the minimum
     sits in the org floor.
5. **Pinning.** A work item records the version it was created under. Gate decisions and the
   harness profile use the **stricter** of that version and the current one, so tightening reaches
   running work and loosening never does. The Workflow's shape stays pinned to its version (ADR 0371).
6. **Export and import.** A version exports as a `.factory/` bundle (JSON). Importing a bundle is a
   save with source `import`. `.factory/checks/` stays in git: those are checks CI runs, and they
   change through PRs as before (ADR 0230).
7. **Git no longer feeds the gate.**
   - `push.observe` stops reading `.factory/policy.json`.
   - `project.create` imports the repo's `policy.json` as v1 if there is one, else creates the
     template policy as v1. No policy PR is needed.
   - Existing projects are migrated: their current git policy becomes v1, with source `migrated`.

## Consequences
- **Safer for agents.** Config operations are human-only (plus the `self-improve` actor for
  practice changes, ADR 0373). An agent has no path to them at all, which is stronger than ADR
  0036's "read from the default branch".
- **Halts go away.** "An invalid policy halts the project" can no longer happen. A version that is
  current is valid by construction.
- **What we lose:**
  - Config doesn't travel with a fork.
  - A config change isn't reviewed in the same PR as the code that needs it.
  - Evals don't run on config changes in CI for free; ADR 0373 adds a replay later.
- `policy.proposeTemplate` and the Setup "Create policy PR" step are retired, and `policy.resync`
  becomes "import from repo".
- AGENTS.md's "Policy is read from the default branch only; a diff to `.factory/` is self-modify"
  becomes "policy is a versioned app setting; a loosening save is self-modify".

> Amended 2026-11-12 ([ADR 0500](0500-workflows-are-ordered-stages-of-stage-types.md), spec 52, not built yet): workflows, agents, skills and autopilots move to an **org config version** with the same machinery (validation, impact summary, loosening as `self-modify`, rollback). Project config keeps policy and names its workflow.
