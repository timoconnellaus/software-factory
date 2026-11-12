# ADR 0515: Merges (and later deploys) may be approved automatically: dark factory mode

Status: accepted, 2026-11-12 (the owner's answers to spec [52](../specs/52-workflows-from-stage-types.md)'s
questions 11, 20, 21, 22 and 23). Not built: spec 52's build plan, PR (e). **Supersedes**
[ADR 0230](0230-check-only-incident-fixes-auto-merge.md). Amends [ADR 0005](0005-hybrid-coordinator.md),
[ADR 0008](0008-autonomy-presets-and-floor.md), [ADR 0373](0373-the-factory-improves-its-own-practice.md),
[ADR 0374](0374-the-adjudicator-earns-approval-in-shadow-mode.md), [ADR 0510](0510-workflows-are-ordered-stages-of-stage-types.md)
and AGENTS.md's "merge, deploy and self-modify always go to a human".

## Context
Until now merge, deploy and self-modify were `ALWAYS_REVIEW`: a person decides every one, with one
narrow exception, an incident's check-only fix (ADR 0230). Spec 52 asked whether to keep that
exception. The owner's answer: make it a general, optional mode in which the factory merges its own
work, "dark factory mode". In the owner's words it is "really just auto approving merges. So it's
just a config option. Nothing special."

## Decision
1. **A setting on the gate, not a new mechanism.** The workflow's merge stage (a `publish` stage
   with `action: merge`, spec 52) has `autoApprove`, **off by default**. It is a setting of the
   **workflow**, never a per-project override (the owner, confirmed after the questions): a project
   runs one workflow, so a project that wants it uses a workflow that has it on. Later the deploy
   stage gets the same setting. It is ordinary versioned config, written only
   through operations (ADR 0370).
2. **Turning it on is a loosening.** `workflowImpact` classifies `autoApprove` off → on, a raised
   limit, a narrowed path list or a lowered bar as `loosens`, so the save is `self-modify`: an org
   admin makes it and an org admin approves it (spec 52 question 6). No agent, the improver, the
   adjudicator or an autopilot can turn it on or loosen it: `self-modify` stays person-only, and
   `policyImpact` treats anything it can't classify as a loosening.
3. **What it does.** The merge gate still opens as a pending action with risk `merge`, which stays in
   `ALWAYS_REVIEW`. When the setting is on, the Workflow decides that pending action itself, as a new actor
   `auto-approve` (code, not an agent: its one permission is deciding a pending `merge` or `deploy`
   action whose verdict passed), with the reason "auto-approved: every condition held" and the facts it checked, but
   **only when all of these hold**, each evaluated in code (`autoApproveVerdict()` in `packages/core`,
   called by the Workflow), never in a prompt:
   1. **Every check passed and every acceptance criterion is proven by a check that ran** on the head
      SHA (spec 51, ADR 0501). The review packet's verdict is `pass` and `factory/verify` is green on
      that SHA.
   2. **Tests intact**: the tests-intact guard passed on that SHA (ADR 0500): no tests deleted or
      weakened.
   3. **The adjudicator approved the merge, and has earned that right on this project**: it is
      active for the `merge` gate kind in this project under ADR 0374's bar (at least 20 shadow
      verdicts on this project's merge gates, at least 95% precision on approvals, switched on by a
      person), and it approved this SHA.
   4. **The change is inside the limits set**: at most `maxChangedLines` changed lines and
      `maxFiles` files, measured by GitHub's compare of the default branch with the head SHA (never
      the runner's report), and no path matching `forbiddenPaths`.
   5. **The item's risk is low**: no changed path matches the **risk paths**, and the item is not a
      change to the factory itself (rule 5).
   **It only approves.** What happens after an approval (landing the merge, keeping main green,
   following the deploy) belongs to the babysitter that merges approved work (its own spec, block
   AP, ADRs 0580–0589, working title "the Deliver stage"), and is the same whether the approval came
   from a person or from this setting. This ADR specifies no merge mechanics.
   Anything else, or any error reading a fact, goes to a person exactly as today. Every verdict,
   approve or not, is journaled with each condition's result, and the merge gate's card shows which
   condition sent it to a person.
