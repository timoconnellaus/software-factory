// The stage-type contract (spec 52, ADR 0510). A stage type is built-in code: what it runs, what it
// consumes and produces, what proves it done, the screen it shows, what it needs, its gate and how
// far its actions reach. A workflow only chooses types, orders them and configures them.
//
// This is build plan PR (a): descriptors only. `next()` and the reconciler's snapshot come with
// PR (c); nothing at run time reads these yet.
import type { Capability, ModelRole } from "@software-factory/runner-contract";
import type { z } from "zod";
import type { RiskClass } from "../policy/gate.ts";
import type { ImpactChange } from "../policy/impact.ts";

export const PHASES = ["shaping", "delivery"] as const;
export type Phase = (typeof PHASES)[number];

export const SIZES = ["small", "medium", "large"] as const;
export type Size = (typeof SIZES)[number];

/** What a stage does outside the factory. The floor reads it (rule F6). */
export type Reversibility =
  /** Factory state, branches, R2 only: triage, planning, build. */
  | "internal"
  /** Visible outside but undoable: open a PR, a preview deploy, a draft post. */
  | "reversible-outside"
  /** Can't be taken back: merge to the default branch, publish, deploy, send. */
  | "irreversible";

export type ArtifactKind =
  | "brief"
  | "plan"
  | "spec"
  | "git-head"
  | "pull-request"
  | "file"
  | "media"
  | "preview-url"
  | "external-ref"
  | "metrics";

export type EvidenceKind =
  | "ci"
  | "check"
  | "criteria"
  | "reviewer"
  | "drift"
  | "tests-intact"
  | "screenshot"
  | "recording"
  | "live-preview"
  | "checklist"
  | "measure";

export interface EvidenceSpec {
  kind: EvidenceKind;
  /** Required for the stage to finish, or shown only. */
  required: boolean;
  /** The artifact kind it is about. Evidence for another digest never counts. */
  about: ArtifactKind;
}

/** Who decides a gate: the project's approvers, or one named person (who must be an approver). */
export type Decider = "approvers" | { person: string };

/** A person's decision inside a stage. It is code: no setting can turn a `required` one off. */
export interface GateSpec {
  /** The gate kind for the inbox, the adjudicator and metrics. */
  kind: "spec" | "step" | "preview" | "merge" | "publish" | "deploy";
  decider: Decider;
  /** `conditional`: runs when a typed condition in the type's settings holds. */
  mode: "required" | "conditional";
  /** The artifact the decision is about. */
  on: ArtifactKind;
  outcomes: readonly ("approve" | "requestChanges" | "sendBack" | "reject")[];
  /** The operation that opens and records it, and that operation's risk class. */
  operation: string;
  risk: RiskClass;
  /** Who besides a person may decide it once earned or set (ADR 0374, 0515). Code, not settings. */
  delegable: readonly ("adjudicator" | "autoApprove")[];
  /**
   * A person decides it whatever the autonomy policy and overrides say (a workflow's decision step,
   * ADR 0371; merge and deploy, ADR 0008). The gate's `risk` alone would let "agents may plan" pass a
   * decision step, so `stageGateDecision()` and the reconciler read this, never the risk alone.
   */
  alwaysReview: boolean;
}

export interface StageRequirements {
  capabilities: readonly Capability[];
  /** Connector kinds the stage acts through. */
  connectors: readonly string[];
  /** It needs a repository on the project. */
  repository: boolean;
  /** The runner pool its jobs take (ADR 0301). Shaping stages may not use `heavy` (F2). */
  pool: "heavy" | "light" | "none";
  /** Model roles its agent steps may use. Empty: the stage hands to no agent. */
  roles: readonly ModelRole[];
}

/** The screen the desktop app shows for an item in this stage. */
export type SurfaceId =
  | "interview"
  | "spec"
  | "run"
  | "checks"
  | "packet"
  | "preview"
  | "publish"
  | "measure";

