# Spec 09: Factory config in the app, workflows, and a factory that improves itself

**Read first**:
- [ADR 0370](../adr/0370-factory-config-lives-in-the-app.md) (config versions)
- [0371](../adr/0371-workflows-are-presets-over-typed-slots.md) (workflow slots)
- [0372](../adr/0372-agents-are-harness-neutral.md) (agents)
- [0373](../adr/0373-the-factory-improves-its-own-practice.md) (self-improvement)
- [0374](../adr/0374-the-adjudicator-earns-approval-in-shadow-mode.md) (adjudicator)
- the plan [`.kim/plans/2026-11-11-manage-factory-settings-in-the-ui.md`](../../.kim/plans/2026-11-11-manage-factory-settings-in-the-ui.md)
- the review [`docs/reviews/2026-11-12-config-and-workflows-review.md`](../reviews/2026-11-12-config-and-workflows-review.md)
- the mockups [`.kim/mockups/project-settings.html`](../../.kim/mockups/project-settings.html) and
  [`project-stages.html`](../../.kim/mockups/project-stages.html) (Workflows)

## Goal
People manage a project's factory config in the app, and the factory improves that config itself
within limits a person sets. Config becomes versioned rows instead of a file in git. Workflows add
steps to a fixed skeleton. The factory trials its own practice changes and keeps only the ones that
hold up.

This spec is built in four milestones, each its own PR.

## M1: Config versions and the Settings page

### Scope
- **Migration 0140:** `core_project_policies` gains `version`, `source`, `created_by`, `note` and
  `parent_version`. Each project's current git policy becomes version 1 (`sha` = `v1`, source
  `migrated`), and `core_projects.policy_sha` points at it.
- **`packages/core/src/policy/impact.ts`:** `policyImpact(old, new, floor)` returns each change with
  its class (`loosens`, `tightens` or `neutral`) and a sentence. The classes are:
  - **Gate:** `decide()` for every non-human actor × risk class, old against new. More permissive
    loosens.
  - **Approvers:** added loosens, removed tightens.
  - **`spec.requiredFrom`:** larger loosens.
  - **`protection.onRed`:** block → warn loosens; a required check removed loosens.
  - **Review packet:** a section removed loosens.
  - **Harness:** widened (bypass, allow rules, hosts) loosens.
  - **`modelRoles.review` changed** loosens.
  - **Anything else** changed and unclassified loosens.
- **Operations:**
  - **`config.get`** (read, member): the current version's document, its version number, author
    and time, and the last 50 versions with their notes and impact classes.
  - **`config.preview`** (read, member): validates a draft against the current version and returns
    `{valid, error, impact}`.
  - **`config.save`** (human, member): `{projectId, baseVersion, policy, note}`.
    - Refuses an invalid draft (`invalid_input`) and a stale base (`conflict`).
    - Its risk comes from `riskOf`: `self-modify` when the impact loosens, else `write`. A
      loosening save becomes a pending action for an approver, judged under the current version.
    - On apply, it writes version N+1 and points the project at it.
  - **`config.rollback`** (human, member): `{projectId, baseVersion, toVersion}`. Saves an
    earlier version's stored document as a new version (source `rollback`), with the same risk rule.
    `riskOf` reads the stored version, so the gate judges the real document.
  - **`config.export`** (read, member): the `.factory/` bundle `{ ".factory/policy.json": … }`.
  - **Import** is `config.save` with `source: "import"`: the app reads an exported bundle (or a bare
    `policy.json`) into the form, and the person checks the diff and saves it.
  - **Applying an approved loosening:** `approval.decide` on a `config.save` or `config.rollback`
    pending action applies it in the same call. A project-level gate has no Workflow to re-run it.
    The proposer stays the author, and a stale base is refused without deciding.
  - **`policy.resync`** becomes "import from repo": it reads `.factory/policy.json` at the default
    branch's head through the App, imports it as a new version, and refuses a missing or invalid
    file.
