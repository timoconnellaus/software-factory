# ADR 0372: Agents are harness-neutral; the runner resolves the model

Status: accepted, 2026-11-12 (interview). Spec [09](../specs/09-factory-config-in-the-app.md) M2.
Amends [ADR 0017](0017-harness-adapters.md), [ADR 0018](0018-model-roles.md) and
[ADR 0023](0023-runners-owned-by-users-and-requester-routing.md).

## Context
Workflow steps hand to agents (ADR 0371). Jobs run on the requester's own runner and subscription
(ADR 0023). Today that is Claude Code; Codex and shared cloud runners are coming. So an agent can't
name a model or a harness: the same "Backend Agent" must run on any runner that can take the job.

## Decision
1. **An agent** is a named profile in the project's config version, holding:
   - a **model role**;
   - a **tier**: `standard` (the default) or `light`;
   - instructions;
   - **abstract permissions**: read-only or can edit, extra hosts and extra allow rules;
   - the capabilities it requires.

   It never names a model id or a harness.
2. **The model is resolved per runner.**
   - The project may state preferences per harness and role/tier (`modelRoles`, extended with tier
     keys such as `implement.light`).
   - A runner may declare its owner's map and caps, for example "no top-tier model for other
     people's work". The owner's caps win over the project's preferences.
   - The job carries the role, tier and resolved model, and the run records the harness and model
     actually used.
3. **Permissions narrow, never widen.**
   - The project's `harness` block is the ceiling.
   - An agent may only narrow it.
   - Stage kinds have a ceiling in code: triage, spec and verify agents never get
     `bypassPermissions` or write rules.
   - The harness adapter compiles abstract permissions into its own settings.
4. **Every project gets built-in agents** for the core steps (Triage, Planner, Builder, Reviewer),
   matching today's stage defaults. Today's per-stage `harness`, `requires` and `modelRoles` keep
   working as the agents' defaults.

## Consequences
- ADR 0018's open question (where the role map lives) is answered: defaults in code, preferences in
  the project's config, caps on the runner.
- The improver (ADR 0373) changes tiers and preferences, never model ids, and compares runs like for
  like using the recorded harness and model.
- V1 implements the Claude adapter only. The runner-side owner map and caps are declared through
  the runner contract's capabilities when a second harness exists.

> Amended 2026-11-12 (spec 09 M2, as built): agents have no permission fields yet. Work steps run as
> read-only `verify`-stage jobs with the verify harness profile, and the build agent keeps the
> project's build harness. So an agent can't widen anything, and narrowing comes later. The tier
> is resolved at claim time from the job's `tier` (`resolveModel(role, modelRoles, tier)`), and the
> `light` defaults are in `model-roles.ts`. The runner-side owner map and caps wait for a second
> harness.

> Amended 2026-11-12 ([ADR 0510](0510-workflows-are-ordered-stages-of-stage-types.md), [ADR 0513](0513-skills-are-shared-by-the-org-and-attached-where-used.md), spec 52, not built yet): agents move to the org and are reused across workflows. An agent gains `skills`, always attached; the harness adapter projects a run's skills.