export type StepKind = "agent" | "check" | "decision";

/** What one item looks like to a stage type: facts only, no I/O. */
export interface ItemFacts {
  kind: "change" | "incident" | "attached";
  size: Size | null;
  domains: readonly string[];
  hasRepository: boolean;
}

export interface StepPlan {
  id: string;
  kind: StepKind;
  role?: ModelRole;
}

export interface StageType<S extends z.ZodType = z.ZodType> {
  /** Stable id: "triage", "interview-planning", "build", "checks", "publish", … */
  id: string;
  /** Bumped when the persisted step state changes shape (ADR 0511). */
  version: number;
  name: string;
  description: string;
  phases: readonly Phase[];
  /** Its settings, with defaults. A stage template is a name plus a value of this. */
  settings: S;
  /**
   * The settings a project may override on an org workflow's stage of this type (spec 52, Q5): a
   * short, fixed list in code. Anything else is refused. An override that loosens against the org
   * workflow's value is `self-modify`.
   */
  overridable?: readonly string[];
  consumes: readonly ArtifactKind[];
  produces: readonly ArtifactKind[];
  evidence: readonly EvidenceSpec[];
  surface: SurfaceId;
  /** A small stage shows inside the stage before it on the board, not as a lane (spec 52, Q8). */
  small?: true;
  requires(settings: z.infer<S>): StageRequirements;
  /** Its person's decision, if it has one. Derived from settings only through typed fields. */
  gate(settings: z.infer<S>): GateSpec | null;
  /** Whether a person must take part. Shaping stages must (F3). */
  needsPerson: boolean;
  /** The one exception to F3: a shaping stage that needs no person. Only `triage` (Q1). */
  shapingWithoutPerson?: true;
  reversibility: Reversibility;
  /**
   * The stage judges the work (its verdict passes or sends back): `code` when the judge is the
   * factory's own reviewer, whose prompt and skills are code's and take no org agent (F10, Q16: org
   * skills reach it only as additions, a policy change); `agent` when a named agent judges, so
   * changing that agent or its instructions is a loosening.
   */
  judges?: "code" | "agent";
  /** For `irreversible` types: the outside action, its risk in `ALWAYS_REVIEW` (F6). */
  action?: (settings: z.infer<S>) => { operation: string; risk: RiskClass; on: ArtifactKind };
  /** The steps it runs for an item. Pure. */
  steps(settings: z.infer<S>, item: ItemFacts): readonly StepPlan[];
  /**
   * Classifies a settings change. `workflowImpact` treats any differing setting it returns no
   * change for as a loosening (the classifier is an allow-list, ADR 0516).
   */
  impact(before: z.infer<S>, after: z.infer<S>, stageId: string): readonly ImpactChange[];
  /**
   * Settings saved under an earlier `typeVersion`, in this version's shape, so a version bump is
   * compared setting by setting. Absent, or returning null: the bump is a loosening (ADR 0516).
   */
  migrate?(settings: unknown, fromVersion: number): unknown | null;
}

/** Erases a type's settings parameter so different types fit one registry. */
// biome-ignore lint/suspicious/noExplicitAny: the registry holds types with different settings; each is checked by its own schema before use.
export type AnyStageType = StageType<any>;

export const SIZE_RANK: Record<Size, number> = { small: 0, medium: 1, large: 2 };

/** Whether `decider` decides for fewer people than `before`: a named person is narrower. */
export function deciderChange(before: Decider, after: Decider): "loosens" | "tightens" | "same" {
  const b = before === "approvers" ? "approvers" : `person:${before.person}`;
  const a = after === "approvers" ? "approvers" : `person:${after.person}`;
  if (a === b) return "same";
  if (after === "approvers") return "loosens";
  if (before === "approvers") return "tightens";
  // One named person to another: neither broader nor narrower, but a person should see it.
  return "loosens";
}