- **Git stops feeding the gate:**
  - `push.observe` no longer reads `.factory/policy.json`.
  - `project.create` imports the repo's file as v1 if there is one, else writes the template policy
    as v1.
  - `policy.proposeTemplate` and the Setup step's "Create policy PR" are removed.
  - `policy.sync` becomes human-only and writes a version. It is kept for tests and as a raw import
    path; unlike `config.save`, an invalid document it receives still becomes current and fails
    closed.
- **Pinning (ADR 0370 §5):** the gate in `invoke()` and the harness profile in `buildJob` use the
  stricter of the work item's recorded version and the current one. `riskOf` receives the resolved
  scope, the floor and the database, so a config save's risk depends on the current version.
- **App:** `/projects/$projectId/settings`, as in the mockup:
  - sections for Autonomy + overrides, Timeouts + backup owner, Throughput (WIP, default retry),
    Approvers, Review packet (show/hide + order) and Protection on main;
  - a save bar with the diff and the impact summary from `config.preview`, then Save;
  - a History list with Roll back;
  - Edit as JSON;
  - Export and Import.

  Setup's policy step and each project in Setup link to it.
- **Docs:**
  - AGENTS.md's policy rule.
  - `CONTEXT.md`: config version, impact summary.
  - `architecture.md`.
  - Amendments to ADRs 0009, 0036 and 0054.
  - This repo's `.factory/policy.json` stays only as the export of its v1.

### Acceptance criteria
1. After migration 0140, every project with a valid git policy has version 1 with the same document,
   and every existing test that reads the policy passes unchanged.
2. `config.save` with a valid tightening draft (for example a lower WIP limit) applies at once as
   version N+1, and the gate uses it on the next call.
3. A draft that loosens (Balanced → Autonomous, or an added approver) becomes a pending action of
   risk `self-modify`. The current version stays in force until an approver approves, and the
   approval applies exactly the drafted document.
4. An invalid draft is refused with the schema error, and nothing is written. A save on a stale
   `baseVersion` is a `conflict`.
5. `policyImpact` classifies each case listed in M1's scope, with a test per class. An unknown field
   change counts as loosening.
6. A push to the default branch that changes `.factory/policy.json` no longer changes the project's
   config.
7. `project.create` on a repo with no `policy.json` leaves the project with a valid v1. The Setup
   policy step is satisfied without a PR.
8. A work item created under v3 whose project moves to a looser v4 is still gated as v3. If the
   project moves to a stricter v4, it is gated as v5.
9. `config.rollback` to v2 writes a new version equal to v2's document. A rollback that loosens
   waits for an approver.
10. The Settings page saves, shows the impact summary before saving, lists History, and exports and
    imports. The app's API test covers `config.save` and `config.preview` through the server
    function.

## M2: Agents and workflow slots (Workflow v6)

### Scope
- **The policy document gains `agents` and `workflows`** (ADR 0371, ADR 0372). Both are optional,
  and an absent block means the built-in defaults.
  - **An agent** has `name`, `role`, `tier` (`standard` | `light`), `instructions`, `permissions`
    (`edit`, `allow`, `hosts`) and `requires`.
  - **A workflow** has `name`, `description`, `slots: { afterSpec, beforeVerify, afterVerify }`, a
    list of steps per slot, and `core` (the agent and extra instructions for triage, spec, build
    and verify).
  - **A step** is `{ id, kind: "work" | "gate", name, agent? | approvers?, instructions?, when?: { sizeAtLeast?, domain? }, onFail?: "sendBack" | "ask" }`.
- **Validation:**
  - Agent names must resolve.
  - A `work` step needs an agent, and a `gate` step needs a person or `approvers`.
  - Instructions are capped at 4 kB.
  - Agent permissions must fit inside the project harness and the stage-kind ceiling.
- **Triage picks the workflow.** Its result gains `workflow`, journaled with a reason;
  `workItem.setWorkflow` (human) changes it until build starts. The item records its workflow name.
