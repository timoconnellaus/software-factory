// What each stage's run hands back in `Handback.result`: the harness writes it (as JSON) and the
// runner host passes it through untouched. The cloud parses it with these schemas; a result that
// doesn't parse fails the run.
import { z } from "zod";

/**
 * Where the harness writes its stage result, relative to the worktree root. The runner host reads
 * it into `Handback.result`, then deletes it: it is never committed or pushed.
 */
export const RESULT_FILE = ".factory-result.json";

const criterion = z.string().min(1).max(1_000);

/** `triage`: the foreman's sizing (ADR 0005, 0013). */
/**
 * The spec critic's result (spec 23 part C): notes on the plan, nothing else. It can't approve,
 * reject or open the gate; whatever it writes is shown to the person and the planner as notes.
 */
export const critiqueResultSchema = z.object({
  notes: z.array(z.string().min(1).max(1_000)).max(20).default([]),
  summary: z.string().max(2_000).optional(),
});

export const triageResultSchema = z.object({
  size: z.enum(["small", "medium", "large"]),
  /** Why this size; logged with the spec decision. */
  reason: z.string().min(1).max(2_000),
  /** Decision domains touched (ADR 0029): product, architecture, security, … */
  domains: z.array(z.string().min(1).max(40)).max(10).default([]),
  acceptanceCriteria: z.array(criterion).max(30).default([]),
  /**
   * The check that proves each criterion (Workflow feature `triage-ties`), matched to
   * `acceptanceCriteria` by text. `checks` names only the project's declared checks or required CI
   * checks it was given; an empty list says no declared check can prove the criterion (shown as
   * "not covered by a check"). Advisory input: `workItem.triage` drops any name the project
   * doesn't declare, and only a check that passed on the head ever proves anything.
   */
  criterionChecks: z
    .array(
      z.object({
        criterion,
        checks: z.array(z.string().min(1).max(200)).max(5),
      }),
    )
    .max(30)
    .default([]),
  /**
   * The foreman may *ask* to skip or require the spec stage. Advisory only: the autonomy policy's
   * threshold decides (spec 02, criterion 4).
   */
  specRequested: z.enum(["skip", "require"]).optional(),
  summary: z.string().max(4_000).optional(),
  /** The project workflow that fits this work (ADR 0371), by name; omitted: the skeleton alone. */
  workflow: z.string().max(60).optional(),
  /** Why that workflow, logged with the choice. */
  workflowReason: z.string().max(1_000).optional(),
  /**
   * Whether it can be built as asked (spec 23, ADR 0304): `ready`; `needs_answers` (a few questions
   * first); or `not_actionable` (the requester must say more). Binding and logged with its reason;
   * it never opens or skips a gate the autonomy policy requires.
   */
  readiness: z.enum(["ready", "needs_answers", "not_actionable"]).default("ready"),
  readinessReason: z.string().max(2_000).optional(),
  /** The questions for needs_answers or not_actionable: to the requester, at most five. */
  questions: z
    .array(z.lazy(() => questionDraftSchema))
    .max(5)
    .default([]),
});

/**
 * A workflow's `work` step result (ADR 0371): advisory. `sendBack` returns the item to build with
 * the notes; `ask` puts questions to a person first.
 */
export const stepResultSchema = z.object({
  verdict: z.enum(["pass", "sendBack", "ask"]),
  summary: z.string().min(1).max(4_000),
  /** For sendBack: what the builder should change. */
  notes: z.string().max(8_000).optional(),
  questions: z
    .array(z.lazy(() => questionDraftSchema))
    .max(5)
    .default([]),
});

export const questionDraftSchema = z.object({
  domain: z.string().min(1).max(40).default("product"),
  prompt: z.string().min(1).max(2_000),
  context: z.string().max(8_000).optional(),
  options: z.array(z.string().min(1).max(500)).max(8).default([]),
  defaultAnswer: z.string().max(2_000).optional(),
  recommendation: z.string().max(2_000).optional(),
  recommendationReason: z.string().max(2_000).optional(),
  blocking: z.boolean().default(true),
  irreversible: z.boolean().default(false),
});

/** `spec`: the living spec (stage-spec format) plus the questions it still needs answered. */
export const specResultSchema = z.object({
  title: z.string().max(200).optional(),
  /** Goal / Scope / Out of scope / Acceptance criteria, in markdown. */
  specMd: z.string().min(1).max(100_000),
  acceptanceCriteria: z.array(criterion).min(1).max(30),
  /** Reversible choices recorded instead of asked (ADR 0042). */
  assumptions: z.array(z.string().min(1).max(1_000)).max(30).default([]),
  questions: z.array(questionDraftSchema).max(20).default([]),
});

/** `build`: nothing beyond the hand-back's branch and head SHA; an optional note. */
export const buildResultSchema = z.object({ notes: z.string().max(20_000).optional() }).default({});

export const checkResultSchema = z.object({
  name: z.string().min(1).max(100),
  status: z.enum(["pass", "fail", "skipped"]),
  detail: z.string().max(4_000).optional(),
});

/** `verify`: evidence for the review packet (ADR 0020). The verdict itself comes from CI (spec 04). */
export const verifyResultSchema = z.object({
  summary: z.string().max(8_000),
  /** The agent's own report of checks: kept as its opinion, never the verdict (ADR 0501). */
  checks: z.array(checkResultSchema).max(50).default([]),
  criteria: z
    .array(
      z.object({
        criterion,
        met: z.boolean(),
        evidence: z.string().min(1).max(4_000),
        /**
         * The checks that prove it (ADR 0501): names of the factory's own checks or of CI check
         * runs on the head. Only a linked check that passed makes the criterion Proven; `met` on
         * its own is the reviewer's opinion.
         */
        checks: z.array(z.string().max(100)).max(10).default([]),
      }),
    )
    .max(30),
  reviewer: z
    .object({
      role: z.literal("review"),
      model: z.string().optional(),
      verdict: z.enum(["approve", "request_changes"]),
      notes: z.string().max(20_000),
    })
    .optional(),
  riskFlags: z.array(z.string().max(500)).max(20).default([]),
});

/**
 * `babysit` (spec 53 §4, ADR 0583): the babysitter's judgement on the one reason it was woken for.
 * It only judges and, for a conflict, resolves it on its run branch (the host pushes that). Every
 * action follows from this in code, with its own floor: a `flake` is rerun once (`ci.rerun`), a
 * `resolved` conflict moves the item's branch (`branch.advance`) and withdraws the approval, a
 * `regression` goes back to build with the note, `person` asks a person.
 */
export const babysitResultSchema = z.object({
  verdict: z.enum(["flake", "regression", "resolved", "person"]),
  /** The failing check it judged (a `check-failed` reason). */
  check: z.string().min(1).max(200).optional(),
  /** The test inside it, when the log names one: recorded with the known flake. */
  test: z.string().min(1).max(500).optional(),
  /** Why: what the log or the conflict showed. Shown on the item's activity. */
  note: z.string().min(1).max(8_000),
});

export type BabysitResult = z.infer<typeof babysitResultSchema>;
export type TriageResult = z.infer<typeof triageResultSchema>;
export type StepResult = z.infer<typeof stepResultSchema>;
export type QuestionDraft = z.infer<typeof questionDraftSchema>;
export type SpecResult = z.infer<typeof specResultSchema>;
export type BuildResult = z.infer<typeof buildResultSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type VerifyResult = z.infer<typeof verifyResultSchema>;
