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
   - an added stage tightens only if it is a check or gate that runs for every item **and acts on
     nothing outside the factory**; anything else added loosens. An added stage whose type is
     `irreversible` or `reversible-outside` (a merge, a publish, a deploy, a Checks stage that opens a
     PR) is an **action gained**, a loosening even though it has a gate: a workflow that never merged
     must not gain a merge with no approval, and the tighten-only Attached PR built-in can't gain a
     second merge;
   - **order**: every pair of stages both versions have keeps its order, or the save loosens;
   - a `when` change on a check or gate follows the condition rules; on any other stage it loosens;
   - a type version bump is compared through the type's own `migrate()`; a type without one, or a
     migration that fails, loosens;
   - only names, descriptions, the template reference, agent hand-offs and the settings each type
     names as practice (instructions, CI waits, retry limits, queue timing) are neutral.
   - **who judges is policy** (Q16): a stage type that judges the work says so (`judges`). Checks'
     judge is the factory's own reviewer (`judges: "code"`): it takes **no org agent** (floor F10,
     refused on save), and org skills reach it only as additions a person approves (spec 52 PR (f)).
     An agent check's judge is its named agent (`judges: "agent"`): handing it to another agent, or
     changing that agent (`agent.save`, now judged like a workflow save), loosens. Other agent
     changes stay neutral.
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
   the after version, and the after version must take **no outward or irreversible action** (an
   action, its risk, a connector) the before version didn't, for every built-in kind, size and domain.
7. **The document is bounded.** An org config is at most 256 KiB as stored, and a workflow's stage
   instructions together at most 16,000 characters; a save over either is refused. `orgConfig.get`
   parses only the current version: each version's impact is recorded when it is written
   (`core_org_configs.impact`), and the history lists versions by that metadata. The document keeps
   the last version of at most 200 archived workflows; the 201st archive is **refused** (re-adding or
   replacing an archived workflow frees a place). It never drops the oldest, which would let that id
   be re-added compared only against the Software floor.

## Consequences
- Some harmless edits now need an admin's approval (adding a build stage, reordering two work
  stages). That is the intended trade: an unnecessary approval is cheap; a silent loosening isn't.
- A stage type that adds a setting must classify it in `impact()`, or every change to it loosens.
- Archiving a workflow a project runs is refused from spec 52 PR (d), when projects run org
  workflows; until then no org workflow is in use.

## Amendment, 2026-11-13: org config is decided on the desktop too (ADR 0610)
Decision 5's "browser-only ... in the app only ... never from a desktop device (even with a presence
proof)" is loosened by the owner's decision of 2026-11-13 ("Move everything to the desktop app now
and accept the risk until the helper exists"): the org config writes and an org config proposal's
`approval.decide` are also decidable on the `desktop` surface with a presence proof for that exact
call ([ADR 0610](0610-everything-but-sign-in-moves-to-the-desktop-app.md), which states the risk).
Still never from the CLI, MCP, a phone, a runner, an agent or any other token. The classifier, and
who may decide (an org admin), are unchanged.
