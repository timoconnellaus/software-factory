# Spec 52: Workflows built from stage types

Status: **design, not to be built yet.** The owner decided the direction on 2026-11-12. This spec
says how it would be built. Build it only once the software line runs well (see "When to start").

Read first:
- ADRs [0500](../adr/0500-workflows-are-ordered-stages-of-stage-types.md) (the model),
  [0501](../adr/0501-a-reconciler-runs-the-stage-list.md) (the engine, proposed) and
  [0502](../adr/0502-the-review-packet-is-artifact-evidence-and-decision.md) (the packet, proposed), [0503](../adr/0503-skills-are-shared-by-the-org-and-attached-where-used.md)
  (skills) and [0504](../adr/0504-autopilots-file-work-they-never-ship-it.md) (autopilots).
- What they change: ADRs [0005](../adr/0005-hybrid-coordinator.md), [0006](../adr/0006-work-item-workflows.md),
  [0053](../adr/0053-workflow-versioning.md), [0370](../adr/0370-factory-config-lives-in-the-app.md),
  [0371](../adr/0371-workflows-are-presets-over-typed-slots.md), [0372](../adr/0372-agents-are-harness-neutral.md),
  and ADR 0492 (a project runs one workflow, in PR #69).
- Spec [09](09-factory-config-in-the-app.md) M2 (workflow slots, as built) and spec 50 (projects,
  backlog and release; PR #64 and PR #69), which already keeps the fixed work-management states
  apart from a workflow's stages.
- Code: `apps/engine/src/workflow/work-item.ts` (Workflow v6), `packages/core/src/policy/project-policy.ts`
  (`workflowSchema`, `SLOTS`), `packages/core/src/policy/impact.ts`, `packages/core/src/policy/gate.ts`
  (`ALWAYS_REVIEW`), `packages/runner-contract/src/types.ts` (`JOB_STAGES`, `CAPABILITIES`).
- The factory review on PR #61 (`docs/reviews/2026-11-12-factory-review.md`), item 4: the reconciler.

## The decision (owner, 2026-11-12)
- **Three levels.** A **workflow** is an ordered list of stages. A **stage** is a lane on the
  board (where an item is); each stage is an instance of a **stage type**, with its own settings. A
  **step** is what happens inside a stage: agent work, a check, or a person's decision.
- **Stage types are the plugins.** A stage type is code with a fixed contract: what it runs, what
  it produces (artifacts), what proves it is done (evidence), what screen it shows, what
  capabilities and connectors it needs, and whether a person must decide. A workflow only chooses
  types, orders them and configures them.
- **Two phases.** A workflow has **shaping** stages and **delivery** stages, with release between
  them. Shaping stages need a person, hold no build slot and don't count as work in progress. Only
  Backlog, release (Ready → Queued) and Done are the same for every item.
- **Templates.** A **workflow template** is a ready-made workflow to copy and edit (Software,
  Marketing). A **stage template** is a stage type with default settings.
- **Defined once per org, used by projects.** A project runs one workflow; a work item always uses
  its project's workflow. Agents (ADR 0372) are defined at the same level and reused across
  workflows.
- **What stays in code.** A person's decision is part of a stage type and is enforced by the
  engine. It is never a setting an agent can switch off. The engine refuses any workflow where an
  irreversible outside action (merge, publish, deploy) is not preceded by a person's decision.
  Removing or weakening a gate is a loosening, so only a person can do it.
- **Skills and autopilots** (added by the owner the same day). A skill is how the team does one
  thing, written once, owned by the org and shared by every agent; it attaches to an agent, to a
  step in a workflow (optionally with a condition), and stage types ship their own. An autopilot is
  a trigger, an agent, its skills, an instruction and an output target; what it files goes through
  the same backlog and workflow, it never merges or deploys, and it releases work only where policy
  allows.
- **Held back.** No loadable third-party plugins: stage types are built-in code in the repo, with a
  typed contract.

## What main has today
- **One fixed skeleton in code** (ADR 0371, Workflow v6): triage → spec (when sized) → spec gate →
  build → verify → merge gate → merge queue. Each work item is one Cloudflare Workflow instance that
  replays `run()` and matches steps by name (ADR 0006, 0053). Six versions share `runV1` with steps
  switched on by version; attached PRs take `runAttached`, chosen by kind.
- **Three slots** (`afterSpec`, `beforeVerify`, `afterVerify`) take `work` steps (an agent,
  advisory: pass, send back, ask) and `gate` steps (a person, through `workflow.gate`, which is
  `alwaysReview`). A named workflow fills the slots. Workflows and agents live in each **project's**
  config version (ADR 0370), and `planWorkflow()` resolves them before build.
- **Stage names are software's.** `STAGES` in `packages/core/src/operations/shared.ts` is `intake,
  triage, spec, build, verify, merge, done`; `JOB_STAGES` in the runner contract is `triage, spec,
  planning, build, verify`, and `core_jobs.stage` has a CHECK on it.
- **Spec 50 (open PRs #64 and #69)** adds repositories per project, the states `backlog`, `ready`,
  `queued` (and `planning`, for part C), release and the pull, an `activeLimit`, and one workflow
  per project (ADR 0492). It drops the CHECK on `core_work_items.stage`, so a workflow-defined stage
  needs no table rebuild. It lists org-level workflows as a follow-up: this spec.
- **Gates in code.** `ALWAYS_REVIEW` (`merge`, `deploy`, `self-modify`) always goes to a person in
  `invoke()`. One exception exists: a factory incident's check-only fix may auto-merge
  (`check-merge`, ADR 0230) where the project opts in.

## Words
- **Workflow**: an ordered list of stages, defined once per org, with a version history.
- **Stage**: one entry in a workflow, a lane on the board. It has an id, a name, a phase, a stage
  type and that type's settings.
- **Stage type**: built-in code with the contract below. The plugin unit.
- **Step**: one thing a stage does: `agent` (a job on a runner), `check` (code or a command run on
  an exact artifact) or `decision` (a person decides).
- **Phase**: `shaping` (before release) or `delivery` (after release).
- **Artifact**: something a stage produces, addressed by kind, id and **digest** (a git SHA, or the
  sha256 of the bytes). Evidence and decisions bind to the digest.
- **Evidence**: a result that proves something about one artifact digest: a check, CI, criteria,
  a reviewer's notes, a screenshot, a live preview.
- **Review packet**: an artifact, its evidence, and a person's decision on that exact digest (ADR 0502).
- **Skill**: how the team does one thing, written once (instructions plus files), versioned, owned
  by the org, attached to agents, stages and stage types (ADR 0503).
- **Autopilot**: a trigger, an agent, its skills, an instruction and an output target; work the
  factory starts on its own, filed through the same backlog (ADR 0504).
- **Workflow template** / **stage template**: a ready-made workflow, or a stage type with default
  settings, shipped in code, copied into an org and edited there.

## The stage-type contract
Stage types live in `packages/core/src/stages/`, one file per type, registered in
`stages/registry.ts`. The core never imports a runner or a connector; a type names the capabilities
and connectors it needs (ADR 0014). Proposed types:

```ts
// packages/core/src/stages/contract.ts (proposed)
import type { z } from "zod";
import type { Capability, ModelRole } from "@software-factory/runner-contract";
import type { RiskClass } from "../policy/gate.ts";
import type { ImpactChange } from "../policy/impact.ts";

export type Phase = "shaping" | "delivery";

/** What a stage does outside the factory. The floor reads it (rule F6). */
export type Reversibility =
  /** Factory state, branches, R2 only: triage, planning, build, the runs in checks. */
  | "internal"
  /** Visible outside but undoable: open a PR, a preview deploy, a draft post. */
  | "reversible-outside"
  /** Can't be taken back: merge to the default branch, publish, deploy, send. */
  | "irreversible";

export type ArtifactKind =
  | "brief" // the item's title, body, attachments and criteria (always there)
  | "plan" // a living plan with questions and answers (interview planning)
  | "spec" // an approved spec file
  | "git-head" // a branch head; digest = the commit SHA
  | "pull-request" // a PR; digest = its head SHA
  | "file" // bytes in R2; digest = sha256
  | "media" // a reel, an image, a video; digest = sha256
  | "preview-url" // a running preview of an artifact; digest = the artifact it serves
  | "external-ref" // what an outside action made: a merge commit, a post URL, a deploy id
  | "metrics"; // numbers read back after an outside action

export interface ArtifactRef {
  kind: ArtifactKind;
  id: string;
  /** The git SHA or the sha256. Empty only for kinds that have none (brief, metrics). */
  digest: string;
  /** The stage that produced it. */
  stageId: string;
}

export type EvidenceKind =
  | "ci" // CI conclusions read from GitHub on the SHA
  | "check" // a command run on the exact commit (spec 51)
  | "criteria" // each acceptance criterion with how it was met
  | "reviewer" // an independent agent's verdict and notes
  | "drift" // the build against the approved spec (ADR 0306)
  | "tests-intact" // spec 51's guard
  | "screenshot"
  | "recording"
  | "live-preview" // the real output a person can open: the app, the reel
  | "checklist" // a typed list a person or agent ticks (a brand checklist)
  | "measure"; // numbers after publishing

export interface EvidenceSpec {
  kind: EvidenceKind;
  /** Required for the stage to finish, or shown only. */
  required: boolean;
  /** The artifact kind it is about. Evidence for another digest never counts. */
  about: ArtifactKind;
}

export type StepKind = "agent" | "check" | "decision";

/** A person's decision inside a stage. It is code: no setting can turn it off. */
export interface GateSpec {
  /** The gate kind for the inbox, the adjudicator and metrics: "spec", "step", "preview", "merge", "publish". */
  kind: string;
  /** Who decides: the project's approvers, or one named person (who must be an approver). */
  decider: "approvers" | { person: string };
  /**
   * `required`: always runs. `conditional`: runs when a typed condition in the type's settings
   * holds (today: the spec gate from a size). The condition is part of the impact check.
   */
  mode: "required" | "conditional";
  /** The artifact the decision is about: the packet's subject. */
  on: ArtifactKind;
  outcomes: readonly ("approve" | "requestChanges" | "sendBack" | "reject")[];
  /** The operation that opens and records it, and its risk class (checked by `invoke()`). */
  operation: string;
  risk: RiskClass;
}

export interface StageRequirements {
  capabilities: readonly Capability[];
  /** Connector kinds the stage acts through: "github", later others (ADR 0010). */
  connectors: readonly string[];
  /** It needs a repository on the project (spec 50's `workflowNeedsRepository`). */
  repository: boolean;
  /** The runner pool its jobs take (ADR 0301). Shaping stages may not use `heavy`. */
  pool: "heavy" | "light" | "none";
  /** Model roles its agent steps may use. */
  roles: readonly ModelRole[];
}

/** The screen the desktop app shows for an item in this stage. */
export type SurfaceId =
  | "interview" // questions, the living plan, chat, mockups (spec 20)
  | "spec" // a drafted spec and its gate
  | "run" // a live run: transcript, terminal, chat (specs 31, 35, 37)
  | "checks" // checks on a SHA and the packet
  | "packet" // a packet waiting for a decision (today's review packet)
  | "preview" // the real output to judge
  | "publish" // the outside action, its target and its decision
  | "measure"; // numbers read back

/** What one item looks like to a stage type: facts only, no I/O. */
export interface ItemFacts {
  kind: "change" | "incident" | "attached";
  size: "small" | "medium" | "large" | null;
  domains: readonly string[];
  hasRepository: boolean;
}

export interface StepPlan {
  id: string;
  kind: StepKind;
  /** For agent steps: the agent's role. The agent itself comes from the stage's `agent`. */
  role?: ModelRole;
}

/** The persisted state of one stage for one item, as the reconciler reads it (ADR 0501). */
export interface StageSnapshot<Settings> {
  stageId: string;
  typeVersion: number;
  settings: Settings;
  item: ItemFacts;
  /** 1 on first entry; +1 each time the item comes back to this stage. */
  round: number;
  /** The artifacts earlier stages produced, newest per kind. */
  inputs: readonly ArtifactRef[];
  /** Each step's latest attempt: job, run, operation result, pending action. */
  steps: readonly StepRecord[];
  /** Outside facts read by connectors since the last pass: CI conclusions, a PR head, mergeability. */
  observations: readonly Observation[];
  /** Notes carried in by a send-back. */
  notes: readonly string[];
  now: number;
}

/** What a stage wants next. The reconciler turns it into an operation through `invoke()`. */
export type StageDecision =
  | { do: "job"; step: string; role: ModelRole; promptRef: string; context: unknown }
  | { do: "op"; step: string; operation: string; input: unknown }
  | { do: "gate"; step: string; operation: string; input: unknown; packet: PacketRef }
  | { do: "wait"; why: string; on: readonly WakeEvent[]; until?: number }
  | { do: "done"; produced: readonly ArtifactRef[] }
  /** Back to the nearest earlier stage that produces `to`; `counts` against the retry limit. */
  | { do: "sendBack"; to: ArtifactKind; note: string; counts: boolean }
  | { do: "fail"; reason: string }
  | { do: "reject"; reason: string };

export interface StageType<S extends z.ZodType = z.ZodType> {
  /** Stable id: "triage", "interview-planning", "build", "checks", "preview", "publish", … */
  id: string;
  /** Bumped when the persisted step state changes shape; old versions stay until drained (ADR 0501). */
  version: number;
  name: string;
  description: string;
  /** Phases it may be placed in. */
  phases: readonly Phase[];
  /** Its settings, with defaults. A stage template is a name plus a value of this. */
  settings: S;
  /** Artifact kinds it needs from earlier stages (rule F5). */
  consumes: readonly ArtifactKind[];
  /** Artifact kinds it produces. */
  produces: readonly ArtifactKind[];
  /** What proves it is done. */
  evidence: readonly EvidenceSpec[];
  surface: SurfaceId;
  requires(settings: z.infer<S>): StageRequirements;
  /** Its person's decision, if it has one. Derived from settings only through typed conditions. */
  gate(settings: z.infer<S>): GateSpec | null;
  /** Whether a person must take part (an interview, a decision). Shaping stages must (rule F3). */
  needsPerson: boolean;
  reversibility: Reversibility;
  /** For `irreversible` types: the outside action. Its risk must be in `ALWAYS_REVIEW` (rule F6). */
  action?: { operation: string; risk: RiskClass; on: ArtifactKind };
  /** The steps it runs for an item. Pure. */
  steps(settings: z.infer<S>, item: ItemFacts): readonly StepPlan[];
  /** The next thing to do, from this stage's snapshot. Pure: no I/O, no clock but `snap.now`. */
  next(snap: StageSnapshot<z.infer<S>>): StageDecision;
  /** Classifies a settings change for `policyImpact`. Anything it doesn't classify loosens. */
  impact(before: z.infer<S>, after: z.infer<S>): readonly ImpactChange[];
}
```

`StepRecord`, `Observation`, `WakeEvent` and `PacketRef` are plain records: a step's id, attempt,
job/run/pending-action ids and result; an observation's kind (`ci`, `pr-head`, `mergeable`,
`queue-turn`, `release`), value and time; a wake event's name (`run-ended`, `gate-decided`, `ci`,
`pr-head`, `queue-turn`, `release`, `answers`); a packet's id and subject.

**Rules for writing a stage type** (checked by `stages/registry.test.ts` for every registered type):
- `next` is pure. Given the same snapshot it returns the same decision.
- `gate()` reads only typed fields. A setting may change *who* decides (only to a narrower set) or
  a typed condition; there is no field that removes a `required` gate.
- An `irreversible` type has an `action`, its risk is in `ALWAYS_REVIEW`, and `gate()` returns a
  `required` gate on the same artifact kind as the action, decided before the action step.
- A type's prompts live in code (`apps/engine/src/workflow/prompts.ts` today). An agent's
  instructions are appended. The Checks reviewer and verify prompts never take project or org text
  (ADR 0371 §5).
- Agent permissions narrow, never widen (ADR 0372). A type declares its ceiling; the harness
  compiles the agent's profile inside it.

### Built-in stage types
| Type | Phase | Steps | Produces | Gate | Reversibility | Needs |
| --- | --- | --- | --- | --- | --- | --- |
| `triage` | delivery (today); shaping is an open question | agent (size, domains, readiness, criteria; may ask) | brief (sized) | none | internal | light pool, role `triage` |
| `interview-planning` | shaping or delivery | agent session (spec 20), questions, chat, mockups; decision | plan, spec | `spec`, conditional on size (`requiredFrom`) | internal | light pool; repository for `.kim/` today |
| `written-spec` | shaping or delivery | agent drafts, questions in rounds, decision | spec | `spec`, conditional on size | internal | light pool (Workflow v1–v4's spec rounds) |
| `agent-check` | delivery | agent, advisory: pass, send back, ask | evidence only | none | internal | today's `work` step; read-only job |
| `decision` | shaping or delivery | decision | none | `step`, required | internal | today's `gate` step (`workflow.gate`) |
| `build` | delivery | agent in the repository; merge the default branch first | git-head | none | internal | heavy pool, repository, role `implement` |
| `checks` | delivery | op (open PR), checks on the SHA, CI, reviewer agent, packet | pull-request, evidence | none | reversible-outside | heavy pool, repository, `github` |
| `preview` | delivery | op (start the preview), evidence, decision | preview-url, evidence | `preview`, required | reversible-outside | per settings: `browser` capability for an app; R2 for media |
| `publish` | delivery | decision, then the action through a connector | external-ref | `merge` / `publish` / `deploy`, required | irreversible | the connector named in settings |
| `agent-work` | delivery | agent on a runner without a repository, files to R2 | file, media | none | internal | light or heavy per settings; runner support for no-repo jobs |
| `measure` | delivery | op (read numbers through a connector) after a delay | metrics | none | internal | the connector |

**Stage templates** ship with them: "Software triage", "Interview planning" (the owner's way, from
kim), "Written spec" (an agent drafts, a person approves), "Build", "Checks", "Merge" (publish with
`github`/`merge` through the merge queue), "Preview the app", "Preview the reel", "Post",
"Measure after 7 days".

## The workflow definition
A workflow is data that only chooses types, orders them and configures them.

```ts
// packages/core/src/stages/workflow.ts (proposed)
export interface WorkflowDefinition {
  schema: 1;
  /** Stable across versions; items and projects refer to it. */
  id: string; // wf_…
  name: string; // "Software"
  description: string;
  /** The template it was copied from, for "what changed since the template". */
  template?: { id: string; version: number };
  stages: readonly StageInstance[];
}

export interface StageInstance {
  /** Stable across versions: the lane id, `core_work_items.stage`, idempotency keys. */
  id: string; // /^[a-z0-9][a-z0-9-]{0,39}$/
  type: string; // a registered stage type id
  /** Recorded on save as the registry's current version of the type. */
  typeVersion: number;
  name: string; // the lane's label
  phase: Phase;
  /** Parsed by the type's schema; defaults filled on save. */
  settings: unknown;
  /** Skip the stage for an item. Not allowed on a stage whose gate is required (rule F7). */
  when?: { sizeAtLeast?: "small" | "medium" | "large"; domain?: string };
  /** The org agent its agent steps hand to (ADR 0372). Absent: the type's built-in agent. */
  agent?: string;
}
```

### Validation rules
`validateWorkflow(def, registry, orgAgents)` returns every broken rule, each with the stage it is
about. `workflow.save` refuses a definition with any (`invalid_input`); nothing invalid ever becomes
current (ADR 0370 §2). The **floors** are F-rules: no setting, template or agent can switch them off.

- **S1** Every stage's `type` is registered, `typeVersion` is one the registry still runs, and
  `settings` parse under the type's schema.
- **S2** Stage ids are unique, match the id pattern and are not `backlog`, `ready`, `queued` or
  `done`. At most 20 stages.
- **S3** Every `agent` names an org agent whose role is in the type's `requires().roles`, and whose
  tier and instructions fit (instructions ≤ 4 kB).
- **F1** Each stage's phase is one of its type's `phases`. All shaping stages come before all
  delivery stages: release sits between them. At least one delivery stage.
- **F2** Shaping stages hold no build slot: `requires().pool` is `light` or `none`.
- **F3** Shaping stages need a person: the type's `needsPerson` is true.
- **F4** Shaping stages act on nothing outside: `reversibility` is `internal`.
- **F5** Every kind a stage `consumes` is produced by an earlier stage, or is `brief`.
- **F6** **The irreversible floor.** A stage whose type is `irreversible` has an `action` with a
  risk in `ALWAYS_REVIEW` and a `required` person gate on the action's artifact kind, decided
  inside the stage before the action. At run time the action is refused unless an approved
  decision exists on the **same digest** it acts on (ADR 0502); a newer digest needs a new decision.
- **F7** No `when` on a stage whose gate is `required`, or whose type is `irreversible`. A
  conditional gate's condition lives in its typed setting, where the impact check reads it.
- **F8** **Nothing reaches a default branch except through checks.** A `publish` stage whose
  connector action merges into a repository is preceded by a `checks` stage on the same
  repository, with no stage between them that produces `git-head` (ADR 0020, 0037).
- **F9** Required connectors exist for the org and required capabilities are ones the contract
  knows. A project may only run the workflow when it has what the stages need: a repository when
  any stage needs one, and each connector connected. `project` config saves and `workItem.release`
  refuse otherwise (spec 50's rule 3, generalised).
- **F10** Code-owned prompts stay code's: no type exposes a setting that replaces the verify or
  reviewer prompt, or that names a model id (ADR 0018).

### The impact check
`workflowImpact(before, after, registry)` extends `policyImpact` (ADR 0370 §3). Each change is
`loosens`, `tightens` or `neutral`; anything it can't classify loosens.
- A stage with a gate removed, or a `required` gate's stage removed: **loosens**.
- A conditional gate's condition widened (for example `requiredFrom` medium → large): loosens;
  narrowed: tightens.
- A `checks` stage removed, an evidence requirement dropped, or a `when` added to or widened on a
  `checks` or `agent-check` stage: loosens.
- A decider broadened (a named person → approvers): loosens; narrowed: tightens.
- A stage added that has a gate, or a `checks`/`agent-check` stage added: tightens.
- A stage moved: loosens if it moves a gate or a check later past a stage that produces what it
  checks, otherwise neutral.
- Agent instructions, tiers, names: neutral, and **practice** for the improver (ADR 0373).
- Each type's own `impact()` classifies its settings.
- A project switching workflows compares the two definitions the same way (ADR 0492 §3).

A loosening save is `self-modify`: a pending action for an approver, judged under the current
version (ADR 0370 §4). Who approves an org-level loosening is the org's owners and admins, and the
org floor may add more (open question 6).

## Where workflows and agents live
- **An org config version** holds `agents` and `workflows`, with the same machinery as a project's
  config (ADR 0370): versions written only through operations, validation before save, the impact
  summary on the server, rollback, export and import. Migration 0270 adds `core_org_configs`
  (org id, version, document, source, created_by, note, parent_version) and
  `core_orgs.config_version`.
- **A project's config keeps policy**: autonomy and overrides, approvers, backup owner, timeouts,
  `wipLimit`, `activeLimit`, `release.agents`, protection, the harness ceiling. It names its
  workflow by id (`workflow: "wf_…"`, replacing ADR 0492's name).
- **A work item pins** its project config version (as today), the org config version and the
  workflow id when it enters its first stage. The pinned definition is its stage list for life,
  unless a person moves it (below).

## How the engine runs a stage list
Two ways were compared. The recommendation is the reconciler (ADR 0501, proposed until the owner
confirms it).

### A. One replayed Workflow per item, interpreting the list
Keep `WorkItemWorkflow`. A new version `runStages` walks the pinned stage list; each stage type
supplies a `run(step, ctx)` that calls `step.do` / `step.waitForEvent`, with step names derived
from the stage id, round and step id, as v6 does for slot steps.
- **For:** the code exists and works. Waits at gates cost nothing. Step results are journaled and
  retried by the platform. No new scheduler.
- **Against:**
  - Step names stay an API (ADR 0053), and now they come from data *and* from every stage type's
    code. Any change to a type's step sequence is a whole-Workflow version bump, and old versions
    pile up: `work-item.ts` is 1,759 lines with six versions in one function.
  - A running instance can't be moved to a new definition or a fixed type: it can only drain.
  - State lives twice: in D1 (through operations) and in the instance's journal. Incident #7 (an
    item waiting for CI that never came) was a lost event leaving them out of step, and the fix was
    more waits and rounds in the Workflow.
  - A stage type is hard to test alone: its behaviour is a replay against a mocked `step`.

### B. A reconciler: a pure function from a snapshot to the next action
The item's state of record is in D1 only. `reconcile(snapshot)` finds the item's current stage and
calls that type's `next()`. An executor carries the decision out through `invoke()`, records it,
and reconciles again until the answer is `wait`.
- **Snapshot**: the item row, the pinned definition, `core_item_stages` (one row per stage entry:
  stage id, round, type version, status, artifacts, notes) and `core_item_steps` (one row per step
  attempt: job, run, pending action, operation result), plus recent observations (CI, PR head,
  mergeability, queue turn), all read in one D1 batch.
- **Triggers**: every operation that touches an item (a run ending, a gate decided, a CI or push
  webhook, release, an answer) emits an outbox message that reconciles that item; the minute cron
  reconciles every item whose `next_check_at` has passed. The cron is what heals a lost event: it
  re-reads the outside world (CI on the SHA, the PR) instead of waiting for a message that never
  comes.
- **One pass at a time per item**: a compare-and-set on `core_work_items.reconcile_rev`. A pass
  that loses the race stops; the winner sees its writes.
- **Idempotency**: every action carries the key `<item>:<stage>:<round>:<step>:<attempt>`.
  Operations the executor calls dedupe on it (a job is enqueued once, a PR opened once, a gate
  opened once).
- **Waiting** is a row: `wait` records `why`, the events that wake it and `next_check_at`. A
  waiting item holds no slot, as today.
- **Kill switch and pause**: the executor's `invoke()` refuses as it does now; the item records
  the refusal and waits for the switch's event (ADR 0044).
- **For:**
  - Stage types are pure and tested with tables of snapshots: no replay, no mocked `step`.
  - No step-name API. Changing a type's code changes what in-flight items do next, so the only
    versioned thing is the *persisted* step state of a type (`typeVersion`), which is far smaller
    than a whole Workflow.
  - One state of record. Lost events are healed by the tick.
  - Moving an item to a new definition is a data change at a stage boundary.
  - Data-defined workflows are what it is shaped for (the review's point).
- **Against:**
  - We build what Workflows gives us: idempotent actions everywhere, the tick, the CAS, retries
    with backoff for transient failures.
  - A code change reaches in-flight items at once. A bug in a type affects every item in that
    stage, not only new ones. Mitigation: type tests over recorded snapshots, and shadow mode.
  - Latency on a missed event is up to a minute plus the tick's scan.

### What could not be measured
- How often events are actually lost. The evidence is incident #7 and the CI rounds the code grew
  around it, not a count.
- D1 load of the tick scan and of one CAS per pass at the factory's volume, and its cost against
  Workflow steps.
- How many existing operations are idempotent today. Each one the executor calls needs an audit
  (`pr.open`, `branch.ensure`, job enqueue and `workflow.gate` look safe to repeat; that wasn't
  checked line by line).
- Replay cost and the per-instance step limit on long items with many rounds. No item has hit it.
- Nothing was run: this comparison is from reading `work-item.ts`, the ADRs and the review.

### Why the reconciler
Data-defined stage lists make step names a function of data and of every type's code, which is
exactly where ADR 0053's rule hurts most; the reconciler removes that rule instead of extending it.
It also gives one state of record and a tick that heals lost events. The cost is real but bounded
and can be measured before anything depends on it: the reconciler runs in **shadow** next to
Workflow v6 first, recording what it would do, and takes no item until it agrees (build plan,
PR 7).

## The review packet: artifact, evidence, decision
Today's packet (ADR 0020, 0037, 0041) is a verdict, what changed, criteria with evidence, the
reviewer, checks, risk flags and drift, for one head SHA, and it backs `factory/verify`. The same
shape serves any workflow (ADR 0502):

```ts
export interface ReviewPacket {
  id: string;
  workItemId: string;
  /** What is being decided: the exact digest. */
  subject: ArtifactRef;
  /** Evidence from any earlier stage, kept only while bound to `subject.digest`. */
  evidence: readonly EvidenceItem[];
  /** Computed in code from the evidence the stages require: complete and passing, or why not. */
  verdict: { status: "pass" | "fail" | "incomplete"; reasons: readonly string[] };
  /** The sections a person sees, in the project's order (`reviewPacket.sections`). */
  sections: readonly string[];
  decision: null | {
    by: string;
    at: number;
    outcome: "approve" | "requestChanges" | "sendBack" | "reject";
    note: string | null;
    /** The digest the person saw. A decision on another digest never authorises an action. */
    digest: string;
  };
}

export interface EvidenceItem {
  kind: EvidenceKind;
  stageId: string;
  digest: string;
  status: "pass" | "fail" | "info";
  summary: string;
  /** Large things stay in D1 or R2, read by id. */
  ref?: string;
}
```

- **Software**: subject `pull-request` at the head SHA. Evidence: CI on the SHA, checks run on the
  exact commit (spec 51), criteria, the reviewer, drift, tests-intact. The verdict passes only with
  green CI and the required evidence, and it backs `factory/verify` for that SHA. The decision is
  the merge gate (`pr.merge`, risk `merge`). A new push makes a new digest: the old evidence and any
  pending decision are withdrawn (today's `verify.refresh`).
- **Marketing**: subject `media`, the reel's sha256. Evidence: the live preview (the reel playing as
  it will post, in the target's frame), a checklist (length, captions, aspect ratio, the brief's
  criteria), maybe a reviewer agent. The decision is Preview's gate, then Publish's.
- **The same rules hold for both**: evidence and decisions bind to a digest; the verdict is
  computed in code; an outside action needs an approved decision on the digest it acts on; the
  merge queue's carry-over of an approval across a clean update-branch (ADR 0330) is the one
  defined exception, and it stays in the `publish` type's merge code.

## Today's stages as stage types (no behaviour change)
The **Software** workflow below reproduces Workflow v6 exactly. The table says where each part goes.

| Today | Stage type | Notes |
| --- | --- | --- |
| `triage` (job, `workItem.triage`, readiness, `workflow: options`) | `triage` | Sizes the item and records `specRequired`. Picking a workflow goes away (ADR 0492). |
| spec stage: planning session (v5+) and spec gate | `interview-planning` | The gate is `spec.accept`, conditional on `requiredFrom`. Skipped stages are recorded as today (`skipped: [{stage: "spec"}]`). |
| spec rounds (v1–v4) | `written-spec` | Same steps and gate; available as a template for "someone else's way". |
| `afterSpec` slot steps | `agent-check` / `decision` stages between spec and build | A send-back before build has no earlier producer, so its note goes to the next producer (build), as v6 does. |
| build (rounds, retries, conflicts, merge the default branch first) | `build` | `retryLimit` and `MERGE_ROUNDS` are its settings; send-backs from later stages count against it, as today. |
| `beforeVerify` slot steps | `agent-check` / `decision` stages between build and verify | They run every round, because a send-back to build re-runs every stage after it. |
| verify (open PR, mergeable check, reviewer job, CI rounds, no-CI question, packet) | `checks` | `CI_WAIT`, `CI_ROUNDS`, `CI_MISSING_ROUNDS` become its settings with today's values; reviewer and verify prompts stay code's. |
| `afterVerify` slot steps | `agent-check` / `decision` stages between verify and merge | Same. |
| merge gate + merge queue (v4) | `publish` with `connector: github`, `action: merge`, `via: merge-queue` | The decision is `pr.merge` (`ALWAYS_REVIEW`). Landing is the queue (ADR 0330). |
| incident check-only auto-merge (ADR 0230) | `publish` merge code, kind `incident` only | Kept as today, in code, pending open question 11. |
| attached PRs (`runAttached`) | a built-in **Attached PR** workflow: `checks` (waits for pushes, no build) → `publish` (merge, direct) | Chosen by kind, not by the project, as today. |

**The send-back rule** that makes this exact: a `sendBack { to: kind }` returns the item to the
nearest earlier stage that produces `kind` (for code, `git-head`: build), with the note; every
stage after it runs again in order. If no earlier stage produces it, the note is carried to the
next stage that does.

**The three slots** are positions in the list: after the planning stage, after build, after checks.
The slot step types (`work`, `gate`) become the `agent-check` and `decision` stage types.

**Slots on the runner side**: `agent-check` jobs stay read-only `verify`-stage jobs (spec 09 M2 as
built). No `JOB_STAGES` change is needed for the Software workflow. `agent-work` (no repository)
needs one, and `core_jobs.stage`'s CHECK needs the table rebuild that broke production in #42, so
that type waits for a careful migration (build plan PR 8).

**Pools**: `triage`, `interview-planning`, `written-spec` light; `build`, `checks` heavy (ADR 0301),
as today.

## Worked example 1: Software, as it runs today

```ts
// packages/core/src/stages/templates/software.ts (proposed)
export const software: WorkflowDefinition = {
  schema: 1,
  id: "wf_template_software",
  name: "Software",
  description: "Triage, plan when the size needs it, build, check on the exact commit, merge through the queue.",
  stages: [
    {
      id: "triage", type: "triage", typeVersion: 1, name: "Triage", phase: "delivery",
      agent: "Triage",
      settings: { mayAsk: true, readiness: true },
    },
    {
      id: "spec", type: "interview-planning", typeVersion: 1, name: "Spec", phase: "delivery",
      agent: "Planner",
      // The gate's condition (ADR 0013): today `spec.requiredFrom` in the project's config.
      settings: { requiredFrom: "medium", decider: "approvers", critic: false, split: true },
    },
    // A project's afterSpec slot steps go here, e.g.
    // { id: "design-review", type: "decision", typeVersion: 1, name: "Design review",
    //   phase: "delivery", settings: { decider: { person: "octocat" }, instructions: "…" } },
    {
      id: "build", type: "build", typeVersion: 1, name: "Build", phase: "delivery",
      agent: "Builder",
      settings: { retryLimit: 2, conflictRounds: 3, mergeDefaultBranchFirst: true },
    },
    // beforeVerify slot steps go here.
    {
      id: "verify", type: "checks", typeVersion: 1, name: "Verify", phase: "delivery",
      settings: {
        openPr: "beforeChecks",
        ci: { waitMinutes: 10, rounds: 12, missingRounds: 3, onMissing: "ask" },
        reviewer: true,
        drift: true,
        requiredEvidence: ["ci", "criteria", "reviewer"],
      },
    },
    // afterVerify slot steps go here.
    {
      id: "merge", type: "publish", typeVersion: 1, name: "Merge", phase: "delivery",
      settings: {
        connector: "github",
        action: "merge",
        via: "mergeQueue",
        queue: { waitHours: 1, updateReads: 8 },
        decider: "approvers",
      },
    },
  ],
};
```

Stage ids match today's `STAGES` (`triage`, `spec`, `build`, `verify`, `merge`), so the board and
`core_work_items.stage` read the same as now. Backlog, Ready, Queued and Done are the fixed states
around them (spec 50).

## Worked example 2: Marketing

Brief by interview → Draft → Preview the reel → Publish → Measure. The project has no repository.

```ts
// packages/core/src/stages/templates/marketing.ts (proposed)
export const marketing: WorkflowDefinition = {
  schema: 1,
  id: "wf_template_marketing",
  name: "Marketing",
  description: "Shape a brief with a person, draft the reel, watch it before it posts, post it, read the numbers.",
  stages: [
    {
      id: "brief", type: "interview-planning", typeVersion: 1, name: "Brief", phase: "shaping",
      agent: "Producer",
      // Always: a brief needs a person whatever the size.
      settings: { requiredFrom: "small", decider: "approvers", output: "brief", mockups: true },
    },
    // release: Ready → Queued
    {
      id: "draft", type: "agent-work", typeVersion: 1, name: "Draft", phase: "delivery",
      agent: "Editor",
      settings: { produces: "media", pool: "light", accept: ["video/mp4"], maxBytes: 200_000_000 },
    },
    {
      id: "preview", type: "preview", typeVersion: 1, name: "Preview the reel", phase: "delivery",
      settings: {
        show: "media",
        frame: "vertical-9x16",
        checklist: ["Under 60 seconds", "Captions on", "Matches the brief's hook"],
        reviewer: true,
        decider: "approvers",
        onSendBack: "draft",
      },
    },
    {
      id: "publish", type: "publish", typeVersion: 1, name: "Post", phase: "delivery",
      settings: { connector: "social", action: "post", account: "brand", decider: "approvers" },
    },
    {
      id: "measure", type: "measure", typeVersion: 1, name: "Measure", phase: "delivery",
      settings: { connector: "social", after: "7 days", metrics: ["views", "saves", "shares"] },
    },
  ],
};
```

How the rules read it: `brief` is shaping, needs a person, light pool, internal (F1–F4). `preview`
consumes `media`, produced by `draft` (F5). `publish` is irreversible: its action's risk is
`publish` (added to `ALWAYS_REVIEW`, a tightening in code), and its gate is required on `media`; at
run time the post is refused unless the approval is on the reel's current sha256 (F6). Nothing
merges into a repository, so F8 doesn't apply, and the project needs no repository (F9). It needs
the `social` connector connected, which doesn't exist yet (build plan PR 9).

## Migration from per-project workflows to org-level ones
Each step keeps behaviour identical; a test compares `planWorkflow()` (v6) for every project before
and after.
1. **Compile**: `compileProjectWorkflow(policy, workflowName)` turns a project's config into a
   `WorkflowDefinition`: the Software template with that workflow's slot steps inserted as
   `agent-check`/`decision` stages, its `core.build` as the build stage's agent, and
   `spec.requiredFrom`, `retryLimit` and the CI constants as stage settings.
2. **Collect per org**: compile every project's current workflow, then dedupe by canonical JSON.
   Identical ones become one org workflow; different ones with the same name get the project's slug
   added ("Ship a feature (site)"). Projects with no workflow get the org's "Software".
3. **Agents**: the union of the projects' agents. Same name and same body: one. Same name,
   different body: suffixed the same way, and the compiled workflows point at the suffixed name.
4. **Write**: one org config version 1 (source `migrated`) per org; each project's config gets a
   new version (source `migrated`) with `workflow: "wf_…"`, and its `workflows` and `agents` blocks
   removed. `spec.requiredFrom` and `retryLimit` stay readable in the project config until every
   item pinned to an older version is done, then they are dropped (open question 5 decides where
   they finally live).
5. **In-flight items** keep their pinned project config version and Workflow v6 instance. They
   drain unchanged.

## Versioning while items are in flight
- **The definition is pinned** at the item's first stage (org config version + workflow id). A new
  version of the workflow applies to items that enter their first stage after it is saved.
- **Gate strictness still uses the stricter** of the pinned and the current *project* config
  (ADR 0370 §5): who approves and the autonomy decision tighten for running items, never loosen.
- **Moving an item to a new version** is `workItem.moveWorkflowVersion` (human): allowed at a stage
  boundary when the item's current stage exists in the new version with the same id and type, and
  every stage already done exists unchanged. If the move loosens for that item, it needs an
  approver. Whether tightening moves happen automatically is open question 3.
- **Release** (from shaping to delivery) re-pins to the current version when the item's done
  shaping stages exist unchanged in it; otherwise it keeps its pin. Open question 4.
- **Stage-type code**: a type's `version` changes only when its persisted step state changes
  shape. Each stage entry records the version it started on; the registry keeps old versions'
  `next()` until `core_item_stages` has none open, then deletes them. Prompt and logic changes that
  keep the state shape reach in-flight items at once (tested on recorded snapshots first).
- **Old Workflow versions**: v1–v6 stay until no open item has `workflow_version` ≤ 6, then
  `work-item.ts` is deleted (ADR 0053's rule, applied one last time).

## Skills
Added by the owner on 2026-11-12 (ADR [0503](../adr/0503-skills-are-shared-by-the-org-and-attached-where-used.md)).
Design: `docs/design/factory-ui/FactorySkills.html` and FactoryAgents.html on PR #61.

A **skill** is how the team does one thing, written once: instructions plus optional files,
versioned, owned by the org and shared by every agent. Skills attach at three levels:
- **an agent**, always ("Builder: Write a migration, always");
- **a stage in a workflow**, optionally with a condition ("Software · Build, when the change touches
  `packages/db`");
- **a stage type**, which ships its own built-in skills ("Interview planning: Run an interview").

### Schema
```ts
// packages/core/src/skills/schema.ts (proposed)
export interface Skill {
  id: string; // sk_…, stable
  /** The name agents see, and its slug ("write-a-migration") is the harness-side name. */
  name: string;
  /** When to use it. Harnesses that load skills on demand show the model this line. */
  description: string; // ≤ 300 chars
  /** SKILL.md: the instructions. */
  body: string; // ≤ 16 kB
  /** Supporting files, stored in R2 by sha256 (ADR 0310's blob store). */
  files: readonly { path: string; sha256: string; bytes: number }[]; // ≤ 10 files, ≤ 256 kB each
  /** For an org skill that changes a stage type's built-in skill (below). */
  overrides?: { builtin: string; mode: "extend" | "replace" };
  /** Where it came from: "the 0120 deploy incident". */
  provenance?: { incidentId?: string; workItemId?: string; note?: string };
}

/** Attachments, inside the org config version. */
export interface AgentConfig {
  // … ADR 0372's fields, plus:
  skills: readonly string[]; // skill ids, always attached
}
export interface StageInstance {
  // … the fields above, plus:
  skills?: readonly { skill: string; when?: SkillCondition }[];
}
export interface SkillCondition {
  /** Globs over the paths the change touches (`packages/db/**`). */
  paths?: readonly string[];
  sizeAtLeast?: "small" | "medium" | "large";
  domain?: string;
}
```
- **Storage.** Skill versions are rows (`core_skill_versions`: skill id, version, body, file
  manifest, author, source, note, parent), with the bytes in R2. The **org config version** holds
  the current version of each skill (`skills: { [id]: version }`) and the attachments. So editing a
  skill writes a skill version and a new org config version, and a work item that pins its org
  config version (above) pins its skills too.
- **Built-in skills** live in code next to their stage type
  (`packages/core/src/stages/<type>/skills/<slug>/SKILL.md`) and are versioned with the type.
- **Validation**: names unique in the org, every attachment resolves, file paths relative with no
  `..`, limits above. A skill's files are instructions and helper scripts; they run, if at all,
  inside the job's harness sandbox like any command the agent runs, with no extra permission.

### How a run's skills are resolved
`resolveSkills(orgConfig, stage, agent, facts)` is pure and runs when a job is built:
1. the stage type's built-in skills, each replaced or extended by an org skill that overrides it;
2. the agent's skills;
3. the stage's attached skills whose condition holds for the item.

The set is the union, deduplicated by skill id, in that order. **Conditions**: `paths` match the
paths the change is known to touch when the job is built: the branch's diff against the default
branch (from the second build round), plus the paths the approved spec names. When nothing is known
yet (a first build with no spec), a path-conditioned skill is **included**: a skill is guidance, and
loading one too many is cheaper than missing one. `sizeAtLeast` and `domain` read triage's record,
as slot conditions do today.

The job carries the resolved set as references (`skills: [{slug, description, version, sha256}]`),
recorded on the run, so a run says exactly which skill versions it followed.

### Projection into the harness
Harness-neutral (ADR 0017, 0372): the runner fetches the bodies and files over the channel (as it
fetches attachments) and the **harness adapter** puts them where its harness reads them.
- Claude Code: as skills in the run's own settings directory (`<slug>/SKILL.md` and its files), the
  one the factory already launches the harness with (ADR 0270, 0430). Nothing goes in the person's
  `~/.claude`.
- A harness without skills: the adapter appends each body to the prompt under a heading, and lists
  the files' paths in the job's workspace.
- The adapter declares which it does as a capability (`skills`), so the core never imports a harness.

That projection is a small hook in `harness-claude` and the runner host, owned by the hosts session
today: the build PR adds new files and the smallest hook, and says so.

### Org overrides of built-in skills
- **`extend`** appends the org's body after the built-in one, and adds its files. The built-in text
  always comes first and can't be removed this way.
- **`replace`** substitutes the org's skill for the built-in one.
- **Protected stages.** The `checks` type's reviewer and verify skills judge the work, so project
  and org text reaching them is restricted (ADR 0371 §5): only `extend` is allowed there, and adding,
  editing or removing such a skill is **policy**, never practice (below). The design attaches "Walk
  the app in a browser" to the Reviewer in Verify; this is the rule that allows it. Open question 16.

### Edits, trials and approval
The owner's rule: the factory may **propose** an edit; only a person **accepts** one. Every edit is
trialled before it sticks.
- `skill.propose` (actor `self-improve`, an agent, or an autopilot with output `proposals`): a new
  candidate version with its evidence ("came from incident #12"), shown in the inbox as a diff. It
  changes nothing.
- `skill.accept` (human, browser-only like other decisions, ADR 0340): starts a **trial** of the
  candidate on the next N items that would load the skill (ADR 0373's lifecycle: promoted if
  outcomes hold up, rolled back automatically if they don't). `skill.reject` closes it.
- `skill.save` (human): a person's own edit. It starts a trial too; the person may choose **apply
  now** instead, which writes the version at once.
- **The tier**: a skill edit is practice (ADR 0373) with one change: the factory never applies it
  itself, a person accepts it. Edits to protected skills (above) are policy: `self-modify`, decided
  by an approver, no trial shortcut. A new attachment is practice; removing one from a protected
  stage is a loosening.
- This narrows ADR 0373 §1 for skills, and answers the review's item 11 for them (an instruction
  change can't land unapproved). Whether agent instructions should follow the same rule is open
  question 17.

### Operations
`skill.list`, `skill.get` (read, member: versions, attachments, runs that used it); `skill.save`,
`skill.attach`, `skill.detach`, `skill.archive` (human, org admin, through the org config version
and its impact check); `skill.propose`; `skill.accept` / `skill.reject` (human, browser-only);
`skill.trials` (read). The runner channel gets `GET /runner/v1/jobs/:id/skills/:slug` for bodies
and files, scoped by the job and fenced by its lease.

## Autopilots
Added by the owner on 2026-11-12 (ADR [0504](../adr/0504-autopilots-file-work-they-never-ship-it.md)).
Design: `docs/design/factory-ui/FactoryAutopilots.html` on PR #61.

An **autopilot** is work the factory starts on its own: a **trigger** (a schedule or an event), an
**agent**, the **skills** it follows, an **instruction** and an **output target**. What it files
goes through the same backlog and workflow as anything else. It never merges or deploys, and it
releases work only where policy allows. It runs on a light slot, under a time limit and the budget.

### Model
```ts
// in the org config version (proposed)
export interface AutopilotConfig {
  id: string; // ap_…
  name: string; // "Weekly regression run"
  description: string;
  enabled: boolean;
  trigger:
    | { kind: "schedule"; cron: string; timezone: string } // at most hourly
    | { kind: "event"; event: AutopilotEvent; projects?: readonly string[] };
  agent: string; // an org agent
  skills: readonly string[]; // on top of the agent's own
  instructions: string; // ≤ 4 kB
  /** Projects it reads (a checkout of the default branch when it needs code). */
  scope: { projects: "all" | readonly string[] };
  output: AutopilotOutput;
  limits: {
    minutes: number; // default 30, at most 60: the job's session timeout
    maxOutputs: number; // items, labels or proposals per run; default 5, at most 20
    runsPerDay: number; // default 4, at most 24
  };
  requires: readonly Capability[]; // e.g. browser, for "walk the app"
}

export type AutopilotEvent =
  | "ci.failedOnDefaultBranch" // a red CI conclusion on the default branch's head
  | "incident.opened"
  | "workItem.captured" // a new backlog item (backlog triage)
  | "workItem.done";

export type AutopilotOutput =
  | { kind: "backlog"; project: string | "each"; state: "backlog" | "ready" | "queued"; priority?: 0 | 1 | 2 | 3 }
  | { kind: "labels" } // size, priority, criteria, notes on existing backlog/ready items
  | { kind: "digest" } // one inbox card for the org's people
  | { kind: "proposals" }; // skill and config proposals for a person
```

### How a run relates to runs and work items
An autopilot run is a **work item of kind `autopilot`** running a fixed one-stage workflow: one
`agent-work`-shaped stage on the light pool, no gate, no branch, no PR. It reuses jobs, runs,
transcripts, watch and steer, usage, the kill switch and the audit journal, which all hang off a
work item. It is created `running` straight away (it skips backlog and release: it is the factory's
own small job, like an incident), never shows on a board, and doesn't count against `activeLimit`.
- `core_autopilot_runs` records each firing: autopilot id, the org config version, the trigger
  occurrence and its **dedupe key** (`ci:<repo>:<sha>`, `schedule:<id>:<minute>`), the work item,
  status and outputs. A repeated event with the same key never fires twice (ADR 0006's dedupe
  key, separate from the item id).
- Items it files record `source: { autopilot, run }` and link back to the run; the run lists them
  ("Filed #26 · 12 min").
- **Cascade and depth**: an event trigger never fires on something an autopilot filed or did
  (ADR 0006's cascade limit), so "a new backlog item" can't loop through backlog triage.
- `core_work_items.kind` gains `autopilot`. If it is a CHECK, that's a table rebuild, done with
  the care #42 taught.

### What it may do (policy checks, in code)
- **A new actor, `autopilot`.** Its calls go through `invoke()` like any other. `merge`, `deploy`,
  `check-merge` and `self-modify` are **deny** for it in every autonomy policy and in the floor, not
  review: an autopilot never merges or deploys and never changes config, even with a person's
  approval. A person who wants that acts themselves.
- **An allowlist per output kind**, checked by the operation that records the output:
  - `backlog`: `workItem.create` in the scoped projects. `state: "queued"` runs spec 50's release
    rules, so it is allowed only where the project's `release.agents` is true; otherwise the item is
    created `ready` and the run records why ("No, you release").
  - `labels`: `workItem.update` on items in `backlog` or `ready` only (size, priority, criteria,
    notes), never on pulled items.
  - `digest`: one inbox card per run.
  - `proposals`: `skill.propose` and `config.propose` only; each waits for a person.
- **Read access**: the job token is read-only and repo-scoped (ADR 0033, 0052), for the scoped
  projects' repositories; there is no branch to push to.
- **Limits**: the session timeout is `limits.minutes`; outputs past `maxOutputs` are refused;
  `runsPerDay` caps firings; the light pool's limits apply (ADR 0301). The run's time and tokens are
  usage like any run's, and count against the org's budget when the budget exists (the review's
  item 9; until then, the limits above are the budget).
- **Who sets one up**: autopilots are config, so they change only through org config saves (human).
  Adding or enabling one is `neutral` unless its output is `backlog` with `state: "queued"` (it
  releases work) or its scope widens, which **loosen**. The improver can't add or enable autopilots.

### Operations
`autopilot.list`, `autopilot.get` (read, member: config, next run, last runs and their outputs);
`autopilot.save`, `autopilot.enable`, `autopilot.disable` (human, org admin, through the org config
version); `autopilot.runNow` (human, member); `autopilot.fire` (system: the minute cron for
schedules, the outbox for events); and, on the runner channel for the run's job only,
`autopilot.file`, `autopilot.label`, `autopilot.digest`, `autopilot.propose`, each the allowlisted
operation above under actor `autopilot`.

## The board, and what the UI needs from operations
**Lanes come from the workflow**: Backlog | the shaping stages | Ready | Queued | the delivery
stages | Done. An item in a shaping stage has status `planning` (spec 50), shown under its stage.
Failed, rejected and cancelled items leave the board for a filter.

Operations (all through the registry, ADR 0003):
- `stageType.list` (read, member): each type's id, name, description, phases, surface, gate kind,
  reversibility, requirements, and its settings schema as JSON Schema with defaults, for the editor.
  `stageTemplate.list` and `workflowTemplate.list` (read) list the shipped templates.
- `workflow.list` / `workflow.get` (read, member): the org's workflows with their stages, the
  projects that use each, and the version history.
- `workflow.preview` (read, member): validates a draft and returns `{valid, errors[], impact[]}`,
  each error tied to a stage id and rule.
- `workflow.save` (human, org admin): `{orgId, baseVersion, workflow, note}`; `self-modify` when the
  impact loosens. `workflow.createFromTemplate`, `workflow.archive` (refused while a project uses
  it), `workflow.rollback`. Agents get the same set under `agent.*`.
- `workflow.lanes` (read, member): `{projectId}` → the lanes in order: `{id, name, phase, kind:
  "fixed" | "stage", typeId?, surface?}`.
- `workItem.board` (spec 50) gains, per item: `stageId`, `round`, `waiting` (`person` | `agent` |
  `event` | `none`, with who or what), the open decision if any, and `actions` (the operations this
  viewer may call now: release, move, decide), so the UI never derives policy itself.
- `workItem.stage.get` (read, member): `{workItemId, stageId}` → the stage's surface data: steps,
  artifacts, evidence, the packet, the run. One read per surface.
- The desktop app maps each `SurfaceId` to a screen in `apps/desktop`. A new type with an existing
  surface needs no UI change; a new surface is a new screen (Preview is the first).

## Build plan
Small PRs, each leaving main working. Nothing starts before **When to start** holds.

1. **This PR (docs).** Spec 52, ADRs 0500–0504, the amendments, the block claim.
2. **The contract, the registry and validation** (`packages/core/src/stages/`). The types above;
   descriptors for `triage`, `interview-planning`, `written-spec`, `agent-check`, `decision`,
   `build`, `checks`, `publish` (with `next()` not yet used); `WorkflowDefinition`'s schema,
   `validateWorkflow`, `workflowImpact`; the Software and Attached PR templates;
   `compileProjectWorkflow`. Tests: every rule, and every existing project config compiles to a
   valid definition. No runtime use.
3. **The generic review packet.** `ReviewPacket` gains `subject`, and evidence items carry their
   digest; today's packet rows read through an adapter; `factory/verify` and the packet screen
   unchanged. Tests: the existing verify and packet suites pass unchanged.
4. **Org config: workflows and agents at the org** (migration 0270). `core_org_configs`,
   `workflow.*`, `agent.*`, the migration above, project config's `workflow` by id. The engine's
   `planWorkflow()` reads the compiled org workflow and returns the same plan. Settings page: the
   Workflows and Agents pages move to the org (UI screenshots in the PR).
5. **Skills** (migration 0271: `core_skill_versions`). The schema, the org config's `skills` map
   and attachments on agents and slot steps, `resolveSkills`, `skill.*`, the trial path through
   ADR 0373's machinery with a person's accept, the `skills` job field and channel route, and the
   Claude adapter's projection (new files in `harness-claude` and the runner host, the smallest hook,
   said in the PR). It works on today's Workflow v6: a stage-type built-in skill waits for PR 2's
   registry, attachments to slot steps and agents don't. The Skills page (screenshots).
6. **Autopilots** (migration 0272: `core_autopilot_runs`, the `autopilot` kind and actor). The
   config, `autopilot.*`, firing from the cron and the outbox with dedupe keys, the one-stage
   autopilot run on Workflow v6's job path (a fixed `runAutopilot`, chosen by kind like
   `runAttached`), the per-output allowlists and the `autopilot` actor's denies in `gate.ts`. Ships
   with "Backlog triage" and "Red CI on main". The Autopilots page (screenshots).
7. **The reconciler in shadow** (migration 0273: `core_item_stages`, `core_item_steps`,
   `core_reconcile_shadow`, `core_work_items.reconcile_rev` and `next_check_at`). `reconcile()`,
   the snapshot loader and the type `next()`s for the Software types. It runs on the outbox and the
   cron for v6 items and **records** what it would do next to what the Workflow did. No item is
   driven by it. This is where the unmeasured costs get measured: divergence, D1 load, missed
   events.
8. **Preview, the first new stage type**, on the reconciler, for items whose workflow uses a type
   the skeleton doesn't have (so no Workflow instance exists to collide with). With it: `decision`
   and `agent-work` on the reconciler; runner jobs without a repository (`JOB_STAGES` + the
   `core_jobs` CHECK, migrated with the care #42 taught); media artifacts in R2 (ADR 0310); the
   Preview screen in `apps/desktop` (new files, the smallest hook into the shell). A Marketing
   project can run Brief → Draft → Preview, ending at Done after the decision.
9. **Publish through a connector, and Measure.** The `publish` risk class in `ALWAYS_REVIEW`, the
   first non-GitHub connector, digest-bound approval enforced in the action's operation, `measure`.
   The Marketing template becomes complete.
10. **The board's lanes from the workflow.** `workflow.lanes`, the `workItem.board` additions, the
   desktop board (screenshots).
11. **Software on the reconciler.** Once shadow mode shows no divergence over an agreed number of
   items (open question 14), new Software items start on the reconciler; v6 instances drain.
12. **Delete Workflow v1–v6** when no open item runs them.
13. **Preview for software**: start the app on a runner with `browser` and attach the live
    preview as evidence (the review's item 6), a stage between Verify and Merge.

## When to start
Not before the software line runs well: verify passes on factory PRs without manual rescue (spec 51
landed), spec 50's backlog and release are in use, and the factory's share of merged PRs is the
headline number and rising (the review's "Order"). The owner says when.

## Open questions for the owner
1. **Is triage a shaping stage?** Shaping stages need a person; triage doesn't, but it sizes the
   item, which shaping (planning) depends on. Spec 50 part C moves planning before release. Should
   Software's triage and planning both become shaping, with triage allowed as the one shaping stage
   that needs no person?
2. **Does Publish always carry its own decision?** Today's merge gate is the decision on the
   packet, so for software it's one click. For marketing, Preview's approval and Publish's approval
   are two clicks on the same reel. Can an approved Preview decision on the same digest stand in for
   Publish's, when Publish follows it directly?
3. **Do tightening changes reach running items?** ADR 0370 tightens *who decides* for running work.
   Should a new workflow version that adds a gate stage also move running items onto it, or only
   new ones?
4. **Re-pin at release?** An item may sit in shaping for weeks. Should it take the current version
   at release when its shaping stages are unchanged, or keep its pin?
5. **Where do today's per-project stage settings finally live?** `spec.requiredFrom`, `retryLimit`,
   the review packet's sections and protection's required checks differ per project today. Stage
   settings in the org workflow, or per-project overrides of an org workflow (and which overrides
   are allowed)?
6. **Who edits an org workflow?** Org admins only, or project admins too for a workflow only their
   project uses? Who approves an org-level loosening: org owners and admins, or the approvers of
   every project that uses it?
7. **The org-wide board with several workflows**: one board per workflow, swimlanes per workflow,
   or columns collapsed to phase (Backlog | Shaping | Ready | Queued | Delivery | Done)?
8. **Slot steps as lanes**: today's slot steps become stages, so each is a lane. Is that wanted, or
   should a small `agent-check`/`decision` stage show inside the lane before it?
9. **Measure after Publish**: is the item Done when it posts (Measure a follow-up), or does it stay
   active, counting against `activeLimit`, until the numbers are in?
10. **Attached PRs and incidents**: keep their workflows as fixed built-ins chosen by kind, or show
    them as org workflows people can see and tighten?
11. **The incident auto-merge exception (ADR 0230)** is an irreversible merge with no person's
    decision. The decision says the engine refuses that. Keep the exception (in code, check-only
    fixes, opt-in), or drop it?
12. **The adjudicator (ADR 0374)** may approve spec gates and gate steps. May it approve Preview
    decisions? (Publish never: `ALWAYS_REVIEW`.)
13. **The improver (ADR 0373)** trials practice changes per project. With org workflows, is a trial
    per workflow across all its projects, or still per project?
14. **The reconciler (ADR 0501)**: confirm it over keeping the replayed Workflow, and say how many
    shadowed items with no divergence are enough to switch Software over.
15. **Interview planning without a repository**: the planning session keeps its artifacts in
    `.kim/` in the repo (ADR 0305). For a Marketing brief, R2 attachments instead?
16. **Org skills on the judge.** Should org skills reach the Checks reviewer at all? This spec allows
    `extend` only, as a policy change (the design attaches "Walk the app in a browser" to the
    Reviewer in Verify), which relaxes ADR 0371 §5's "project text never reaches the reviewer".
17. **Agent instructions under the skill rule?** Skill edits need a person's accept; agent
    instructions are still applied by the improver's trials alone (ADR 0373). Same rule for both?
18. **Autopilot runs as work items.** This spec makes each run a hidden work item of kind
    `autopilot`, to reuse runs, transcripts and the kill switch. Or a separate run record with no
    work item?
19. **An autopilot's budget.** There is no budget yet (the review's item 9). Is a per-run time limit,
    an output cap and a daily run cap enough until there is, and is the budget per org or per
    autopilot?

## Out of scope
Loadable third-party stage types; parallel stages and branches; a stage type editor for code
(types are code); items spanning several projects; anything that lets a workflow, template or
agent remove a gate the floors require.

## Acceptance criteria (for the build, per PR above)
1. `validateWorkflow` refuses each F-rule and S-rule violation with the stage and rule, with a test
   per rule; no definition that breaks a floor can be saved, imported or migrated.
2. Every existing project config compiles to a valid definition, and `planWorkflow()` gives the
   same plan for every project before and after the org migration.
3. `workflowImpact` classifies each case listed above, with a test per case; an unknown change
   loosens; a loosening `workflow.save` waits for an approver.
4. A publish action is refused without an approved decision on the digest it acts on, and a new
   digest withdraws the old decision (tests for `media` and `pull-request`).
5. In shadow mode the reconciler records a next action for every v6 transition, and the divergence
   report is readable per item.
6. A Marketing project with no repository runs Brief → Draft → Preview → Publish → Measure on the
   reconciler, with the decision bound to the reel's sha256.
7. The board's lanes come from `workflow.lanes`, and the four fixed lanes are the same for every
   workflow.
8. v1–v6 instances drain unchanged while new items run on the reconciler; `workflow-versions.test.ts`
   keeps passing until `work-item.ts` is deleted.
9. A run records the exact skill versions it loaded; a path-conditioned skill is included when its
   paths match or nothing is known yet, and not when the known paths don't match.
10. A skill edit proposed by the factory changes nothing until a person accepts it; accepted, it
    runs as a trial and is promoted or rolled back on outcomes. An edit to a protected skill is
    `self-modify`.
11. An autopilot run can't merge, deploy, auto-merge or change config even with an approval (deny
    for the `autopilot` actor, with a test per risk class); its `queued` output is created `ready`
    where `release.agents` is false; outputs past `maxOutputs` are refused; the same trigger
    occurrence never fires twice; an event never fires on an autopilot's own output.