- **Workflow v6** runs each slot's steps:
  - A `work` step enqueues a job with stage `step`, the agent's role and tier, and the step's
    instructions. Its result is `pass`, `sendBack` (with notes) or `ask`.
  - A `gate` step opens a pending action through `invoke()`.
  - Step names are `slot:<slot>:<index>:<id>`.
  - The default workflow is empty slots, which equals v5.
- **The runner contract:**
  - `JOB_STAGES` gains `step`.
  - The job's harness carries `tier` and the agent's compiled profile.
  - `harness-claude` compiles agent permissions, with the ceiling for stage kinds.
  - Core-step prompts stay in `apps/engine/src/workflow/prompts.ts`, and agent instructions are
    appended. Verify and reviewer prompts never get project text.
- **App:** a Workflows page (as in the mockup: the skeleton with its slots, a step editor, a
  workflow picker) and an Agents page. Both save through `config.save`. The work item detail shows
  the item's workflow and lets a person change it before build.

### As built (M2)
- **Work steps run as `verify`-stage jobs** (read-only, the verify harness profile), with
  `context.step` naming the workflow, slot and step. They don't use a new `step` job stage:
  `core_jobs.stage` has a CHECK constraint, and rebuilding that table is the migration that broke
  production in #42.
- **Migration 0141** adds `core_work_items.workflow` and `workflow_reason`, and `core_jobs.tier`.
  M3 moves to 0142 and M4 to 0143.
- **Agents** have `name`, `role`, `tier`, `instructions` and `requires`.
  - Their abstract permissions (narrowing the project harness) are deferred: work steps are
    read-only anyway, and the build agent keeps the project's build harness.
  - Work steps may not use an `implement` agent.
  - `core` takes only `build`: triage picks the workflow, so it can't have a workflow agent.
- **`workflow.gate`** is the gate step's operation.
  - `alwaysReview` on the operation makes `invoke()` send it to a person whatever the policy says.
  - `assignee` names the decider, who must be one of the project's approvers.
  - `workflow.record` journals each step's verdict, and each skip, for the timeline.
- **Triage** is told the project's workflows (`workflow: options`).
  - The item's workflow is fixed in `workflow: plan`, just before the build. A person may change it
    with `workItem.setWorkflow` until then.
  - An `afterSpec` send-back becomes the build's first note.
- **App:** `/projects/$projectId/workflows` holds the skeleton with its slots, the step editor, the
  workflow picker and the agents. The work item page shows the workflow, which can be changed
  until the build starts.

### Acceptance criteria
1. A project without `workflows` runs exactly as v5. v1–v5 replays are unchanged, and v5's step
   names are frozen in `workflow-versions.test.ts`.
2. A workflow with a `beforeVerify` work step runs it after build and before verify. Its `sendBack`
   returns the item to build with the step's notes, and counts against `retryLimit`.
3. A `gate` step creates a pending action for the named approver, and the item waits until it is
   approved. Its timeout goes to the backup owner.
4. A workflow can't remove the spec gate, verify or the merge gate. There is no field that could,
   and a document that tries is refused by the strict schema.
5. Triage's workflow choice is journaled. `workItem.setWorkflow` changes it before build and is
   refused after.
6. *(Deferred with agent permissions.)* An agent can't widen the harness: it has no permission
   fields, and work steps run with the verify profile.
7. A step condition `sizeAtLeast: medium` skips the step for small items, and records the skip.

## M3: Run usage and the improver

### Scope
- **Usage:**
  - `harness-claude` reads `usage` and the model from stream-json's `result` and `assistant`
    messages.
  - The handback carries `usage: { model, harness, inputTokens, outputTokens, cacheReadTokens }[]`
    plus wall-clock times.
  - Migration 0142 adds `core_run_usage`.
  - Runs record the runner and the config version.
- **Gate reasons:** send-back, edit and reject prompt for a short reason (optional), stored on the
  decision.
