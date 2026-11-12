# ADR 0516: The workflow classifier is an allow-list

Status: accepted, 2026-11-12 (the coordinator's review of spec 52 PR (b)). Amends
[ADR 0510](0510-workflows-are-ordered-stages-of-stage-types.md) §5 and
[ADR 0370](0370-factory-config-lives-in-the-app.md) §3 for workflows.

## Context
`workflowImpact` decides whether a workflow save applies at once (neutral, tightening) or waits for an
org admin (loosening). A review found six edits it called neutral that weaken what a person or a
check sees: hiding review packet sections, moving a check before the work it checks, archiving and
re-adding a workflow without its gates, a stage type version bump, an exception while working out the
risk, and removing Triage (items then arrive unsized and miss the spec gate). Each was a rule written
as "loosens if …, otherwise neutral", so every case nobody thought of came out neutral.

## Decision
1. **Allow-list.** A change is neutral or tightening only if a rule says so; anything the classifier
   doesn't recognise is a loosening. In code (`packages/core/src/stages/impact.ts`):
   - a setting that differs and that the stage type's `impact()` returns nothing for loosens;
   - every stage removal loosens (a gate or check is gone, or what one depends on is);
   - an added stage tightens only if it is a check or gate that runs for every item; anything else
     added loosens;
   - **order**: every pair of stages both versions have keeps its order, or the save loosens;
   - a `when` change on a check or gate follows the condition rules; on any other stage it loosens;
   - a type version bump is compared through the type's own `migrate()`; a type without one, or a
     migration that fails, loosens;
   - only names, descriptions, the template reference, agent hand-offs and the settings each type
     names as practice (instructions, CI waits, retry limits, queue timing) are neutral.
2. **The review packet's `sections`.** Absent means every section. Setting a list where there was
   none, or dropping a section, loosens; only adding tightens; reordering is neutral.
3. **What a save is compared against.** The org's current version of that workflow id; else the last
   version archived under that id (archiving keeps it in the org config's `archived`); else the
   built-in floor, the Software workflow. A built-in copy is compared with the org's version, and
   must never be looser than the shipped built-in (refused); undoing the org's own tightening is a
   loosening an org admin approves (spec 52, working answer 5).
4. **Fail closed.** If working out a save's risk throws, the save is `self-modify`.
5. **Where.** Org config writes (`workflow.save`, `workflow.archive`, `workflow.createFromTemplate`,
   `agent.save`, `orgConfig.rollback`) are browser-only, human-only and org-admin-only, and an org
   config proposal is approved through `approval.decide` in the app only: never from the CLI, MCP, a
   desktop device (even with a presence proof) or any other token.
6. **A property test guards it.** Random workflow edits; for each one classified neutral or
   tightening, every gate, check, decider, evidence item, required check, section, the critic, the
   merge queue and the order of every checked or gated pair of the before version must still hold in
   the after version, for every built-in kind, size and domain.

## Consequences
- Some harmless edits now need an admin's approval (adding a build stage, reordering two work
  stages). That is the intended trade: an unnecessary approval is cheap; a silent loosening isn't.
- A stage type that adds a setting must classify it in `impact()`, or every change to it loosens.
- Archiving a workflow a project runs is refused from spec 52 PR (d), when projects run org
  workflows; until then no org workflow is in use.