4. **Where the limits and risk paths live, and the defaults.**
   - `autoApprove` is the merge stage's setting: `{ enabled: false, maxChangedLines: 200, maxFiles:
     10, forbiddenPaths: [], riskPaths: [] }`. Raising a limit or removing a path loosens; lowering a
     limit or adding a path tightens.
   - **The risk-path floor is in code** (`RISK_PATHS` in `packages/core/src/policy/auto-approve.ts`).
     The workflow's `riskPaths` and `forbiddenPaths` add to it and never remove from it. The floor:
     migrations (`**/migrations/**`, `**/*.sql`), auth (`**/auth/**`, `**/*auth*.*`), billing
     (`**/billing/**`, `**/payments/**`), secrets and environment files (`**/.env*`, `**/.dev.vars*`,
     `**/wrangler.*`), CI and repository settings (`.github/**`), factory policy (`.factory/**`), and
     lock files changed without a matching manifest change (`pnpm-lock.yaml` and the like). A path
     list is globs over repository paths; matching is case-insensitive.
   - For the factory's own repository, the workflow it runs should add the code that enforces
     policy to `riskPaths` (`packages/core/src/policy/**`, `apps/engine/src/workflow/**`,
     `AGENTS.md`, `docs/adr/**`). That is a workflow setting, not a floor rule, because other
     repositories don't have those paths.
5. **What it never covers.** Changes to the factory itself always need a person: any `self-modify`
   save (policy, autonomy, the floor, a workflow or its stages, agents, skills on the judge), and any
   merge whose diff touches `.factory/` (the risk-path floor). The adjudicator still never decides
   `self-modify`.
6. **Merge and deploy.** It covers merges now, and deploys once the workflow has a deploy stage with
   a health check after it (spec 52's later build). Until then only merges are auto-approved. It does
   not cover other outside actions (`publish` to a social connector): those always go to a person.
7. **It switches itself off, per project.** The setting is per workflow, but trouble happens in one
   project, so the switch-off is a **per-project hold**, never an edit to the shared workflow. The
   factory writes a new project config version (source `auto-approve`, a tightening, like the
   adjudicator's fallback in ADR 0374) with `autoApproveHold: { since, reason, evidence }`, and while
   a hold is set no merge in that project is auto-approved, whatever its workflow says. It does so
   when any of these happen in a project whose workflow has it on:
   - a factory incident or a production incident is opened on the project;
   - a merge it approved is reverted on the default branch (a revert commit or PR naming its SHA);
   - CI goes red on the default branch's head after one of its merges, before the next green run.
   It then puts a card in the inbox for the project's approvers: what went wrong, the merges it
   approved since the last green, and **Lift the hold**. Lifting it is a person's project config save
   and a loosening, so an org admin makes and approves it (rule 2). Other projects on the same
   workflow are not affected.
8. **The old exception goes.** ADR 0230's `pr.autoMerge` and the `check-merge` risk class are
   replaced by this setting: an incident's check-only fix merges with no person only when the mode is
   on and rules 3–5 hold, like any other change (in the owner's words, "where it merges too"). The
   `check-merge` class stays readable in old audit rows; no shipped policy allows it and the Workflow
   stops calling `pr.autoMerge` from the version that adds this setting.

## Consequences
- AGENTS.md's rule becomes: merge and deploy go to a person unless the workflow's `autoApprove`
  setting, which only a person can turn on, holds for that exact SHA; self-modify always goes to a
  person.
- The adjudicator gains `merge` as a gate kind it shadows (ADR 0374). Its approval is necessary and
  never sufficient: the other conditions are checked in code. ADR 0374's "every fifth approval is
  still left to a person" applies to merges too, so its precision stays measured.
- Items an autopilot filed are eligible like any other: the autopilot never merges (ADR 0514), the
  item's own workflow does, under these conditions.
- Stricter than ADR 0230 for incident fixes: they now also need the adjudicator's earned approval.
  No project has opted into `check-merge` on main, so nothing in flight loses it.
- A green CI, a passing packet and the adjudicator can all be wrong together. The size and path
  limits, the code-owned risk paths and the self-switch-off bound the damage; reverting is a normal
  change.
