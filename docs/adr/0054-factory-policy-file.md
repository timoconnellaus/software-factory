# ADR 0054: `.factory/policy.json`: the project's autonomy policy file

Status: accepted, 2026-11-11 (V1 core + engine). Implements [ADR 0008](0008-autonomy-presets-and-floor.md),
[ADR 0009](0009-factory-config-in-git.md) and [ADR 0036](0036-policy-from-the-default-branch.md).

## Context
The gate needs a concrete policy per project, read only from the default branch.

## Decision
- One file, `.factory/policy.json`, validated by `projectPolicySchema` in `packages/core`
  (strict: unknown keys are an error):

  ```json
  {
    "version": 1,
    "autonomyPolicy": "balanced",
    "overrides": { "agent": { "outbound": "allow" } },
    "spec": { "requiredFrom": "medium" },
    "timeouts": { "gateHours": 72, "questionHours": 48 },
    "wipLimit": 5,
    "retryLimit": 2,
    "approvers": ["<github login>"],
    "backupOwner": "<github login>",
    "modelRoles": { "review": "<model>" },
    "requires": { "build": ["hooks"] },
    "reviewPacket": { "sections": ["verdict", "changed", "criteria", "reviewer", "risk", "diff"] }
  }
  ```
- The GitHub connector calls `policy.sync { projectId, ref, sha, content }` on every push to the
  default branch. A ref other than the default branch is recorded as ignored. Each SHA's text is kept
  (`core_project_policies`) and the project points at the newest; every audit row records the SHA.
- A missing or malformed file fails closed: every non-human call on the project is denied, and
  `workItem.create` refuses new work, until a valid one lands.
- `overrides` may loosen or tighten the shipped policy; the floor (`FACTORY_FLOOR`) only tightens;
  merge, deploy and self-modify always need a person whatever either says.
- Model ids may appear in `modelRoles` (config, not code); defaults live in
  `packages/core/src/model-roles.ts`, the one source file allowed to name a model (ADR 0018).

## Consequences
- The bootstrap step (V1 build plan, step 5) writes software-factory's own `.factory/policy.json`.
- `packages/sdk` can re-export the schema for project templates.

> Amended 2026-11-11 ([ADR 0270](0270-the-factory-launches-the-harness-and-verifies-it.md)): a
> `harness` field sets the harness per stage: `permissionMode` (`dontAsk | acceptEdits |
> bypassPermissions | plan`), extra `allow` rules and extra `allowedDomains` for the sandbox. It can
> only pick a mode and add to allowlists; the sandbox and the deny rules are fixed in
> `harness-claude`. The engine puts it on each job (`harness.profile`) from the default branch's policy.
