# ADR 0503: Skills are shared by the org and attached where they are used

Status: accepted, 2026-11-12 (the owner's addition to the workflow design; design
`docs/design/factory-ui/FactorySkills.html` on PR #61). Not built: spec
[52](../specs/52-workflows-from-stage-types.md) § Skills. Amends [ADR 0372](0372-agents-are-harness-neutral.md)
and narrows [ADR 0373](0373-the-factory-improves-its-own-practice.md) §1 for skills.

## Context
How the team does one thing ("write a migration", "resolve a merge conflict") is repeated in agent
instructions, lost after incidents, or missing. Multica's "skills the whole team shares" is the
reference: written once, followed by every agent that needs it.

## Decision
1. **A skill** is instructions (SKILL.md) plus optional files, versioned, owned by the org.
2. **It attaches at three levels**: an agent (always), a stage in a workflow (optionally on a
   condition: paths touched, size, domain), and a stage type (its built-in skills, in code). The org
   may `extend` or `replace` a built-in skill, except on the Checks reviewer, where only `extend` is
   allowed and every change is policy.
3. **A run's set is the union**, resolved purely when the job is built: built-ins (with org
   overrides), then the agent's, then the stage's matched ones. A path condition with nothing known
   yet includes the skill. The run records the versions it loaded.
4. **Harness-neutral projection.** The job carries references; the runner fetches the bodies over
   the channel; the harness adapter projects them (Claude Code: skills in the run's own settings
   directory; otherwise appended to the prompt), declared as the `skills` capability.
5. **Edits.** The factory may propose an edit; only a person accepts one. Every accepted edit is a
   trial (ADR 0373's lifecycle) unless the person applies it at once. Edits to the reviewer's skills
   are `self-modify`.
6. Skills are pinned with the org config version, so an item's skills don't change under it.

## Consequences
- ADR 0373's practice tier no longer covers self-applied skill edits.
- Skill files run only inside the job's harness sandbox, with no extra permission.
- The projection touches `harness-claude` and the runner host (the hosts session's area): new
  files and the smallest hook.
