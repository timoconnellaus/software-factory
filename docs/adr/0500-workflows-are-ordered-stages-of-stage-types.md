# ADR 0500: Workflows are ordered stages of stage types, defined once per org

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
- The open questions in spec 52 are the owner's to answer before the build.
