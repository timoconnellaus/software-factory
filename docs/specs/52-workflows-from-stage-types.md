# Spec 52: Workflows built from stage types

Status: **decided, being built.** The owner decided the direction on 2026-11-12, answered every open
question the same day (see "Decisions", which replaces the open questions), and asked for the build
to start. The build is the staged plan at the end, one small PR at a time, each leaving main working.

Read first:
- ADRs [0510](../adr/0510-workflows-are-ordered-stages-of-stage-types.md) (the model),
  [0511](../adr/0511-a-reconciler-runs-the-stage-list.md) (the engine),
  [0512](../adr/0512-the-review-packet-is-artifact-evidence-and-decision.md) (the packet), [0513](../adr/0513-skills-are-shared-by-the-org-and-attached-where-used.md)
  (skills), [0514](../adr/0514-autopilots-file-work-they-never-ship-it.md) (autopilots) and
  [0515](../adr/0515-merges-may-be-approved-automatically-dark-factory-mode.md) (dark factory mode),
  each amended with the owner's answers.
- What they change: ADRs [0005](../adr/0005-hybrid-coordinator.md), [0006](../adr/0006-work-item-workflows.md),
  [0008](../adr/0008-autonomy-presets-and-floor.md), [0230](../adr/0230-check-only-incident-fixes-auto-merge.md) (superseded),
  [0373](../adr/0373-the-factory-improves-its-own-practice.md), [0374](../adr/0374-the-adjudicator-earns-approval-in-shadow-mode.md),
  [0053](../adr/0053-workflow-versioning.md), [0370](../adr/0370-factory-config-lives-in-the-app.md),
  [0371](../adr/0371-workflows-are-presets-over-typed-slots.md), [0372](../adr/0372-agents-are-harness-neutral.md),
  ADR [0492](../adr/0492-a-project-runs-one-workflow.md) (a project runs one workflow) and
  [0493](../adr/0493-shaping-stages-run-before-release.md) (shaping before release).
- Spec [09](09-factory-config-in-the-app.md) M2 (workflow slots, as built) and spec
  [50](50-projects-backlog-and-release.md) (projects, backlog and release, merged), which keeps the
  fixed work-management states apart from a workflow's stages.
- Code: `apps/engine/src/workflow/work-item.ts` (Workflow v7 on main), `packages/core/src/policy/project-policy.ts`
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
  Removing or weakening a gate is a loosening, so only a person can do it. The one way a merge (and,
  once it exists, a deploy) goes ahead with no person is **dark factory mode**: a setting on that
  gate, which only a person can turn on, under conditions checked in code (ADR 0515, below).
- **Skills and autopilots** (added by the owner the same day). A skill is how the team does one
  thing, written once, owned by the org and shared by every agent; it attaches to an agent, to a
  step in a workflow (optionally with a condition), and stage types ship their own. An autopilot is
  a trigger, an agent, its skills, an instruction and an output target; what it files goes through
  the same backlog and workflow, it never merges or deploys, and it releases work only where policy
  allows.
- **Held back.** No loadable third-party plugins: stage types are built-in code in the repo, with a
  typed contract.