- **Metrics by version:** `metrics.configVersions` (read) returns, per project, workflow and
  version:
  - items, verify pass rate, send-backs per item, gate edit rate;
  - median time per step;
  - tokens per item by model class;
  - for API-key runners, estimated cost.
- **The improver.** A scheduled job (the engine cron, daily) runs per project when
  `improve.enabled`:
  - It reads the signals, then drafts at most one candidate practice change with evidence.
  - A `review`-role critic vetoes or passes it.
  - If `policyImpact` says it is practice, it starts a **trial**: the draft applies to the next N
    items of one workflow only.
  - Otherwise it becomes an inbox proposal for a person.
  - Migration 0142 adds `core_config_trials`.
  - Trial items run under the candidate version; others run under the current one.
- **Trial resolution:** after N items, or after 14 days with fewer, it compares outcomes against the
  previous version's items of the same workflow and model class.
  - If outcomes are no worse, it is **promoted**: the candidate becomes the current version, with
    source `improver`.
  - Otherwise it is **disabled**: rolled back, recorded with the evidence.
  - Within equal outcomes, the cheaper and faster version wins.
- **Limits:**
  - At most 3 changes per project per week, and one open trial per workflow.
  - A runner whose owner opted out never takes trial items.
  - A weekly digest card in the inbox lists each change, why it was made, and a revert button
    (`config.rollback`).
- **App:** Settings gains a Self-improvement section (on/off, trial size, weekly cap). There is a
  trials list with status and evidence, the digest card, and the gate reason prompt.

### As built (M3)
- **Usage** travels as a `usage` artifact, not a new table.
  - `harness-claude` sums tokens per model from the session transcript's assistant messages (each
    message counted once), plus the wall time.
  - `runner-orca` uploads it as `{kind: "usage", harness, entries, wallMs}`, and core stores it in
    `core_artifacts`.
- **Migration 0142** adds `core_config_trials` and `core_work_items.trial_id`.
- **Drafting is rule-based in V1, not a model.** It is `draftCandidate` in `packages/core/src/improve.ts`:
  - **Effectiveness:** when the same check fails verify in at least 2 of the last 10 items, it adds
    a line to the builder's instructions.
  - **Efficiency:** when the last 5 items all passed first time, it moves the builder to the
    `light` tier.
  - A change disabled in the last 30 days isn't drafted again.
  - The critic is deferred along with model drafting: there's no free-form draft to critique yet.
- **Practice only is enforced in code** (`practiceOnlyError`): the candidate may change only agents'
  tier and instructions, or add the default **Builder** (an `implement` agent of that name builds
  items whose workflow names no builder). Anything else, or anything `policyImpact` calls loosening,
  is refused.
- **Trials are per project, one at a time.** Items join a running trial when they're created
  (`trial_id`, pinned to the candidate version) until it has `trialSize`.
- **`config.trial.resolve`** compares the trial's finished items with as many earlier items on the
  base version (`evaluateTrial`):
  - It **promotes** when items are done at least as often, with no more failed rounds.
  - It **disables** otherwise, and also if the config moved on.
  - It decides on what it has after 14 days.
  - A person can stop a trial, and revert a promoted one (`config.rollback` to its base).
- **Self-improve and the gate:** the engine's hourly pass (`runImprover`) acts as `self-improve`.
  Under Cautious, that actor's writes go to review, so a trial becomes a proposal for a person.
