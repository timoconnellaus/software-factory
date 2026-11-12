# ADR 0492: A project runs one workflow

Status: accepted, 2026-11-12. Spec [50](../specs/50-projects-backlog-and-release.md). Amends
[ADR 0371](0371-workflows-are-presets-over-typed-slots.md) §4.

## Context
ADR 0371 lets triage pick a workflow per work item from the project's list, and a person change it
until build. The owner's model is simpler: a project runs one workflow, and every item in it follows
that workflow. Workflows are meant to be defined once per org and reused by projects; today they
live in each project's config version.

## Decision
1. **The project's config names its workflow**: `workflow` (a name from the config's `workflows`, or
   null for the skeleton alone). It is part of the config version, so it is versioned, journaled and
   saved only through `config.save`.
2. **An item takes its project's workflow when it is pulled** (ADR 0491), with the config version it
   pins then. There is no per-item override: triage's `workflow` field is ignored, the Workflow's
   `workflow: options` step offers none, and `workItem.setWorkflow` is refused.
3. **Changing the project's workflow is checked like any config change.** `policyImpact` compares the
   gate steps of the old and new workflow; removing one is a loosening and so a person's change.
4. **Workflow definitions stay in the project's config for now.** Moving them to the org, defined
   once and chosen by projects, is a follow-up spec: it changes per-project config versions (ADR
   0370) and needs its own loosening rules.

## Consequences
- Workflow v6's step names don't change, so running instances replay unchanged. Items already past
  triage keep the workflow triage picked.
- The work item page's workflow picker goes away; the project's workflow is set in config.