## What main has today
- **One fixed skeleton in code** (ADR 0371, Workflow v7): triage → spec (when sized) → spec gate →
  [release, for a shaped item] → build → verify → merge gate → merge queue. Each work item is one
  Cloudflare Workflow instance that replays `run()` and matches steps by name (ADR 0006, 0053). Seven
  versions share `runV1` with steps switched on by version; attached PRs take `runAttached`, chosen
  by kind. Open PRs take v8 (#73, spec 51) and v9 (planning); this spec's first engine change, if it
  needs one, takes **the next free version at merge time** (the version rule: a PR claims the
  Workflow version when it merges, not when it is planned).
- **Three slots** (`afterSpec`, `beforeVerify`, `afterVerify`) take `work` steps (an agent,
  advisory: pass, send back, ask) and `gate` steps (a person, through `workflow.gate`, which is
  `alwaysReview`). A named workflow fills the slots. Workflows and agents live in each **project's**
  config version (ADR 0370), and `planWorkflow()` resolves them before build.
- **Stage names are software's.** `STAGES` in `packages/core/src/operations/shared.ts` is `intake,
  triage, spec, build, verify, merge, done`; `JOB_STAGES` in the runner contract is `triage, spec,
  planning, build, verify`, and `core_jobs.stage` has a CHECK on it.
- **Spec 50 (merged)** added repositories per project, the states `backlog`, `ready`, `queued` and
  `shaping`, release and the pull, an `activeLimit`, one workflow per project (ADR 0492) and shaping
  before release (ADR 0493: triage and interview planning are the shaping stages, `STAGE_PHASE` in
  core). It dropped the CHECK on `core_work_items.stage`, so a workflow-defined stage needs no table
  rebuild. It lists org-level workflows as a follow-up: this spec.
- **Gates in code.** `ALWAYS_REVIEW` (`merge`, `deploy`, `self-modify`) always goes to a person in
  `invoke()`. One exception exists: a factory incident's check-only fix may auto-merge
  (`check-merge`, ADR 0230) where the project opts in. ADR 0515 replaces that exception with dark
  factory mode (build plan PR (e)); until then it stays as it is.

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
- **Review packet**: an artifact, its evidence, and a person's decision on that exact digest (ADR 0512).
- **Skill**: how the team does one thing, written once (instructions plus files), versioned, owned
  by the org, attached to agents, stages and stage types (ADR 0513).
- **Autopilot**: a trigger, an agent, its skills, an instruction and an output target; work the
  factory starts on its own, filed through the same backlog (ADR 0514).
- **Workflow template** / **stage template**: a ready-made workflow, or a stage type with default
  settings, shipped in code, copied into an org and edited there.
- **Built-in workflow**: a workflow shipped in code and chosen by an item's kind, not by its project:
  Attached PR and Incident. People see it and may tighten it, never loosen it (Q10).
- **Override**: a project's value for one of the few stage settings a project may change (Q5).
- **Dark factory mode**: the `autoApprove` setting on a merge (later deploy) gate (ADR 0515).

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
  /**
   * Who besides a person may decide it, once earned or set: the adjudicator (plan, step and preview
   * gates, ADR 0374), or `autoApprove` (merge and deploy gates only, ADR 0515). Code, not settings.
   */
  delegable: readonly ("adjudicator" | "autoApprove")[];
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

/** The persisted state of one stage for one item, as the reconciler reads it (ADR 0511). */
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
  /** Bumped when the persisted step state changes shape; old versions stay until drained (ADR 0511). */
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
  /** The one exception to F3: a shaping stage that needs no person. Only `triage` sets it (Q1). */
  shapingWithoutPerson?: true;
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
| `triage` | shaping or delivery; the one shaping type that needs no person (Q1) | agent (size, domains, readiness, criteria; may ask) | brief (sized) | none | internal | light pool, role `triage` |
| `interview-planning` | shaping or delivery | agent session (spec 20), questions, chat, mockups; decision | plan, spec | `spec`, conditional on size (`requiredFrom`) | internal | light pool; the plan and mockups in the repo's `.kim/`, or in R2 attached to the item when the project has no repository (Q15) |
| `written-spec` | shaping or delivery | agent drafts, questions in rounds, decision | spec | `spec`, conditional on size | internal | light pool (Workflow v1–v4's spec rounds) |
| `agent-check` | delivery | agent, advisory: pass, send back, ask | evidence only | none | internal | today's `work` step; read-only job |
| `decision` | shaping or delivery | decision | none | `step`, required | internal | today's `gate` step (`workflow.gate`) |
| `build` | delivery | agent in the repository; merge the default branch first | git-head | none | internal | heavy pool, repository, role `implement` |
| `checks` | delivery | op (open PR), checks on the SHA, CI, reviewer agent, packet | pull-request, evidence | none | reversible-outside | heavy pool, repository, `github` |
| `preview` | delivery | op (start the preview), evidence, decision | preview-url, evidence | `preview`, required; the adjudicator may take it once earned (Q12) | reversible-outside | per settings: `browser` capability for an app; R2 for media |
| `publish` | delivery | decision, then the action through a connector | external-ref | `merge` / `publish` / `deploy`, required; `merge` and `deploy` take `autoApprove` (ADR 0515); a person's Preview approval on the same digest stands in for it when Publish follows directly (Q2) | irreversible | the connector named in settings |
| `agent-work` | delivery | agent on a runner without a repository, files to R2 | file, media | none | internal | light or heavy per settings; runner support for no-repo jobs |
| `measure` | delivery | op (read numbers through a connector) after a delay | metrics | none | internal | the connector; runs in a follow-up item, never holding the published item open (Q9) |

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
- **F3** Shaping stages need a person: the type's `needsPerson` is true, or it is `triage`
  (`shapingWithoutPerson`, Q1). A workflow whose shaping stages are only triage is valid: an item
  released from the backlog is triaged and goes on.
- **F4** Shaping stages act on nothing outside: `reversibility` is `internal`.
- **F5** Every kind a stage `consumes` is produced by an earlier stage, or is `brief`.
- **F6** **The irreversible floor.** A stage whose type is `irreversible` has an `action` with a
  risk in `ALWAYS_REVIEW` and a `required` person gate on the action's artifact kind, decided
  inside the stage before the action. At run time the action is refused unless an approved
  decision exists on the **same digest** it acts on (ADR 0512); a newer digest needs a new decision.
  The decision is a person's, or (for `merge` and `deploy` only) the `auto-approve` actor's when the
  gate's `autoApprove` is on and `autoApproveVerdict()` passed on that digest (ADR 0515), or a
  person's Preview approval on that digest when Publish follows the Preview directly (Q2), or the
  adjudicator's Preview approval under the same condition only when the Publish gate's `autoApprove`
  is on and its conditions hold for that digest (Q2 × Q12, (decided by the owner, 2026-11-12)). No other actor's decision counts. `autoApprove` on a `publish` (social) or `self-modify` gate is refused.
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
  A stage whose judge is the factory's own reviewer (Checks) takes no org agent: an agent's instructions
  would reach the judge (Q16, ADR 0516).

### The impact check
`workflowImpact(before, after, registry)` extends `policyImpact` (ADR 0370 §3). Each change is
`loosens`, `tightens` or `neutral`. It is an **allow-list** (ADR 0516): a change is neutral or
tightening only if a rule says so; anything else, including any reorder, any removal, an unclassified
setting and an unmigratable type version, loosens. A re-added id is compared with its archived version,
a new workflow with the Software floor.
- A stage with a gate removed, or a `required` gate's stage removed: **loosens**.
- A conditional gate's condition widened (for example `requiredFrom` medium → large): loosens;
  narrowed: tightens.
- A `checks` stage removed, an evidence requirement dropped, or a `when` added to or widened on a
  `checks` or `agent-check` stage: loosens.
- A decider broadened (a named person → approvers): loosens; narrowed: tightens.
- `autoApprove` turned on, a limit raised, a path removed: loosens; the reverse tightens (ADR 0515).
  A project's `autoApproveHold` set: tightens; lifted: loosens. A project switching to a workflow
  with `autoApprove` on: loosens.
- A project override that loosens against the org workflow's value loosens; one that tightens
  tightens (Q5).
- A stage added that only checks or gates, for every item: tightens. That includes a stage whose
  type would produce an artifact an earlier, unconditional stage already produces (a second
  `checks` stage after the first): it checks the existing pull request, it opens none. A stage added
  that acts outside the factory, irreversibly (a merge, a publish, a deploy) or as a reversible
  outward write it makes itself (the pull request the first `checks` stage opens), is an action
  gained: loosens, though it has a gate.
- A stage moved: loosens if it moves a gate or a check later past a stage that produces what it
  checks, otherwise neutral.
- What a judging stage is told (an `agent-check`'s or a `decision`'s `instructions`, the criteria or
  thresholds it judges by): any change loosens. Free text can't be shown to only add requirements
  ("…; then pass everything" overrides what came before), so the classifier doesn't try. The same
  holds for an org agent that judges work in a workflow (Q16).
- Other agents' instructions, tiers, names: neutral, and **practice** for the improver (ADR 0373).
- Each type's own `impact()` classifies its settings.
- A project switching workflows compares the two definitions the same way (ADR 0492 §3).

A loosening save is `self-modify`: a pending action for an approver, judged under the current
version (ADR 0370 §4). **Org admins** edit org workflows and approve their loosenings (Q6); the org
floor may require more. A project override that loosens is approved the same way. An org admin may
approve their own loosening: the owner runs a one-person org (see "Flagged").

## Where workflows and agents live
- **An org config version** holds `agents` and `workflows`, with the same machinery as a project's
  config (ADR 0370): versions written only through operations, validation before save, the impact
  summary on the server, rollback, export and import. Migration 0280 adds `core_org_configs`
  (org id, version, document, source, created_by, note, parent_version) and
  `core_orgs.config_version`.
- **A project's config keeps policy**: autonomy and overrides, approvers, backup owner, timeouts,
  `wipLimit`, `activeLimit`, `release.agents`, protection, the harness ceiling. It names its
  workflow by id (`workflow: "wf_…"`, replacing ADR 0492's name).
- **Stage settings live in the org workflow (Q5)**, with a short, fixed list of settings a project may
  override, in the project's config as `workflowOverrides: { [stageId]: { … } }`:

  | Override | Stage type | Today's source |
  | --- | --- | --- |
  | `requiredFrom` (when a plan is required) | `interview-planning`, `written-spec` | `spec.requiredFrom` |
  | `retryLimit` | `build` | `retryLimit` |
  | `sections` (review packet sections and their order) | `checks` | `reviewPacket.sections` |
  | `requiredChecks` (checks that must report on the SHA) | `checks` | `protection.requiredChecks` |

  The list is code (`OVERRIDABLE` per stage type); anything else is refused. `autoApprove` is
  deliberately **not** on it: dark factory mode is per workflow (ADR 0515); a project that wants it
  runs a workflow that has it on. The project config carries only `autoApproveHold`, the per-project
  switch-off. An override is checked
  by the type's `impact()` against the org workflow's value: one that loosens is `self-modify`, so an
  org admin approves it (Q6). The resolved definition (org workflow plus the project's overrides) is
  what an item pins.
- **A work item pins** its project config version (as today), the org config version and the
  workflow id when it enters its first stage. The pinned definition is its stage list for life,
  unless a person moves it (below).

## How the engine runs a stage list
Two ways were compared. The recommendation is the reconciler (ADR 0511, proposed until the owner
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

### Decided: the reconciler (Q14)
The owner chose B. Data-defined stage lists make step names a function of data and of every type's
code, which is exactly where ADR 0053's rule hurts most; the reconciler removes that rule instead of
extending it. It also gives one state of record and a tick that heals lost events. The cost is real
but bounded and is measured before anything depends on it: the reconciler runs in **shadow** next to
today's Workflow, recording what it would do, and takes no item until it **agrees on 20 items in a
row**: 20 consecutive finished items whose every transition it predicted, with any divergence
resetting the count (build plan PR (c)). The switch-over is its own PR, approved by a person.

**Known differences in shadow, to settle before the streak can count.** Each is reported under its
own name in the item's report (`known`), not as a generic divergence, and counts as a divergence
until it is settled:
- `queue-head-moved`: when the head moves in the merge queue, today's Workflow merges the default
  branch into the branch, waits for CI on the new head and lands with the same approval (ADR 0330),
  while the reconciler's `publish` stage sends the item back to Checks and reopens the merge gate.
  The babysitter (spec 53, PRs #103 to #105) changes exactly this: its deliverer lands approved
  merges, and an approval survives a clean merge of main only while the change is the same. Settle
  the reconciler's rule with spec 53 as built, then drop the name. The shadow pass sees it as a
  review packet the queue carried to a new head (`carriedFrom`).

## The review packet: artifact, evidence, decision
Today's packet (ADR 0020, 0037, 0041) is a verdict, what changed, criteria with evidence, the
reviewer, checks, risk flags and drift, for one head SHA, and it backs `factory/verify`. The same
shape serves any workflow (ADR 0512):

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
- **One approval for Preview and Publish (Q2).** A person's approval of a Preview also approves the
  Publish stage that follows it directly, when nothing changed: the same digest, no stage between
  them, no new evidence since. Publish then records the Preview's decision as its own and acts. Any
  change (a re-render, a stage between them) needs Publish's own decision. An approval by the
  adjudicator (Q12) carries over only in a workflow whose Publish gate has `autoApprove` on and whose
  conditions hold for that digest; otherwise Publish asks a person (decided by the owner, 2026-11-12). Since `autoApprove` is
  refused on a `post` action (F6), an adjudicator's Preview approval never publishes a post.
- **Dark factory mode (ADR 0515)** decides the merge gate's packet as the `auto-approve` actor when
  every condition holds for the head SHA; the decision records the facts it checked.

## Today's stages as stage types (no behaviour change)
The **Software** workflow below reproduces today's Workflow (v7) exactly. The table says where each part goes.

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
| incident check-only auto-merge (ADR 0230) | the merge gate's `autoApprove` (ADR 0515) | Kept as today until PR (e); then an incident's fix merges with no person only under dark factory mode, like any change (Q11). |
| incidents (`kind = 'incident'`, the Software path) | a built-in **Incident** workflow: the Software stages, `triage` in delivery (an incident is never shaped) | Chosen by kind. Visible, tighten-only (Q10). |
| attached PRs (`runAttached`) | a built-in **Attached PR** workflow: `checks` (waits for pushes, no build) → `publish` (merge, direct) | Chosen by kind, not by the project, as today. Visible, tighten-only (Q10). |

**The send-back rule** that makes this exact: a `sendBack { to: kind }` returns the item to the
nearest earlier stage that produces `kind` (for code, `git-head`: build), with the note; every
stage after it runs again in order. If no earlier stage produces it, the note is carried to the
next stage that does.

**The three slots** are positions in the list: after the planning stage, after build, after checks.
The slot step types (`work`, `gate`) become the `agent-check` and `decision` stage types. On the board
they show **inside the stage they belong to**, not as lanes of their own (Q8): a stage whose type is
`agent-check` or `decision` is drawn as a step of the nearest earlier full stage (the lane the item
stays in), with its own status line. A workflow made only of small stages after a full one has that
one lane.

**Built-in workflows (Q10).** Attached PR and Incident ship in code and are chosen by the item's kind.
Every org sees them under Workflows, read-only, with **Tighten**: an org admin may save a version that
only tightens (add a check or decision stage, narrow a decider, require more evidence). A save whose
impact has any `loosens` change is refused outright (`invalid_input`), not sent for approval; an
org's tightened copy keeps the built-in's id with an org version. **"Never loosen" is measured
against the shipped built-in**, not the org's last version (decided by the owner, 2026-11-12): an org may undo its own tightening
back to the shipped definition, and that undo is a loosening against the org's version, so it is a
`self-modify` save an org admin approves. A save looser than the shipped built-in is refused.

**Slots on the runner side**: `agent-check` jobs stay read-only `verify`-stage jobs (spec 09 M2 as
built). No `JOB_STAGES` change is needed for the Software workflow. `agent-work` (no repository)
needs one, and `core_jobs.stage`'s CHECK needs the table rebuild that broke production in #42, so
that type waits for a careful migration (build plan, later PRs).

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
      // Triage and planning are shaping (Q1, ADR 0493). An item released straight from the backlog
      // runs them after release, on the light pool, as today.
      id: "triage", type: "triage", typeVersion: 1, name: "Triage", phase: "shaping",
      agent: "Triage",
      settings: { mayAsk: true, readiness: true },
    },
    {
      id: "spec", type: "interview-planning", typeVersion: 1, name: "Spec", phase: "shaping",
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
        // Dark factory mode (ADR 0515): off unless an org admin turns it on.
        autoApprove: { enabled: false, maxChangedLines: 200, maxFiles: 10, forbiddenPaths: [], riskPaths: [] },
      },
    },
  ],
};
```

Stage ids match today's `STAGES` (`triage`, `spec`, `build`, `verify`, `merge`), so the board and
`core_work_items.stage` read the same as now. Backlog, Ready, Queued and Done are the fixed states
around them (spec 50).

## Worked example 2: Marketing

Brief by interview → Draft → Preview the reel → Publish. The project has no repository. The item is
**Done when it publishes**; Publish files a follow-up item to measure it (Q9).

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
      // Always: a brief needs a person whatever the size. With no repository, the plan and its
      // mockups are kept in R2, attached to the item (Q15).
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
      // A person's approval of the Preview on this reel's digest stands in for this gate (Q2).
      settings: {
        connector: "social", action: "post", account: "brand", decider: "approvers",
        // Q9: done at publish; measuring is a follow-up item in the same project, which runs the
        // built-in one-stage Measure workflow (chosen by its kind, like Attached PR).
        followUp: { kind: "measure", after: "7 days", metrics: ["views", "saves", "shares"] },
      },
    },
  ],
};
```

How the rules read it: `brief` is shaping, needs a person, light pool, internal (F1–F4). `preview`
consumes `media`, produced by `draft` (F5). `publish` is irreversible: its action's risk is
`publish` (added to `ALWAYS_REVIEW`, a tightening in code), and its gate is required on `media`; at
run time the post is refused unless the approval is on the reel's current sha256 (F6). A person's
Preview approval on that sha256 is that approval (Q2); `autoApprove` is refused on a `post` action. Nothing
merges into a repository, so F8 doesn't apply, and the project needs no repository (F9). It needs
the `social` connector connected, which doesn't exist yet (build plan, later PRs).

## Migration from per-project workflows to org-level ones
Each step keeps behaviour identical; a test compares `planWorkflow()` for every project before
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
   removed. `spec.requiredFrom`, `retryLimit`, `reviewPacket.sections` and the required checks become
   the org workflow's stage settings; where a project's value differs from the org workflow's, it
   becomes that project's override (Q5), so behaviour is identical. The old fields stay readable in
   the project config until every item pinned to an older version is done, then they are dropped.
5. **In-flight items** keep their pinned project config version and Workflow instance. They
   drain unchanged.

## Versioning while items are in flight
- **The definition is pinned** at the item's first stage (org config version + workflow id). A new
  version of the workflow applies to items that enter their first stage after it is saved.
- **Gate strictness still uses the stricter** of the pinned and the current *project* config
  (ADR 0370 §5): who approves and the autonomy decision tighten for running items, never loosen.
- **Tightening reaches running items (Q3).** When a saved version only tightens against an item's
  pinned one (`workflowImpact` has no `loosens`), the item moves onto it at its **next stage
  boundary**, automatically, journaled as `workflow: repinned`. Gates and checks added *ahead* of the
  item apply to it; ones added before its current stage don't apply retroactively (the item doesn't
  go back). A version that loosens anything never moves a running item.
- **Moving an item by hand** is `workItem.moveWorkflowVersion` (human): allowed at a stage boundary
  when the item's current stage exists in the new version with the same id and type, and every stage
  already done exists unchanged. If the move loosens for that item, it needs an approver.
- **Release takes the current version (Q4)** when the item's shaping stages are unchanged in it (same
  ids, types and settings, in the same order). Otherwise release doesn't guess: the item is
  **flagged** on its card and in the inbox ("planned under v3; the shaping stages changed in v5"),
  and the person releasing it chooses to shape it again under the current workflow, or to accept
  the shaping already done and deliver it under the current workflow (amended 2026-11-13 from the
  owner's answer: delivery always runs on the current version, so no one can skip a tightening by
  releasing under an older one). `workItem.release` doesn't release it without that choice; an
  agent's release leaves it flagged. Only a person chooses.
- **Stage-type code**: a type's `version` changes only when its persisted step state changes
  shape. Each stage entry records the version it started on; the registry keeps old versions'
  `next()` until `core_item_stages` has none open, then deletes them. Prompt and logic changes that
  keep the state shape reach in-flight items at once (tested on recorded snapshots first).
- **Old Workflow versions**: every version up to the last one replayed stays until no open item runs on the replayed Workflow, then
  `work-item.ts` is deleted (ADR 0053's rule, applied one last time).

## Skills
Added by the owner on 2026-11-12 (ADR [0513](../adr/0513-skills-are-shared-by-the-org-and-attached-where-used.md)).
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
  and org text reaching them is restricted (ADR 0371 §5): org skills may only **add to** its built-in
  skills (`extend`, or a new attached skill), never replace them, and adding, editing or removing one
  is **policy**, a change a person approves (`self-modify`), never practice (Q16). The design attaches
  "Walk the app in a browser" to the Reviewer in Verify; this is the rule that allows it.

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
  change can't land unapproved).
- **Agent instructions follow the same rule (Q17).** The improver's instruction edits (spec 09 M3,
  which today applies them as trials by itself) become proposals: `agent.propose` puts the diff in
  the inbox, a person accepts it, and only then does the trial start. Trials stay **per project**
  (Q13): an accepted edit trials on that project's items; making it the org's is a person's org
  config save.

### Operations
`skill.list`, `skill.get` (read, member: versions, attachments, runs that used it); `skill.save`,
`skill.attach`, `skill.detach`, `skill.archive` (human, org admin, through the org config version
and its impact check); `skill.propose`; `skill.accept` / `skill.reject` (human, browser-only);
`skill.trials` (read). The runner channel gets `GET /runner/v1/jobs/:id/skills/:slug` for bodies
and files, scoped by the job and fenced by its lease.

## Autopilots
Added by the owner on 2026-11-12 (ADR [0514](../adr/0514-autopilots-file-work-they-never-ship-it.md)).
Design: `docs/design/factory-ui/FactoryAutopilots.html` on PR #61.

An **autopilot** is work the factory starts on its own: a **trigger** (a schedule or an event), an
**agent**, the **skills** it follows, an **instruction** and an **output target**. What it files
goes through the same backlog and workflow as anything else. It never merges or deploys, and it
releases work only where policy allows. It runs on a light slot, under its own limits (Q19).

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
own small job, like an incident) and doesn't count against `activeLimit`.
- **Hidden only from the Work lists (Q18).** The owner asked "why hidden?"; the answer, which they
  accepted: each run is a full work item, shown as **run history on the autopilot's own page**
  (transcript, outputs, time); it is left out of the Work lists and boards only so they show work,
  not the factory's housekeeping. Anything a run produces for a person (an item it filed, a
  proposal, a digest) appears in Work or the Inbox, linked back to the run.
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
  item 9). Until then the limits above are the budget, **per autopilot** (Q19): a time limit per run,
  a cap on how much one run can file, and a daily run cap.
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
stages | Done. Small stages (`agent-check`, `decision`) show inside the stage they belong to, not as
lanes (Q8). **The all-projects board**, where projects run different workflows, shows **columns by
phase**: Backlog, Shaping, Ready, Queued, Delivery, Done (Q7); each card names its stage. An item in a shaping stage has status `planning` (spec 50), shown under its stage.
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

## Dark factory mode (ADR 0515)
The owner's answers to Q11 and Q20–Q23, and their confirmation afterwards: auto-approving merges is
"just a config option, nothing special". It is a **setting on the workflow** (the merge stage's
`autoApprove`), off by default, never a per-project override.

- **Who turns it on.** It is ordinary versioned config written through `workflow.save`. Turning it on,
  raising a limit or removing a path is a loosening (`self-modify`): an org admin makes it and an org
  admin approves it (Q6). No agent, the improver, the adjudicator or an autopilot can.
- **When it merges with no person** (all of them, evaluated by `autoApproveVerdict(facts, setting)`
  in `packages/core/src/policy/auto-approve.ts`, called by the Workflow at the merge gate):
  1. every check passed and every acceptance criterion is proven by a check that ran on the head SHA
     (spec 51; the packet's verdict is `pass` and `factory/verify` is green);
  2. tests intact on that SHA (ADR 0500);
  3. the adjudicator approved this SHA and is **active** for `merge` on this project, having earned it
     under ADR 0374's bar (20 shadow verdicts on this project's merge gates, 95% precision);
  4. the change is inside the limits: `maxChangedLines` (default 200) and `maxFiles` (default 10)
     from GitHub's compare, and no path in `forbiddenPaths`;
  5. the item's risk is low: no path in the code-owned `RISK_PATHS` floor (migrations, auth, billing,
     secrets and env files, `.github/`, `.factory/`, lock files without a manifest change) or the
     workflow's `riskPaths`, and not a change to the factory itself: no path in the built-in,
     non-removable `SELF_MODIFY_PATHS` (`.factory/` and the policy, gate, registry, operation,
     stage and workflow code, `AGENTS.md`, `docs/adr/`) (decided by the owner, 2026-11-12). It applies in every workflow on every
     repository; the workflow's `riskPaths` only adds to it.
  Anything else, or a fact that can't be read, goes to a person as today; the card says which
  condition sent it.
- **It approves; it doesn't merge.** The setting auto-**approves** the merge gate when the five
  conditions hold. The merge itself, keeping main green and following the deploy belong to the
  babysitter that lands approved work, whether a person or this setting approved it: see
  [spec 53](53-the-babysitter-delivers-approved-work.md) (ADRs 0580–0589). Spec 52 specifies no merge
  mechanics. An engine-made revert is auto-approved only under its own per-workflow switch (off by
  default) and never when it touches `SELF_MODIFY_PATHS` (ADR 0515 rule 5).
- **Merge and deploy.** Merge approvals now; deploy approvals once a deploy stage with a health check
  exists. Never a
  `post` or other outside action, never `self-modify` (policy, workflows, agents, skills on the judge).
- **The per-project hold.** On an incident in the project, a revert of a merge it approved, or CI red
  on the default branch after one of its merges, the factory writes the project's `autoApproveHold`
  (a system-written tightening) and puts a card in the inbox for the project's approvers and the org's admins, showing
  what went wrong and the merges since the last green. The shared workflow is never edited; other
  projects on it carry on. Lifting the hold is a loosening: **an org admin** lifts it and an org admin
  approves it (Q6; decided by the owner, 2026-11-12); a project approver who isn't an org admin sees the card but can't lift it.
- **Sampling doesn't hold merges** (decided by the owner, 2026-11-12). ADR 0374's "every fifth approval to a person" does not
  hold a merge when `autoApprove` is on: the sampled merge is auto-approved like the rest and also
  goes to a person as a **review-after-merge** inbox item. The verdict feeds the adjudicator's
  precision; "this should not have merged" sets the per-project hold like a revert.
- **ADR 0230 goes.** From the Workflow version that adds this (PR (e)), an incident's check-only fix
  is an ordinary change under this mode; `pr.autoMerge` is no longer called.

## Build plan
Small PRs, each leaving main working and under about 1,500 changed lines. Block AI: migrations
0280–0289, ADRs 0510–0519. Workflow version: **the next free version at merge time** if a PR needs one (#73 holds v8,
planning v9; a PR claims its version when it merges).
No PR here touches the desktop app: its screens are other workers' (each PR lists the operations a
screen needs).

1. **PR 1 (docs).** The owner's answers in this spec and in ADRs 0510–0515, ADR 0515, the amendments
   to 0005, 0008, 0230, 0373, 0374 and AGENTS.md, CONTEXT.md and `architecture.md`.
2. **(a) Stage types as a registry, and Software as a built-in workflow. No behaviour change.**
   `packages/core/src/stages/`: `contract.ts` (the types above, without `next()` and the snapshot,
   which wait for (c)); one descriptor per type Software uses (`triage`, `interview-planning`,
   `agent-check`, `decision`, `build`, `checks`, `publish`) with its settings schema and defaults,
   phases, consumes/produces, evidence, surface, requirements, gate, reversibility and `impact()`;
   `registry.ts`; `workflow.ts` (the `WorkflowDefinition` schema); `validate.ts` (S1–S3, F1–F10);
   `builtins/software.ts`; and `compileProjectWorkflow(policy, name)`, which expresses a project's
   slot workflow as a definition (the Software stages with its slot steps as `agent-check` and
   `decision` stages). Tests: every rule, the registry's rules for each type, every slot layout and
   every built-in compiles to a valid definition, and `planFromDefinition()` gives the same plan as
   the engine's `planWorkflow()` for a table of project configs (the test lives in `apps/engine`).
   Nothing at run time reads it.
3. **(b) Org workflows as versioned config** (migration **0280**: `core_org_configs` and
   `core_orgs.config_version`). The org config document (`workflows`, `agents`), its versions with
   ADR 0370's machinery; `workflowImpact()`; operations `workflow.list`, `workflow.get`,
   `workflow.preview`, `workflow.save` (admin; `self-modify` when it loosens),
   `workflow.createFromTemplate`, `workflow.archive`, `workflow.rollback`, `stageType.list`,
   `workflowTemplate.list`. **Built-in workflows** Attached PR and Incident are listed read-only and
   accept only tightening saves (a loosening one is refused). Projects still run their own config
   and the engine is unchanged: org workflows are visible and editable but not yet used.
4. **(c) The reconciler in shadow** (migration **0281**: `core_reconcile_items`; as built, `core_item_stages`, `core_item_steps`, `reconcile_rev` and
   `next_check_at` move to the switch-over, since nothing writes them while the Workflow drives).
   As built in two PRs: (c1) `reconcile()` and `next()`, pure; (c2) the shadow pass, off the
   Workflow's path (a cron pass over the items that ended, one verdict row per item), which compares
   stage order and skips. Jobs and attempts, gates and who decided them, send-back targets and
   rounds, retry counts, slot steps and ends other than Done are not compared yet: each counts as a
   divergence on every item, and `reconcile.streak` reports "comparison incomplete: <what is
   missing>", never a number, until they are. `reconcile()`, the
   snapshot loader and `next()` for Software's types. It runs on the outbox and the cron beside the
   Workflow, drives nothing, and records what it would do next to what the Workflow did; a report
   per item and the **agreement streak** (consecutive finished items with no divergence). The
   **switch-over** is a separate PR, opened only when the streak reaches 20, and approved by the
   coordinator and the owner.
5. **(d) Projects on org workflows: overrides and pinning on release** (migration **0282**: project
   config's `workflow` by id, `workflowOverrides`, the migration of each project's slot workflow to the
   org, as described above). `OVERRIDABLE` per type; `planWorkflow()` reads the org workflow plus
   overrides and returns the same plan (the (a) table test again, before and after). Release takes the
   current version or flags the item (Q4); tightening reaches running items at the next boundary (Q3).
   May need a new Workflow version (the next free one at merge time) for the re-pin at release.
   **(d) also closes a live route on main** (see "Known gaps"): `policyImpact` classes a project
   config save that changes a slot workflow's steps or instructions, or an agent's instructions, as
   neutral (`packages/core/src/policy/impact.ts`, the `workflows` and `agents` branches), so any
   project member's `config.save` can tell a slot `work` step's judging agent to pass everything with
   no approval. (d) moves those steps onto the org workflow, where `workflowImpact` classifies them,
   and makes the project config's remaining step and agent-instruction changes loosen the same way:
   a test saves "pass everything" into a slot step and into its agent and expects `self-modify`.
   **As built so far:** (d1) closes that route (#120). (d2) lets a project name an org workflow by
   id (`workflow: "wf_…"`, or `wf_software`) with `workflowOverrides` (`overridable` per type:
   `requiredFrom`, `retryLimit`, `sections`, `requiredChecks`); `config.save` refuses an id the org
   doesn't have or an override a type doesn't list, and classifies an override or a switch by
   comparing the definitions (`configImpact`): one that loosens against the org's value is
   `self-modify`. Until the switch-over, today's replayed Workflow runs it: `effectivePolicy` turns
   the org workflow (with the overrides) back into the slot workflow, agents and settings the engine
   already reads, so no Workflow version is needed, and a workflow it can't run as written
   (`runsOnToday`: anything but Software's stages in order with checks and decisions in its slots,
   or a setting the engine would ignore) is refused at save and fails closed at run time. An item
   pins `org_config_version` (migration 0282) when shaping starts and again at the pull, beside
   `policy_sha`. After review: a save stores only the overrides that differ from the org's value,
   and at resolve time the stricter of the org's value and the override applies (`requiredFrom`: the
   smaller; `requiredChecks` and `sections`: both), unless an org admin approved that exact looser
   value for the org version being resolved (`core_override_approvals`, migration 0282, written only
   by the approve path; never read from a config document or an imported file, whose
   `workflowOverrideApprovals` field is dropped). A new org version carries an approval only where
   it leaves that setting's value unchanged; where the org moved it, the approval lapses, the
   stricter applies, and the org's admins are notified (`workflow.overrideLapsed`). A loosening of the org workflow (an override, or a switch that drops a check) is
   decided by an org admin: the pending action carries `decider = 'org-admin'` (migration 0282) and
   `approval.decide` asks for one. A judging stage is compared by what its agent is (role, tier,
   instructions, requirements), not its name. An org change that would leave a project unable to
   run (archiving its workflow, a save `runsOnToday` refuses, a rollback) is refused, naming the
   projects. A slot workflow already named like an org id (`wf_x`) stays a slot workflow; only new
   ones may not take such a name. The org config is parsed once per isolate and version, and polled
   reads that use nothing it decides (`skipsOrgWorkflow`) don't resolve it.
   (d3) builds Q4 as the owner answered it: delivery always runs on the org's current version (the
   pull pins it). The version an item was shaped under decides only whether its finished shaping
   still counts: when the current version's shaping stages are the same (ids, types, settings with
   defaults, conditions, agents, in order), release proceeds; when they changed, release doesn't
   guess and doesn't release. It flags the item: `core_work_items.release_flag` (migration 0285, the
   shape of `needs_info`) with the reason and both versions, and `release_flag_user_id`, the person
   who chooses (the one who released it; for an agent's release, the requester, else the first
   approver), who is notified. An agent's release leaves the item flagged with the reason rather
   than failing. The flag shows on the board's card (Ready: "choose in the Inbox") and in that
   person's Inbox (`inbox.releaseFlags`, read by the partial index on `release_flag_user_id`) with the
   two choices, `workItem.releaseChoice` (a person only: browser or desktop, never a CLI or MCP
   token): `reshape` shapes it again under the current workflow (the waiting Workflow instance is
   terminated and a new instance, `<item>_r…`, runs the current shaping stages), and `accept` records
   that the shaping done counts under the current version and releases it. Either way it is
   delivered under the current workflow. The check runs again at the pull, against the version
   delivery will run on, and the start is guarded on the org still being at that version: an item
   released under v2 whose shaping changed in v3 before it started goes back to Ready, flagged. And
   `accept` refuses once the org has saved past the version the flag named, flagging the item again
   against the current version so the person sees the new difference. Still to come in (d): the tightening re-pin at the next
   boundary (Q3), and moving each project's slot workflow to the org.
6. **(e) Dark factory mode** (no migration expected: the hold is project config, verdicts are audit
   rows and adjudicator rows). `autoApprove` on `publish`'s merge settings, `RISK_PATHS`,
   `autoApproveVerdict()`, the `auto-approve` actor, the adjudicator shadowing `merge`, the
   per-project hold and its triggers (incident opened, revert observed on push, red CI on the default
   branch, a "should not have merged" review-after-merge verdict), the inbox card, `SELF_MODIFY_PATHS`
   in code, the review-after-merge item for the adjudicator's sample, **the `auto-approve` actor's
   own decision path** (`approval.decide` refuses merge approvals today and `review.merge` is a
   person's operation, so the Workflow records the actor's decision through an internal function, not
   an operation any token can call), and the Workflow calling it at the merge gate instead of `pr.autoMerge`
   (landing stays with today's merge queue until the babysitter's spec replaces it)
   (the next free Workflow version at merge time). Tests: each condition alone sends the item to a person;
   all together merge; each trigger sets the hold; an agent can't save it on.
7. **(f) Skills** (migration **0283**: `core_skill_versions`). As in "Skills", plus agent instructions
   as proposals (Q17). The projection into the harness is a small hook in `harness-claude` and the
   runner host, said in the PR.
8. **(g) Autopilots** (migration **0284**: `core_autopilot_runs`, the `autopilot` kind and actor). As
   in "Autopilots", with the per-autopilot limits (Q19).
9. **Later, in this order:** the generic review packet (ADR 0512); Preview on the reconciler with
   `decision` and `agent-work`, runner jobs without a repository and media in R2; Publish through a
   connector, Q2's carry-over and the Measure follow-up item; the board's lanes and the all-projects
   phase columns (`workflow.lanes`, `workItem.board`); Software on the reconciler (the switch-over
   PR); deleting the replayed Workflow versions; Preview for software.

## When to start
The owner asked for the build to start on 2026-11-12, with the answers below. (a) and (b) change no
behaviour and go first; (c) only observes. Nothing changes what an item does until (d), and Software
leaves the replayed Workflow only through the switch-over PR a person approves.

## Decisions (the owner, 2026-11-12)
The open questions, answered. "Differs" marks an answer other than the one the spec suggested; those
sections above were rewritten.

| # | Question | Answer | Where |
| --- | --- | --- | --- |
| 1 | Is triage a shaping stage? | Yes: triage and planning are both shaping; triage is the one shaping stage that needs no person | F3, the types table, the Software template; ADR 0510 |
| 2 | One approval for Preview and Publish? | Yes: approving the preview also approves publishing, when Publish follows directly and nothing changed | The review packet, F6; ADR 0512 |
| 3 | Does an added gate apply to running items? | Yes: tightening reaches running items | Versioning; ADR 0510 |
| 4 | Which version does a long-planned item use at release? | The current one when its shaping stages are unchanged; otherwise it is flagged for a person | Versioning; ADR 0510 |
| 5 | Where do per-project settings live? | In the org workflow, with a short list of allowed per-project overrides | "Where workflows and agents live", migration; ADR 0510 |
| 6 | Who edits an org workflow, who approves a loosening? | **Differs**: org admins edit and approve (suggested: owners approve) | The impact check; ADR 0510 |
| 7 | The all-projects board with several workflows? | Columns by phase: Backlog, Shaping, Ready, Queued, Delivery, Done | The board; ADR 0510 |
| 8 | Small steps as lanes? | No: shown inside the stage they belong to | Slots, the board; ADR 0510 |
| 9 | When is a published marketing item Done? | When it publishes; measuring is a follow-up item | Marketing template; ADR 0510 |
| 10 | Attached PRs and incidents? | As built-in workflows you can see and tighten, not loosen | Built-in workflows; ADR 0510 |
| 11 | Keep the incident check-only auto-merge? | **Differs**: "I want it to optionally work in dark factory mode. Where it merges too" (suggested: drop it) | Dark factory mode; ADR 0515, 0230 superseded |
| 12 | May the adjudicator approve a Preview? | **Differs**: yes, once it has earned it, as for plan gates (suggested: no) | The types table, the packet; ADR 0374, 0512 |
| 13 | A trial's scope with org workflows? | Per project, as now | Skills (edits); ADR 0373 |
| 14 | How should the engine run a stage list? | A reconciler, in shadow beside today's Workflow until it agrees on 20 items in a row | The engine; ADR 0511 (accepted) |
| 15 | Planning artifacts with no repository? | In the factory's own storage, attached to the item | The types table, Marketing; ADR 0510 |
| 16 | May org skills reach the reviewer? | Yes, only adding to its built-in skills, and adding one is a policy change a person approves | Skills; ADR 0513 |
| 17 | Agent instructions under the skill rule? | Yes: both need a person to accept | Skills; ADR 0373, 0513 |
| 18 | How is an autopilot run recorded? | As a hidden work item of kind `autopilot`. The owner asked "why hidden?" and was told: hidden only from the Work lists; each run is a full work item shown as run history on the autopilot's page; anything it produces for a person appears in Work or the Inbox linked to the run. No objection | Autopilots; ADR 0514 |
| 19 | What limits an autopilot before a budget exists? | A time limit per run, a cap on how much it can file, and a daily run cap, per autopilot | Autopilots; ADR 0514 |
| 20 | Where is dark factory mode switched on? | **Differs**: "It's really just auto approving merges. So it's just a config option. Nothing special" (suggested: per project, off by default). Confirmed after: a setting on the workflow, off by default, not a per-project override | Dark factory mode; ADR 0515 |
| 21 | What must hold before it merges with no person? | All five: checks passed and criteria proven by a check that ran; tests intact; the adjudicator approved and has earned it on this project; inside the size and path limits; low risk (no migrations, auth, billing or policy files) | Dark factory mode; ADR 0515 |
| 22 | Deploy, and changes to the factory itself? | **Differs**: merge and deploy; self-changes still need a person (suggested: merge only) | Dark factory mode; ADR 0515 |
| 23 | Does it switch itself off when something goes wrong? | Yes | The per-project hold; ADR 0515 |

### Known gaps
- **Closed by (d1), #120:** a judging agent's instructions were neutral in a project's config. On main,
  `config.save` by any project member classes a change to slot steps and to agent instructions as
  neutral (`policyImpact`'s `workflows` and `agents` branches). An agent judging a slot `work` step
  can be told to pass everything with no approval. Org workflows (b) don't have this gap
  (`workflowImpact` loosens on any change to what a judge is told); projects keep it until (d)
  closes it, as the build plan says.

### Flagged for the coordinator
Places where the answers needed an interpretation, or where they touch each other. The five working
answers below were confirmed by the owner as written on 2026-11-12, and are decided.
- **Q2 × Q12** (decided by the owner, 2026-11-12). An adjudicator's Preview approval plus "one approval covers Publish" would
  publish with no person. It carries over only where Publish's `autoApprove` is on and its
  conditions hold; otherwise only a person's Preview approval does.
- **Q6, self-approval.** "Org admins edit and approve" with no second person means one admin can
  turn dark factory mode on alone (today's pending actions don't forbid approving your own). Fine
  for a one-person org; an org floor could require a different admin later.
- **Q20 and the hold** (decided by the owner, 2026-11-12). The setting is per workflow; the switch-off is a per-project hold in
  the project's config (`autoApproveHold`), written by the system as a tightening. Lifting it is a
  loosening: an org admin lifts it and approves it (Q6), the same as turning the mode on.
- **The adjudicator's "every fifth approval to a person"** (decided by the owner, 2026-11-12). Holding one eligible merge in five
  contradicts "just auto approving merges", so with `autoApprove` on the sampled merge is not held:
  it merges and a person reviews it afterwards (review-after-merge); a bad one trips the hold.
- **"Changes to the factory itself"** (decided by the owner, 2026-11-12). Read as factory config (`self-modify`) and a built-in,
  non-removable `SELF_MODIFY_PATHS` list (`.factory/` and the policy, gate, registry, operation,
  stage and workflow code), excluded from auto-approval in every workflow. The workflow's
  `riskPaths` only adds to it, so nobody has to remember to protect `gate.ts`.
- **Built-ins, "tighten, never loosen"** (decided by the owner, 2026-11-12). Measured against the shipped built-in: an org may
  undo its own tightening back to the shipped floor, and that undo is a loosening an org admin
  approves.
- **Incident fixes.** Under ADR 0515 they also need the adjudicator's earned approval, which ADR
  0230 didn't; that is stricter, and no project has opted into `check-merge`.
- **Autopilot-filed items** are eligible for dark factory mode like any item; the autopilot itself
  never merges.

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
   loosens; a loosening `workflow.save` waits for an org admin; a loosening save of a built-in
   workflow is refused.
4. A publish action is refused without an approved decision on the digest it acts on, and a new
   digest withdraws the old decision (tests for `media` and `pull-request`). A person's Preview
   approval on the same digest is accepted for a directly following Publish; the adjudicator's isn't.
5. In shadow mode the reconciler records a next action for every Workflow transition, the divergence
   report is readable per item, and the agreement streak resets on any divergence.
6. A Marketing project with no repository runs Brief → Draft → Preview → Publish on the reconciler,
   with the decision bound to the reel's sha256, ends Done at publish, and files a Measure follow-up.
7. The board's lanes come from `workflow.lanes`, the four fixed lanes are the same for every
   workflow, small stages show inside their stage, and the all-projects board shows phase columns.
8. Old Workflow instances drain unchanged while new items run on the reconciler;
   `workflow-versions.test.ts` keeps passing until `work-item.ts` is deleted.
9. A run records the exact skill versions it loaded; a path-conditioned skill is included when its
   paths match or nothing is known yet, and not when the known paths don't match.
10. A skill or agent-instruction edit proposed by the factory changes nothing until a person accepts
    it; accepted, it runs as a per-project trial and is promoted or rolled back on outcomes. An edit
    to a protected skill is `self-modify`.
11. An autopilot run can't merge, deploy, auto-merge or change config even with an approval (deny
    for the `autopilot` actor, with a test per risk class); its `queued` output is created `ready`
    where `release.agents` is false; outputs past `maxOutputs` are refused; the same trigger
    occurrence never fires twice; an event never fires on an autopilot's own output.
12. Dark factory mode: with `autoApprove` off nothing changes; with it on, a merge is approved by
    the `auto-approve` actor only when all five conditions hold, and each condition failing alone
    sends it to a person (a test each); a path in `RISK_PATHS` can't be removed by settings; an
    agent's save turning it on is refused; an incident, a revert or red CI after its merge sets the
    project's hold, and a held project's merges go to a person while other projects on the same
    workflow are unaffected.
13. A tightening workflow version moves running items at their next stage boundary; a loosening one
    never does; release on a changed shaping stage list refuses until a person chooses.