- **Turning `improve.enabled` on** is loosening, so it waits for an approver.
- **The digest** is "The factory's changes" in Settings (`config.trials`), not an inbox card.
- **Deferred:**
  - `metrics.configVersions` (the comparison lives in each trial's outcome);
  - the gate-reason prompt (the notes on send-back, request-changes and approval already carry
    reasons);
  - a runner owner opting out of trials.

### Acceptance criteria
1. A completed run has usage rows with model, harness and tokens, taken from a recorded stream-json
   fixture.
2. `metrics.configVersions` splits outcomes by version and compares like with like.
3. Given recorded send-backs that share a reason, the improver drafts an instruction change. The
   critic's veto stops it.
4. A practice candidate runs as a trial on exactly N items of its workflow. Items of other workflows,
   and items on opted-out runners, use the current version.
5. A trial whose items have no more send-backs or failed verifies than the previous version's is
   promoted. One that is worse is rolled back automatically, and both outcomes are journaled with
   their evidence.
6. A candidate that `policyImpact` classifies as loosening, or can't classify, is never trialled. It
   becomes an inbox proposal.
7. The weekly cap and the one-trial-per-workflow limit hold. `improve.enabled: false` stops new
   candidates.
8. The digest lists the week's changes, and its revert applies `config.rollback`.

## M4: The adjudicator

### Scope
- `adjudicator: { gates: { spec?: "shadow" | "active", step?: "shadow" | "active" } }` in the
  policy. Enabling it is policy-tier, so it goes through a person.
- **For each pending spec gate or `gate` step of an enabled kind:** a `review`-role job records the
  verdict it would give (`approve` | `defer`) and its reason, without blocking the gate.
- **Agreement:** `adjudicator.stats` (read) gives precision on approvals over the last 20 decisions,
  per kind.
- **Active mode:** at least 20 decisions at ≥95% precision, and a person has set the kind to
  `active`. The adjudicator approves via `gate.decide` as actor `self-improve`, and defers
  everything else to the person.
  - It falls back to shadow automatically if precision drops below the bar.
  - It never takes merge, deploy or self-modify.
- **App:** Settings shows the agreement per kind and the switch. The gate card shows the shadow
  verdict.

### As built (M4)
- **Migration 0143** adds `core_adjudications`: one row per gate asked about, with the mode it was
  asked in, its job, its verdict, and whether it acted.
- **No Workflow change.** The engine's minute cron (`runAdjudicator`) does the work:
  - It asks `adjudicator.request` about open spec gates (`spec.accept`) and gate steps
    (`workflow.gate`) in projects that enable that kind. That queues a read-only `verify`-stage job
    on the item, role `review`, with `context.adjudicate`.
  - Once the job hands back, it calls `adjudicator.record`.
  - Acting as `self-improve`, an approval goes through `decidePending`, so the waiting Workflow
    carries on as it would for a person.
- **Precision** is measured on the last 20 of its verdicts that a person also decided.
  - In active mode, every fifth approve is still left to the person, so precision stays measured.
  - If it falls below the bar, the kind goes back to `shadow` as a new config version.
- **Going active** is a loosening save: it waits for an approver. Approving it, or saving it, is
  refused until the record is there (`requireAdjudicatorEarned`).
- **Kinds:** `adjudicatorKind` admits only spec gates and gate steps. Merge, `deploy` and
  `self-modify` are excluded by kind and by risk.
- **App:** Settings has an Adjudicator section with a mode per kind and its record, and offers
  `active` only once it's earned.
- **Deferred:**
  - the shadow verdict on the gate card (it's in the record and the timeline);
  - notifying approvers when it falls back to shadow (the fallback is a versioned config change
    with a note).

### Acceptance criteria
1. In shadow mode, verdicts are recorded and never change a gate's outcome.
2. The switch to active is refused below 20 decisions or 95% precision.
3. Active, it approves an eligible spec gate and journals its reason. A `defer` leaves the gate to
   the person.
4. It can't decide a merge gate or a `self-modify` pending action. This is enforced in `invoke()`,
   with a test.
5. A drop below the bar returns the kind to shadow and notifies the approvers.

## Out of scope
- Eval replay of a candidate before its trial (ADR 0027): next, after V1.
- Parallel steps and arbitrary branching in workflows.
- Org-wide shared agents and workflow templates across projects.
- A second harness (Codex): ADR 0372 makes room, but V1 ships the Claude adapter only.
