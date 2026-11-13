# ADR 0510: Workflows are ordered stages of stage types, defined once per org

Status: accepted, 2026-11-12 (the owner's decision). Not built: spec [52](../specs/52-workflows-from-stage-types.md)
says how, and when to start. Amends [ADR 0371](0371-workflows-are-presets-over-typed-slots.md),
[ADR 0005](0005-hybrid-coordinator.md), [ADR 0370](0370-factory-config-lives-in-the-app.md),
[ADR 0372](0372-agents-are-harness-neutral.md) and ADR 0492 (a project runs one workflow, PR #69).

## Context
ADR 0371 kept one software skeleton in code and let projects add steps in three slots. That can't
run a Marketing project (brief, draft, preview the reel, post, measure), and it keeps the stage
names software's. Spec 50 already separates the fixed work-management states (backlog, ready,
queued, done) from a workflow's stages, and lists org-level workflows as a follow-up.

## Decision
1. **Three levels.** A workflow is an ordered list of stages. A stage is a lane on the board and an
   instance of a stage type with its own settings. A step is what happens inside a stage: agent
   work, a check, or a person's decision.
2. **Stage types are the plugins, and they are code.** Each has a typed contract: what it runs,
   what it consumes and produces (artifacts, bound to a digest), what evidence proves it done, its
   screen (a surface id), the capabilities and connectors it needs, its gate, its reversibility and
   its phase. A workflow only chooses types, orders them and configures them. No loadable
   third-party types.
3. **Two phases.** Shaping stages (before release) need a person, hold no build slot and don't count
   as work in progress. Delivery stages run after release. Backlog, release (Ready → Queued) and Done
   are the same for every item.
4. **Floors in code.** A person's decision is part of a stage type and can't be switched off by a
   setting. `validateWorkflow` refuses a workflow where an irreversible outside action (merge,
   publish, deploy) is not preceded by a required person's decision on the same artifact, where a
   repository merge isn't preceded by checks, or where a shaping stage could act outside or take a
   build slot (spec 52's F-rules). At run time the action needs an approved decision on the digest it
   acts on. `publish` joins `merge`, `deploy` and `self-modify` in `ALWAYS_REVIEW`.
5. **Loosening.** Removing or weakening a gate, widening its condition, broadening its decider, or
   removing a check is a loosening (`workflowImpact`, extending ADR 0370's `policyImpact`): a
   `self-modify` save that only a person can approve. Anything it can't classify loosens.
6. **Org-level.** Workflows and agents live in an **org config version** (ADR 0370's machinery). A
   project names one workflow (ADR 0492); a work item always uses its project's workflow and pins
   the definition when it enters its first stage. Project config keeps policy.
7. **Templates.** Workflow templates (Software, Marketing) and stage templates (a type with default
   settings) ship in code and are copied into the org to edit.
8. **Today's skeleton is the Software template.** Triage, planning, build, checks and merge become
   stage types; the three slots become positions; the slot steps become `agent-check` and `decision`
   stages. The template reproduces Workflow v6 exactly.

## Consequences
- ADR 0371's "every invariant is structural; there is no validator to get wrong" no longer holds:
  the floors are now a validator, tested rule by rule, plus run-time checks in the action
  operations and `invoke()`.
- The foreman (ADR 0005) picks routes within the pinned stage list instead of within a fixed skeleton.
- Spec 50's `STAGES` and `JOB_STAGES` stop being the list of stages; a stage type maps to a job kind.
- Spec 52's open questions were answered by the owner on 2026-11-12 (the note below and the spec's
  Decisions table); the build follows the spec's build plan.

> Amended 2026-11-12 (the owner's answers to spec 52's questions; the spec records each):
> - **Triage is a shaping stage** (Q1), the one shaping stage type that needs no person (`needsPerson: false`, allowed in shaping by its type's `shapingWithoutPerson`). Software's triage and planning are both shaping, as ADR 0493 already runs them.
> - **Tightening reaches running items** (Q3): a new version that only tightens moves running items onto it at their next stage boundary; gates added before an item's current stage don't apply to it retroactively.
> - **Release takes the current version** when the item's shaping stages are unchanged in it, otherwise the item is flagged for a person at release (Q4).
> - **Per-project settings live in the org workflow**, with a short list of allowed per-project overrides (Q5): the spec threshold, the retry limit, the review packet's sections, required checks. `autoApprove` (ADR 0515) is per workflow, **not** an override; its switch-off is a per-project hold. A loosening override is `self-modify`.
> - **Org admins edit an org workflow and approve its loosenings** (Q6, differs from the suggestion that owners approve).
> - **The all-projects board** shows columns by phase: Backlog, Shaping, Ready, Queued, Delivery, Done (Q7). **Small stages** (`agent-check`, `decision`) show inside the stage they belong to, not as lanes (Q8).
> - **An item is Done when it publishes**; measuring is a follow-up item (Q9).
> - **Attached PRs and incidents** run built-in workflows people can see and tighten, not loosen (Q10).
> - **Planning artifacts for a project with no repository** go to the factory's own storage (R2), attached to the item (Q15).
> - Rule 4's "an irreversible outside action is preceded by a person's decision" now allows that decision to be made by `autoApprove` for **merge** and **deploy** stages only ([ADR 0515](0515-merges-may-be-approved-automatically-dark-factory-mode.md), Q11 and Q20–Q23). The validator still requires the required gate; `autoApprove` is a typed setting of that gate, and the impact check treats it as a loosening.

> Amended 2026-11-13 (review of #139): a version that both tightens and loosens reaches a running item
> as its tightenings only, stage by stage; the loosenings never do. A tightening of a stage the item
> has already passed sends it back to verify (Workflow v17) rather than skipping it.
>
> Amended 2026-11-13 (review of #185): what an item runs is its pinned version with each adopted
> version folded in, in order (`org_config_adopted`); a later version is compared against that, so
> it never takes away a tightening the item adopted, and a list that can't be resolved fails closed.
> At the merge boundary only tightenings verify can act on (verify and the checks between the build
> and it) send the item back; tightenings of triage, spec or the build are journaled as passed.
> **Decided: no re-pin while the merge gate is open.** A tightening saved after the gate opened
> reaches the item only if it goes round again (sent back, withdrawn, a new head); the gate is not
> withdrawn for it. The person deciding the gate is the check at that point, re-verifying under them
> would discard a decision in progress for a change they can see on the org's workflow, and every
> boundary before the gate already applies tightenings. Dark factory mode (ADR 0515) re-checks its
> own conditions at merge, against the settings then.
>
> Amended 2026-11-13 (second review of #185): **a pinned workflow that can't be read fails closed.**
> An item whose pinned org version, or a version it adopted tightenings from, no longer resolves is
> never run under today's workflow: from Workflow v17 it parks with a question for a person ("this
> item's workflow version can't be read"), and agents and runners on it can't merge, deploy or
> change the factory. An adopted stage is judged by the agent of the version it came from (bound
> under a versioned name when the pinned version's agent of that name differs). Tightenings a
> version makes inside a stage it also loosens (a required check swapped for another) aren't
> applied: the project's approvers are told once per version, as they are when an item has taken
> tightenings from the most versions it takes (8). Only the item's Workflow re-pins it, and the
> boundary is the item's own stage. A decision gate a version adds while an item's merge gate is
> open is told to that gate's person on the item, not applied.
>
> Amended 2026-11-13 (third review of #185): the stop is in core, so it holds on **every Workflow
> row**, with no replay changed. While an item's pinned workflow (its org version, an adopted
> version, or the config it started under) can't be read, agents and runners on it may only read,
> ask, wait, end it, re-resolve its version and let a run already under way finish; anything else
> is refused (`workflow_unreadable`) and the first refusal puts one blocking question to its owner.
> A Workflow from v17 parks on that question (Check again / Stop) instead of ending, at its plan, at
> each re-pin and on any such refusal; earlier rows end failed before work starts.
>
> Amended 2026-11-13 (fourth review of #185): `factory/verify` is never posted as success for an
> item whose workflow can't be read, whoever finds it (a webhook, the cron, a release): `postVerify`
> posts a failing check that says why. The babysitter takes such an item out of the merge queue
> (sent back as withdrawn) and goes on with the items behind it. The owner's question is found
> again by its asker, not its wording; it is worded by the item's Workflow row (Check again / Stop
> where it parks, what happened and what to do where it ends), and the item's queued jobs are
> cancelled. A registry test pins every non-read operation that finds its item some other way.

