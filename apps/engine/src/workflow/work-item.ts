// One Workflow instance per work item (ADR 0006, 0110): triage → (spec gate) → build → verify →
// merge gate, with send-back loops inside the one instance. The Workflow owns the order of stages;
// every change it makes is an operation called through `invoke()` as the foreman, so the gate check
// (not this code) decides whether a step pauses for a person, and the autonomy policy (not the
// foreman) decides whether the spec stage runs.
//
// Versioning across deploys (ADR 0053): a running instance replays `run()` with the code of the new
// deploy, matching steps by name. So step names are an API: the first step records the version the
// instance started on, and `run()` dispatches to that version's implementation. A change that
// renames, reorders or removes steps is a new version (`runV2`), and the old one stays until no
// instance runs it. `test/workflow-versions.test.ts` locks v1's step names.
//
// An attached PR (spec 05, ADR 0290) takes its own path, `runAttached`, chosen by the item's kind
// rather than by a version: no instance of another kind ever reaches it, and change and incident
// items run exactly the steps they ran before.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  ATTACHED_SKIP_REASON,
  approvalEvent,
  ciEvent,
  DEFAULT_BUILDER,
  type DeliveredEventPayload,
  deliveredEvent,
  FOREMAN,
  type GateEventPayload,
  has,
  invoke,
  isOperationError,
  mergeQueueEvent,
  type ProjectPolicy,
  parseProjectPolicy,
  type RunEventPayload,
  releaseEvent,
  runEvent,
  SLOTS,
  WORKFLOW_VERSION_FEATURES,
} from "@software-factory/core";
import {
  type JobStage,
  type ModelRole,
  specResultSchema,
  stepResultSchema,
  triageResultSchema,
  verifyResultSchema,
} from "@software-factory/runner-contract";
import { invokeDeps } from "../deps.ts";
import {
  attachedTriagePrompt,
  buildPrompt,
  type ItemBrief,
  specPrompt,
  stepPrompt,
  triagePrompt,
  verifyPrompt,
} from "./prompts.ts";

export interface WorkItemParams {
  workItemId: string;
}

export type WorkItemOutcome =
  | { status: "done"; workItemId: string }
  | { status: "failed" | "rejected"; workItemId: string; reason: string };

/**
 * The version new instances start on. Bump it for any step-name change (ADR 0053).
 * - v1: verify's verdict came from the runner's report; the PR opened after verify.
 * - v2 (V1 step 4, spec 04): the PR opens before verify so CI runs on the head; verify waits for CI
 *   and the verdict is the review packet's (green CI + a complete packet); a factory incident's
 *   check-only fix may auto-merge (ADR 0230).
 * - v3 (ADR 0320): a PR GitHub can't merge is its own state. It is checked right after the PR
 *   opens and on every CI read, and sends the item back to build to merge the default branch,
 *   without a verify run or a packet (it doesn't count as a failed attempt for MERGE_ROUNDS
 *   rounds). CI that never reports asks a person (re-check or stop) instead of a build retry.
 */
/**
 * - v4 (ADR 0330): approved merges land through the project's merge queue, one at a time. After
 *   approval the item queues; at the head, the queue merges the default branch in (GitHub's
 *   update-branch), waits for CI on that head, then merges. A conflict or red CI there leaves the
 *   queue and goes back to build. A check-only incident fix queues before auto-merge is tried.
 */
/**
 * - v5 (spec 20, ADR 0300, 0350): the spec stage is a planning session on a runner instead of
 *   one-shot spec runs with question rounds. `planning: start`, then per round `planning #k: await`,
 *   a wait for the agent's `planning.ready` (escalating open blocking questions on each question
 *   timeout, never auto-accepting), and the spec gate. Request changes goes into the same session
 *   (`planning.note`); a decision ends it (`planning.end`). A person's word at the gate withdraws
 *   it (ADR 0470) and the next round starts, in the same version.
 */
/**
 * - v6 (spec 09 M2, ADR 0371): the item's workflow fills the skeleton's three slots. Triage is told
 *   the project's workflows (`workflow: options`) and picks one; before build, `workflow: plan`
 *   journals the item's workflow, its steps (conditions decided) and the build agent. Each step runs
 *   under `slot:<slot>:<round>:<index>:<id>`: a work step as a read-only job (advisory: pass, send
 *   back to build, or ask), a gate step through `workflow.gate` (always a person).
 */
/**
 * - v7 (spec 50 part C, ADR 0493): shaping stages run before release. After the shaping stages
 *   (triage, and interview planning with its spec gate when the size needs it), `release: check`
 *   reads whether the item was released. An item released straight from the backlog goes on at
 *   once, exactly as v6. An item shaped first (`workItem.shape`) becomes ready (`release: shaped`)
 *   and waits for `release-<item>` (`release: wait #k`, re-checking on each timeout), which the pull
 *   sends when a person released it and there is room. Delivery (the workflow's slots, build,
 *   verify, the merge gate) follows.
 */
/*
 * v11 (spec 53, ADR 0580; v8–v10 are other builds' numbers): approving the merge gate no longer
 * makes the item land itself. It enters its repository's queue for the babysitter
 * (`merge #b: deliver: enqueue`) and waits for `delivered-<item>` (`merge #b: deliver: wait #i`,
 * re-reading its entry after each timeout, `merge #b: deliver: read #i`); the engine's deliverer
 * updates, CIs and merges it. An incident's check-only auto-merge still lands itself, as v7.
 */
/** Whether the table has a row for `version`: an instance on any other version errors. */
export const isKnownVersion = (version: number): boolean =>
  Number.isInteger(version) && Object.hasOwn(WORKFLOW_VERSION_FEATURES, version);

export const WORKFLOW_VERSION = 12;
/** How long a shaped item waits for its release before it re-reads whether it was released. */
export const RELEASE_WAIT = "12 hours";
/** How long verify waits for a CI event before it reads CI again, and how many times. */
export const CI_WAIT = "10 minutes";
export const CI_ROUNDS = 12;
/** Rounds to wait when no CI has reported at all (a repo without CI fails after these). */
export const CI_MISSING_ROUNDS = 3;
/** How long an attached PR waits for a push before it re-reads its head (the webhook wakes it sooner). */
export const HEAD_RECHECK = "12 hours";
/** v3: reads of a just-opened PR's mergeability while GitHub computes it, and the pause between. */
export const MERGEABLE_READS = 3;
export const MERGEABLE_WAIT = "20 seconds";
/** v3: conflict send-backs that don't count against the retry limit (the default branch moved). */
export const MERGE_ROUNDS = 3;
/** v3: the answers to the no-CI question. */
export const NO_CI_RECHECK = "Re-check CI";
export const NO_CI_STOP = "Stop this work item";
/** v4: how long a queued item waits for its turn before it reads its position again. */
export const QUEUE_WAIT = "1 hour";
/** v4: reads of the head while GitHub makes the update-branch merge commit, and the pause between. */
export const UPDATE_READS = 8;
export const UPDATE_WAIT = "15 seconds";
/** How long a step refused by a kill switch waits for it to be turned off. */
export const PARK_TIMEOUT = "365 days";
/** Slack on top of a job's session timeout before the run counts as stalled. */
export const STALL_MARGIN_MS = 30 * 60_000;
/** How long to wait between checks while a job sits in the queue (no runner free). */
export const QUEUE_RECHECK_MS = 6 * 3_600_000;
/** Spec rounds that may ask questions; later rounds must record assumptions instead. */
export const QUESTION_ROUNDS = 2;
const JOB_TIMEOUT_MS = 60 * 60_000;
const STEP_RETRIES = {
  retries: { limit: 3, delay: "2 seconds" as const, backoff: "exponential" as const },
};

// biome-ignore lint/suspicious/noExplicitAny: operation outputs are validated JSON; steps carry them as text.
type Json = Record<string, any>;
type CallResult =
  | { status: "ok"; output: Json }
  | { status: "pending"; pendingActionId: string }
  | { status: "refused"; code: string; message: string; resumeEvent: string | null };

interface RunResult {
  outcome: RunEventPayload["outcome"];
  runId: string | null;
  headSha: string | null;
  summary: string | null;
  result: unknown;
}

/**
 * Whether a `waitForEvent` rejection is its timeout. Anything else (the engine aborting the run for
 * a pause, an outage) must propagate, or the Workflow would act while paused.
 */
export function isWaitTimeout(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  return e?.name === "WorkflowTimeoutError" || /timed out/i.test(e?.message ?? "");
}

/** Thrown to end the work item; `run()` records it with workItem.finish. */
class Ended extends Error {
  constructor(
    readonly status: "failed" | "rejected",
    readonly reason: string,
    readonly incident?: { kind: "run_failed" | "run_stalled"; runId: string | null },
  ) {
    super(reason);
  }
}

interface Meta extends ItemBrief {
  /** `incident` items may auto-merge a check-only fix (v2). Missing in v1 instances' replays. */
  kind?: "change" | "incident" | "attached";
  /** The attached PR's number and head when the item was created (spec 05). */
  prNumber?: number | null;
  headSha?: string | null;
  defaultBranch?: string;
  retryLimit: number;
  gateTimeoutMs: number;
  questionTimeoutMs: number;
}

type SlotName = (typeof SLOTS)[number];

interface PlannedAgent {
  name: string;
  role: string;
  tier: "standard" | "light";
  instructions: string;
  requires: string[];
}

interface PlannedStep {
  id: string;
  kind: "work" | "gate";
  name: string;
  instructions: string;
  approver?: string;
  agent?: PlannedAgent;
  /** Why its condition skips it for this item; absent when it runs. */
  skip?: string;
}

/** An item's workflow, decided once before build (v6, ADR 0371). `name` null: the skeleton alone. */
export interface WorkflowPlan {
  name: string | null;
  slots: Record<SlotName, PlannedStep[]>;
  build: PlannedAgent | null;
}

const SIZE_RANK: Record<string, number> = { small: 0, medium: 1, large: 2 };

/**
 * Resolves a workflow's steps against its agents and the item's size and domains. Pure. With no
 * workflow (or an unknown one) the slots are empty and the build uses the default builder, if the
 * project has one.
 */
export function planWorkflow(
  policy: ProjectPolicy | null,
  workflow: string | null,
  size: string | null,
  domainsJson: string | null,
): WorkflowPlan | null {
  if (!policy) return null;
  const def = workflow
    ? policy.workflows.find((w) => w.name.toLowerCase() === workflow.toLowerCase())
    : undefined;
  let domains: string[] = [];
  try {
    domains = domainsJson ? (JSON.parse(domainsJson) as string[]) : [];
  } catch {
    domains = [];
  }
  const agentOf = (name: string | undefined): PlannedAgent | null => {
    const a = name
      ? policy.agents.find((x) => x.name.toLowerCase() === name.toLowerCase())
      : undefined;
    return a
      ? {
          name: a.name,
          role: a.role,
          tier: a.tier,
          instructions: a.instructions,
          requires: [...a.requires],
        }
      : null;
  };
  const builder = (name: string | undefined) => {
    const a = agentOf(name);
    return a?.role === "implement" ? a : null;
  };
  if (!def) {
    return {
      name: null,
      slots: { afterSpec: [], beforeVerify: [], afterVerify: [] },
      build: builder(DEFAULT_BUILDER),
    };
  }
  const slots = Object.fromEntries(
    SLOTS.map((slot) => [
      slot,
      def.slots[slot].map((s): PlannedStep => {
        let skip: string | undefined;
        if (
          s.when?.sizeAtLeast &&
          (SIZE_RANK[size ?? ""] ?? -1) < (SIZE_RANK[s.when.sizeAtLeast] ?? 0)
        ) {
          skip = `only for ${s.when.sizeAtLeast} work and up (this is ${size ?? "unsized"})`;
        } else if (s.when?.domain && !domains.includes(s.when.domain)) {
          skip = `only when the work touches ${s.when.domain}`;
        }
        const agent = s.kind === "work" ? agentOf(s.agent) : null;
        return {
          id: s.id,
          kind: s.kind,
          name: s.name,
          instructions: s.instructions,
          ...(s.approver ? { approver: s.approver } : {}),
          ...(agent ? { agent } : {}),
          ...(skip ? { skip } : {}),
        };
      }),
    ]),
  ) as Record<SlotName, PlannedStep[]>;
  return { name: def.name, slots, build: builder(def.core.build ?? DEFAULT_BUILDER) };
}

export class WorkItemWorkflow extends WorkflowEntrypoint<Env, WorkItemParams> {
  override async run(
    event: WorkflowEvent<WorkItemParams>,
    step: WorkflowStep,
  ): Promise<WorkItemOutcome> {
    const version: number = await step.do(
      "meta: version",
      async (): Promise<number> => WORKFLOW_VERSION,
    );
    const flow = new ItemFlow(this.env, step, event.payload.workItemId, event.instanceId);
    if (!isKnownVersion(version)) {
      throw new Error(`no implementation for Workflow version ${version}`);
    }
    // An attached PR's own path (spec 05), chosen by kind, whatever version the item started on
    // (it merges directly, not through the merge queue: the App can't update a person's branch).
    // "meta: item" is runV1's first step anyway and is read once, so every other item runs exactly
    // the steps it ran before.
    const meta = await flow.meta();
    if (meta.kind === "attached") return flow.runAttached(version, meta);
    // Every version runs the same flow; what it does is its row of WORKFLOW_VERSION_FEATURES.
    return flow.runV1(version);
  }
}

class ItemFlow {
  constructor(
    private readonly env: Env,
    private readonly step: WorkflowStep,
    private readonly workItemId: string,
    private readonly workflowId: string,
  ) {}

  // ---- v1, v2 and v3 ----
  // v2 only adds steps (`verify #b: open PR`, `verify #b: ci…`, `merge #b: auto-merge`); with
  // `version === 1` the step sequence is exactly v1's, so v1 instances replay unchanged. v3 adds
  // steps the same way (`verify #b: mergeable…`, `build #b: conflict`, `verify #b: no ci…`).

  async runV1(version = 1): Promise<WorkItemOutcome> {
    const id = this.workItemId;
    try {
      let meta = await this.meta();
      await this.act("triage: enter", "workItem.enterStage", {
        workItemId: id,
        stage: "triage",
        workflowVersion: version,
      });
      await this.act("branch: ensure", "branch.ensure", { workItemId: id });

      // Triage: the foreman sizes the item on a runner; code decides the spec gate from policy.
      // v6: it also picks one of the project's workflows (ADR 0371).
      const options = has(version, "workflow-plan") ? await this.workflowOptions() : [];
      const triageRun = await this.runWithRetries(
        meta,
        "triage",
        "triage",
        "triage",
        triagePrompt(meta, options),
        {},
        (r) => triageResultSchema.safeParse(r),
      );
      const triage = triageRun.parsed;
      const recorded = await this.act("triage: record", "workItem.triage", {
        workItemId: id,
        result: triage,
      });
      let criteria = triage.acceptanceCriteria;
      let specPath: string | null = null;

      if (recorded.specRequired === true) {
        await this.act("spec: enter", "workItem.enterStage", { workItemId: id, stage: "spec" });
        let note: string | null = null;
        let answers: { prompt: string; answer: string }[] = [];
        // v5: the planning session (spec 20) instead of v1–v4's spec rounds below.
        if (has(version, "planning-spec")) criteria = await this.planningStage(meta);
        for (let k = 1; !has(version, "planning-spec"); k++) {
          const mayAsk = k <= QUESTION_ROUNDS;
          const specRun = await this.runWithRetries(
            meta,
            `spec #${k}`,
            "spec",
            "triage",
            specPrompt(meta, { criteria, note, answers, mayAsk }),
            { criteria, note, answers },
            (r) => specResultSchema.safeParse(r),
          );
          const spec = specRun.parsed;
          const { questions, ...draft } = spec;
          const proposed = await this.act(`spec #${k}: propose`, "spec.propose", {
            workItemId: id,
            spec: draft,
          });
          criteria = spec.acceptanceCriteria;
          if (questions.length > 0 && mayAsk) {
            await this.act(`spec #${k}: ask`, "question.ask", { workItemId: id, questions });
            await this.waitForAnswers(meta, `spec #${k}`);
            answers = await this.step.do(`spec #${k}: answers`, async () => {
              const { results } = await this.env.DB.prepare(
                "SELECT prompt, answer FROM core_questions WHERE work_item_id = ? AND status = 'answered' ORDER BY created_at",
              )
                .bind(id)
                .all<{ prompt: string; answer: string }>();
              return results;
            });
            note = null;
            continue; // revise the spec with the answers
          }
          const decided = await this.gate(meta, `spec #${k}: gate`, "spec.accept", {
            workItemId: id,
            specId: proposed.specId,
          });
          if (decided.decision === "approved") break;
          if (decided.decision === "changes_requested") {
            note = decided.note;
            continue; // back to planning, same instance (spec 02, criterion 3)
          }
          throw new Ended(
            "rejected",
            `spec ${decided.decision}${decided.note ? `: ${decided.note}` : ""}`,
          );
        }
        const committed = await this.act("spec: commit", "spec.commit", { workItemId: id });
        specPath = String(committed.path);
      }
      // v7: the shaping stages are done. Unreleased work waits here for its release (ADR 0493),
      // and delivery re-reads the item and its config as pinned at the pull.
      if (has(version, "release-wait") && (await this.waitForRelease()))
        meta = await this.refreshMeta();
      // v6: the workflow is fixed from here on (a person could change it until now), and its
      // afterSpec steps run once, before the build.
      const plan = has(version, "workflow-plan") ? await this.workflowPlan() : null;
      let slotNote: string | null = null;
      if (plan) {
        const after = await this.runSlot(meta, plan, "afterSpec", 0, {
          criteria,
          specPath,
          headSha: null,
        });
        if (after.kind === "sendBack") slotNote = after.note;
      }
      if (recorded.specRequired === true) {
        await this.act("build: enter", "workItem.enterStage", { workItemId: id, stage: "build" });
      } else {
        await this.act("build: enter", "workItem.enterStage", {
          workItemId: id,
          stage: "build",
          skipped: [{ stage: "spec", reason: String(recorded.reason) }],
        });
      }

      // Build → verify → merge gate, looping back on failures and send-backs.
      let failures = 0;
      let conflicts = 0;
      let note: string | null = slotNote;
      const failed = async (b: number, reason: string, run: RunResult | null) => {
        failures++;
        if (failures > meta.retryLimit) {
          throw new Ended("failed", `gave up after ${failures} failed attempts: ${reason}`, {
            kind: run?.outcome === "stalled" ? "run_stalled" : "run_failed",
            runId: run?.runId ?? null,
          });
        }
        await this.act(`build #${b}: retry`, "workItem.enterStage", {
          workItemId: id,
          stage: "build",
          closeAs: "failed",
          reason,
        });
        return reason;
      };
      // v3: the PR can't merge into the default branch, so GitHub runs no CI on it. Back to build
      // with what to do; the first MERGE_ROUNDS of these are the default branch moving, not a
      // failed attempt.
      const conflicted = async (b: number, run: RunResult | null) => {
        const into = meta.defaultBranch ?? "the default branch";
        const reason = [
          `The pull request can't merge into \`${into}\`: it conflicts with work that landed there, so GitHub ran no CI on it.`,
          `The runner has merged \`${into}\` into your branch: resolve the conflicts \`git status\` shows, keeping the intent of both sides, and commit the merge. Don't rebase.`,
        ].join("\n");
        conflicts++;
        if (conflicts > MERGE_ROUNDS) return failed(b, reason, run);
        await this.act(`build #${b}: conflict`, "workItem.enterStage", {
          workItemId: id,
          stage: "build",
          closeAs: "failed",
          reason: `the PR conflicts with ${into}`,
        });
        return reason;
      };

      // v12: an approval withdrawn at delivery (ADR 0582) sends the item back to verify the head
      // merging main made, without a build: nothing was carried to it, so it needs its own packet
      // and `factory/verify` before a person decides again.
      let withdrawn: string | null = null;
      for (let b = 1; ; b++) {
        let ran: RunResult | null = null;
        let headSha: string;
        const reverify = withdrawn;
        withdrawn = null;
        if (reverify !== null) {
          headSha = await this.head(`verify #${b}: head`);
        } else {
          const build = await this.runJob(
            `build #${b}`,
            "build",
            "implement",
            buildPrompt(meta, {
              criteria,
              specPath,
              note,
              attempt: b,
              ...(plan?.build ? { instructions: plan.build.instructions } : {}),
            }),
            {
              criteria,
              specPath,
              note,
            },
            plan?.build ? { tier: plan.build.tier, requires: plan.build.requires } : undefined,
          );
          if (build.outcome === "cancelled") {
            note = null;
            continue; // stopped by a kill switch or a takeover: run it again, no failure counted
          }
          if (build.outcome !== "completed") {
            note = await failed(
              b,
              `the build run ${build.outcome}: ${build.summary ?? "no summary"}`,
              build,
            );
            continue;
          }
          const advanced = await this.act(`build #${b}: advance`, "branch.advance", {
            workItemId: id,
            runId: build.runId,
          });
          if (advanced.ok !== true) {
            note = await failed(
              b,
              `the run's branch could not be accepted: ${String(advanced.reason)}`,
              build,
            );
            continue;
          }
          headSha = String(advanced.sha);
          ran = build;

          if (plan) {
            const before = await this.runSlot(meta, plan, "beforeVerify", b, {
              criteria,
              specPath,
              headSha,
            });
            if (before.kind === "sendBack") {
              note = await failed(b, before.note, build);
              continue;
            }
          }
        }

        await this.act(`verify #${b}: enter`, "workItem.enterStage", {
          workItemId: id,
          stage: "verify",
          ...(reverify !== null ? { closeAs: "sent_back" as const, reason: reverify } : {}),
        });
        if (has(version, "verify-packet")) {
          // Open the PR first, so CI runs on this head while the reviewer works (spec 04). It
          // carries a factory/verify that isn't passing until the packet below says so.
          await this.act(`verify #${b}: open PR`, "pr.open", { workItemId: id, body: meta.body });
        }
        if (has(version, "conflicts") && (await this.unmergeable(b, headSha))) {
          note = await conflicted(b, ran);
          continue;
        }
        const verify = await this.runJob(
          `verify #${b}`,
          "verify",
          "review",
          verifyPrompt(meta, { criteria, headSha }),
          {
            criteria,
            headSha,
          },
        );
        if (verify.outcome === "cancelled") {
          await this.act(`verify #${b}: back`, "workItem.enterStage", {
            workItemId: id,
            stage: "build",
            reason: "verify run cancelled",
          });
          continue;
        }
        const report = verifyResultSchema.safeParse(verify.result);
        if (verify.outcome !== "completed" || !report.success) {
          note = await failed(
            b,
            `the verify run ${verify.outcome}${report.success ? "" : " with an unreadable report"}`,
            verify,
          );
          continue;
        }
        const r = report.data;
        const runnerPassed =
          r.checks.every((c) => c.status !== "fail") &&
          r.criteria.every((c) => c.met) &&
          r.reviewer?.verdict !== "request_changes";
        if (has(version, "verify-packet")) {
          let ci = await this.waitForCi(b, headSha, version);
          for (let k = 1; has(version, "conflicts") && ci === "missing"; k++) {
            // No CI at all is a setup problem the builder can't fix: ask a person (ADR 0320).
            await this.askNoCi(meta, b, k, headSha);
            ci = await this.waitForCi(b, headSha, version, k + 1);
          }
          if (ci === "conflict") {
            note = await conflicted(b, verify);
            continue;
          }
        }
        const packet = await this.act(`verify #${b}: packet`, "reviewPacket.record", {
          workItemId: id,
          runId: verify.runId,
          headSha,
          verdict: runnerPassed ? "pass" : "fail",
          summary: r.summary,
          criteria: r.criteria,
          checks: r.checks,
          reviewer: r.reviewer ? { ...r.reviewer, sameModelAsImplementer: false } : null,
          riskFlags: r.riskFlags,
        });
        // v2: the packet's verdict (green CI on the head SHA + a complete packet) decides.
        const passed = has(version, "verify-packet") ? packet.verdict === "pass" : runnerPassed;
        if (!passed && has(version, "verify-packet")) {
          const reasons = Array.isArray(packet.reasons) ? (packet.reasons as string[]) : [];
          note = await failed(
            b,
            ["Verify found problems:", ...reasons.map((x) => `- ${x}`)].join("\n"),
            verify,
          );
          continue;
        }
        if (!passed) {
          const unmet = r.criteria.filter((c) => !c.met).map((c) => `- unmet: ${c.criterion}`);
          const failing = r.checks
            .filter((c) => c.status === "fail")
            .map((c) => `- failing: ${c.name} ${c.detail ?? ""}`);
          const reviewer =
            r.reviewer?.verdict === "request_changes" ? [`- reviewer: ${r.reviewer.notes}`] : [];
          note = await failed(
            b,
            ["Verify found problems:", ...failing, ...unmet, ...reviewer].join("\n"),
            verify,
          );
          continue;
        }

        if (plan) {
          const after = await this.runSlot(meta, plan, "afterVerify", b, {
            criteria,
            specPath,
            headSha,
          });
          if (after.kind === "sendBack") {
            note = await failed(b, after.note, verify);
            continue;
          }
        }

        const pr = await this.act(`merge #${b}: open PR`, "pr.open", {
          workItemId: id,
          body: r.summary,
        });
        await this.act(`merge #${b}: enter`, "workItem.enterStage", {
          workItemId: id,
          stage: "merge",
        });
        if (has(version, "merge-queue")) {
          const landed = await this.mergeV4(
            meta,
            b,
            headSha,
            pr.touchesFactoryConfig === true,
            version,
          );
          if (landed.kind === "done") {
            await this.act("end: done", "workItem.finish", {
              workItemId: id,
              status: "done",
              reason: landed.reason,
            });
            return { status: "done", workItemId: id };
          }
          if (landed.kind === "withdrawn") {
            withdrawn = landed.reason;
            continue;
          }
          if (landed.kind === "sent_back") {
            note = `Sent back at review: ${landed.note ?? ""}`;
            await this.act(`merge #${b}: sent back`, "workItem.enterStage", {
              workItemId: id,
              stage: "build",
              closeAs: "sent_back",
              reason: landed.note ?? "sent back",
            });
            continue;
          }
          note =
            landed.kind === "conflict"
              ? await conflicted(b, verify)
              : await failed(b, landed.reason, verify);
          continue;
        }
        let decided: Awaited<ReturnType<ItemFlow["gate"]>> | null = null;
        if (has(version, "verify-packet") && meta.kind === "incident") {
          // A check-only incident fix may merge without a person, if the project opted in and the
          // rule holds (ADR 0230). Refused: the normal merge gate below.
          const autoName = `merge #${b}: auto-merge`;
          const auto = await this.call(autoName, "pr.autoMerge", { workItemId: id, headSha });
          if (auto.status === "ok") {
            await this.act("end: done", "workItem.finish", {
              workItemId: id,
              status: "done",
              reason: "auto-merged: a check-only incident fix (ADR 0230)",
            });
            return { status: "done", workItemId: id };
          }
          if (auto.status === "pending") {
            decided = await this.gate(meta, autoName, "pr.autoMerge", { workItemId: id, headSha });
          }
        }
        decided ??= await this.gate(meta, `merge #${b}: gate`, "pr.merge", {
          workItemId: id,
          headSha,
          touchesFactoryConfig: pr.touchesFactoryConfig === true,
        });
        if (decided.decision === "approved") {
          await this.act("end: done", "workItem.finish", {
            workItemId: id,
            status: "done",
            reason: "merged",
          });
          return { status: "done", workItemId: id };
        }
        if (decided.decision === "sent_back") {
          note = `Sent back at review: ${decided.note ?? ""}`;
          await this.act(`merge #${b}: sent back`, "workItem.enterStage", {
            workItemId: id,
            stage: "build",
            closeAs: "sent_back",
            reason: decided.note ?? "sent back",
          });
          continue; // verify → build loop inside the one instance
        }
        throw new Ended("rejected", `merge rejected${decided.note ? `: ${decided.note}` : ""}`);
      }
    } catch (error) {
      return this.ended(error);
    }
  }

  // ---- attached PRs (spec 05, ADR 0290) ----
  // Triage drafts criteria from the PR; spec and build are skipped (the factory never pushes to the
  // PR's branch, so no branch.ensure or branch.advance); then verify runs on the PR's head. A fail
  // or a send-back waits for a new push; a push while the merge gate is open withdraws the gate
  // (verify.refresh) and verifies the new head. No build retry limit: nothing is built.

  async runAttached(version: number, meta: Meta): Promise<WorkItemOutcome> {
    const id = this.workItemId;
    try {
      await this.act("triage: enter", "workItem.enterStage", {
        workItemId: id,
        stage: "triage",
        workflowVersion: version,
      });
      const triageRun = await this.runWithRetries(
        meta,
        "triage",
        "triage",
        "triage",
        attachedTriagePrompt(meta, {
          prNumber: meta.prNumber ?? null,
          headSha: meta.headSha ?? null,
          defaultBranch: meta.defaultBranch ?? "main",
        }),
        { attached: true, prNumber: meta.prNumber ?? null, headSha: meta.headSha ?? null },
        (r) => triageResultSchema.safeParse(r),
      );
      const triage = triageRun.parsed;
      await this.act("triage: record", "workItem.triage", { workItemId: id, result: triage });
      const criteria = triage.acceptanceCriteria;
      await this.act("verify: enter", "workItem.enterStage", {
        workItemId: id,
        stage: "verify",
        skipped: [
          { stage: "spec", reason: ATTACHED_SKIP_REASON },
          { stage: "build", reason: ATTACHED_SKIP_REASON },
        ],
      });

      let runFailures = 0;
      /** How the previous round's stage closes when the next round starts. */
      let close: { as: "done" | "sent_back" | "failed"; reason: string } | null = null;
      for (let b = 1; ; b++) {
        const headSha = await this.head(`verify #${b}: head`);
        if (close) {
          await this.act(`verify #${b}: enter`, "workItem.enterStage", {
            workItemId: id,
            stage: "verify",
            closeAs: close.as,
            reason: close.reason,
          });
        }
        // The PR is already open: pr.open returns it (and whether it touches `.factory/`).
        const pr = await this.act(`verify #${b}: open PR`, "pr.open", { workItemId: id });
        const verify = await this.runJob(
          `verify #${b}`,
          "verify",
          "review",
          verifyPrompt(meta, { criteria, headSha }),
          { criteria, headSha },
        );
        if (verify.outcome === "cancelled") {
          close = { as: "failed", reason: "verify run cancelled" };
          continue; // stopped by a kill switch or a takeover: verify the head again
        }
        const report = verifyResultSchema.safeParse(verify.result);
        if (verify.outcome !== "completed" || !report.success) {
          // The runner failed, not the PR: try again on the same head, up to the retry limit.
          runFailures++;
          const reason = `the verify run ${verify.outcome}${report.success ? "" : " with an unreadable report"}`;
          if (runFailures > meta.retryLimit) {
            throw new Ended(
              "failed",
              `gave up after ${runFailures} failed verify runs: ${reason}`,
              {
                kind: verify.outcome === "stalled" ? "run_stalled" : "run_failed",
                runId: verify.runId,
              },
            );
          }
          close = { as: "failed", reason };
          continue;
        }
        runFailures = 0;
        const r = report.data;
        const runnerPassed =
          r.checks.every((c) => c.status !== "fail") &&
          r.criteria.every((c) => c.met) &&
          r.reviewer?.verdict !== "request_changes";
        await this.waitForCi(b, headSha, 2);
        const packet = await this.act(`verify #${b}: packet`, "reviewPacket.record", {
          workItemId: id,
          runId: verify.runId,
          headSha,
          verdict: runnerPassed ? "pass" : "fail",
          summary: r.summary,
          criteria: r.criteria,
          checks: r.checks,
          reviewer: r.reviewer ? { ...r.reviewer, sameModelAsImplementer: false } : null,
          riskFlags: r.riskFlags,
        });

        if (packet.verdict !== "pass") {
          const reason = "verify found problems: push a fix to the PR";
          await this.waitForHead(b, headSha, reason);
          close = { as: "failed", reason };
          continue;
        }
        // A push while verify ran: verify the new head instead of gating the old one.
        if ((await this.head(`merge #${b}: head`)) !== headSha) {
          close = { as: "done", reason: "the pull request's head moved: verifying the new head" };
          continue;
        }
        await this.act(`merge #${b}: enter`, "workItem.enterStage", {
          workItemId: id,
          stage: "merge",
        });
        const decided = await this.gate(
          meta,
          `merge #${b}: gate`,
          "pr.merge",
          { workItemId: id, headSha, touchesFactoryConfig: pr.touchesFactoryConfig === true },
          { returnRefusedApply: true },
        );
        if (decided.decision === "approved") {
          await this.act("end: done", "workItem.finish", {
            workItemId: id,
            status: "done",
            reason: "merged",
          });
          return { status: "done", workItemId: id };
        }
        if (decided.decision === "rejected" || decided.decision === "changes_requested") {
          throw new Ended("rejected", `merge rejected${decided.note ? `: ${decided.note}` : ""}`);
        }
        // Sent back, withdrawn (the head moved), or refused at merge (the head moved under the
        // approval): wait for a push, which a withdrawal has already seen.
        const reason =
          decided.decision === "sent_back"
            ? `Sent back at review: ${decided.note ?? ""}`.trim()
            : decided.decision === "withdrawn"
              ? (decided.note ?? "the pull request's head moved")
              : `the merge was refused (${decided.note ?? "no reason"}): push a fix to the PR`;
        await this.waitForHead(b, headSha, reason);
        close = { as: "sent_back", reason };
      }
    } catch (error) {
      return this.ended(error);
    }
  }

  /** Ends the item for an `Ended` (opening an incident when it says so); rethrows anything else. */
  private async ended(error: unknown): Promise<WorkItemOutcome> {
    const id = this.workItemId;
    if (!(error instanceof Ended)) throw error;
    if (error.incident) {
      await this.call("end: incident", "incident.open", {
        workItemId: id,
        kind: error.incident.kind,
        reason: error.reason,
        runId: error.incident.runId,
      });
    }
    await this.call(`end: ${error.status}`, "workItem.finish", {
      workItemId: id,
      status: error.status,
      reason: error.reason,
    });
    return { status: error.status, workItemId: id, reason: error.reason };
  }

  // ---- building blocks ----

  /** The attached PR's head as the factory last recorded it (verify.refresh moves it on a push). */
  private async head(name: string): Promise<string> {
    return this.step.do(name, async () => {
      const row = await this.env.DB.prepare("SELECT head_sha FROM core_work_items WHERE id = ?")
        .bind(this.workItemId)
        .first<{ head_sha: string | null }>();
      if (!row?.head_sha) throw new Error(`work item ${this.workItemId} has no head`);
      return row.head_sha;
    });
  }

  /**
   * Waits for a push to the attached PR past `headSha`: workItem.awaitHead puts the item in
   * waiting with the reason (or says the head already moved), then `pr-head-<item>` wakes it. A
   * repeated or early event only costs a re-read of the head.
   */
  async waitForHead(b: number, headSha: string, reason: string): Promise<void> {
    const awaited = await this.act(`verify #${b}: await push`, "workItem.awaitHead", {
      workItemId: this.workItemId,
      headSha,
      reason,
    });
    if (awaited.moved === true) return;
    for (let i = 1; ; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      try {
        await this.step.waitForEvent(`verify #${b}: push${sfx}`, {
          type: String(awaited.event),
          timeout: HEAD_RECHECK,
        });
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
      }
      if ((await this.head(`verify #${b}: pushed head${sfx}`)) !== headSha) return;
    }
  }

  private metaRead: Promise<Meta> | null = null;

  /** The item and its policy's limits: one step, read once per run. */
  async meta(): Promise<Meta> {
    this.metaRead ??= this.readMeta();
    return this.metaRead;
  }

  /**
   * After a shaped item's release (v7): the item and the limits of the config version the pull
   * pinned, read again, so delivery never runs on what was journaled at shaping time.
   */
  async refreshMeta(): Promise<Meta> {
    this.metaRead = this.readMeta("release: meta");
    return this.metaRead;
  }

  private async readMeta(name = "meta: item"): Promise<Meta> {
    return this.step.do(name, async () => {
      const row = await this.env.DB.prepare(
        `SELECT w.number, w.title, w.body, w.branch, w.kind, w.pr_number, w.head_sha,
                r.default_branch, p.raw FROM core_work_items w
         JOIN core_projects pr ON pr.id = w.project_id
         -- The item's repository, else its project's only one (ADR 0490), as itemRepository().
         LEFT JOIN core_repositories r ON r.id = COALESCE(w.repository_id, (
           SELECT id FROM core_repositories WHERE project_id = w.project_id
           AND (SELECT count(*) FROM core_repositories WHERE project_id = w.project_id) = 1))
         -- The version the item runs on (pinned at its pull), else the project's.
         LEFT JOIN core_project_policies p ON p.project_id = pr.id
           AND p.sha = COALESCE(w.policy_sha, pr.policy_sha)
         WHERE w.id = ?`,
      )
        .bind(this.workItemId)
        .first<{
          number: number;
          title: string;
          body: string;
          branch: string;
          kind: "change" | "incident" | "attached";
          pr_number: number | null;
          head_sha: string | null;
          default_branch: string | null;
          raw: string | null;
        }>();
      if (!row) throw new Error(`work item ${this.workItemId} not found`);
      // Never guess a default branch: an item with no repository can't run its pipeline.
      if (!row.default_branch) throw new Error(`work item ${this.workItemId} has no repository`);
      let policy: {
        retryLimit?: number;
        timeouts?: { gateHours?: number; questionHours?: number };
      } = {};
      try {
        policy = row.raw ? JSON.parse(row.raw) : {};
      } catch {
        policy = {};
      }
      return {
        number: row.number,
        title: row.title,
        body: row.body,
        branch: row.branch,
        kind: row.kind,
        prNumber: row.pr_number,
        headSha: row.head_sha,
        defaultBranch: row.default_branch,
        retryLimit: policy.retryLimit ?? 2,
        gateTimeoutMs: (policy.timeouts?.gateHours ?? 72) * 3_600_000,
        questionTimeoutMs: (policy.timeouts?.questionHours ?? 48) * 3_600_000,
      };
    });
  }

  /**
   * One journaled step = one operation call, idempotent on `<instance>:<step>`. Refusals are results,
   * not retries. A step a kill switch refused parks on its resume event, then runs again under a
   * new step name (spike ADR 0110).
   */
  async call(name: string, op: string, input: unknown, approvalId?: string): Promise<CallResult> {
    for (let attempt = 1; ; attempt++) {
      const stepName = attempt === 1 ? name : `${name} #${attempt}`;
      const attemptCall = async (): Promise<CallResult> => {
        try {
          const r = await invoke(invokeDeps(this.env), op, input, {
            actor: FOREMAN,
            origin: { surface: "workflow", workflowId: this.workflowId, step: stepName },
            idempotencyKey: `${this.workflowId}:${stepName}`,
            ...(approvalId ? { approvalId } : {}),
          });
          return r.status === "ok"
            ? { status: "ok", output: (r.output ?? {}) as Json }
            : { status: "pending", pendingActionId: r.pendingActionId };
        } catch (error) {
          if (!isOperationError(error)) throw error;
          const resumeEvent = error.details?.resumeEvent;
          return {
            status: "refused",
            code: error.code,
            message: error.message,
            resumeEvent: typeof resumeEvent === "string" ? resumeEvent : null,
          };
        }
      };
      let result: CallResult;
      try {
        // Steps carry the result as JSON text: operation outputs are plain JSON, and text keeps the
        // Workflow's Serializable types shallow.
        const text = await this.step.do(stepName, STEP_RETRIES, async () =>
          JSON.stringify(await attemptCall()),
        );
        result = JSON.parse(text) as CallResult;
      } catch (error) {
        if (/Aborting engine/.test(String(error))) throw error;
        // The step failed past its retries (an outage, a bug): end the item rather than hang.
        result = { status: "refused", code: "error", message: String(error), resumeEvent: null };
      }
      if (result.status !== "refused" || result.code !== "killed" || !result.resumeEvent)
        return result;
      await this.step.waitForEvent(`${stepName}: parked`, {
        type: result.resumeEvent,
        timeout: PARK_TIMEOUT,
      });
    }
  }

  /** Calls an operation that must succeed. A `review` answer waits for a person, like any gate. */
  async act(name: string, op: string, input: unknown): Promise<Json> {
    const decided = await this.gate(null, name, op, input);
    if (decided.decision !== "approved") {
      throw new Ended(
        "rejected",
        `${op} ${decided.decision}${decided.note ? `: ${decided.note}` : ""}`,
      );
    }
    return decided.output;
  }

  /**
   * Calls an operation; when the gate check says review, waits for `approval-<id>` (escalating to
   * the backup owner on each timeout, never auto-approving) and on approval re-runs it with the
   * approval. With `returnRefusedApply`, an approved re-run the operation refuses (an attached PR
   * whose head moved under the approval) comes back as `refused` instead of ending the item.
   */
  async gate(
    meta: Meta | null,
    name: string,
    op: string,
    input: unknown,
    options: { returnRefusedApply?: boolean; apply?: boolean } = {},
  ): Promise<
    | { decision: "approved"; output: Json; pendingActionId?: string }
    | {
        decision: Exclude<GateEventPayload["decision"], "approved"> | "refused";
        note: string | null;
        /** Who decided (missing for a refused re-run). */
        by?: string;
      }
  > {
    const first = await this.call(name, op, input);
    if (first.status === "refused")
      throw new Ended("failed", `${op} refused (${first.code}): ${first.message}`);
    if (first.status === "ok") return { decision: "approved", output: first.output };
    const timeout = meta?.gateTimeoutMs ?? 72 * 3_600_000;
    for (let i = 1; ; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      let decided: GateEventPayload;
      try {
        const event = await this.step.waitForEvent<GateEventPayload>(`${name}: wait${sfx}`, {
          type: approvalEvent(first.pendingActionId),
          timeout,
        });
        decided = event.payload;
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        await this.call(`${name}: escalate${sfx}`, "gate.escalate", {
          pendingActionId: first.pendingActionId,
        });
        continue;
      }
      if (decided.decision !== "approved")
        return { decision: decided.decision, note: decided.note, by: decided.by };
      // v4's merge: the approval is applied later, when the item is the head of the merge queue.
      if (options.apply === false)
        return { decision: "approved", output: {}, pendingActionId: first.pendingActionId };
      const applied = await this.call(`${name}: apply`, op, input, first.pendingActionId);
      if (applied.status === "refused" && options.returnRefusedApply) {
        return { decision: "refused", note: applied.message };
      }
      if (applied.status !== "ok") {
        throw new Ended(
          "failed",
          `${op} failed after approval: ${applied.status === "refused" ? applied.message : "still pending"}`,
        );
      }
      return { decision: "approved", output: applied.output };
    }
  }

  /**
   * v2: waits until CI on the head SHA has settled (the connector sends `ci-<item>-<sha>` when a
   * check suite completes; each timeout reads CI again), so the packet reads a final answer. Gives
   * up after CI_ROUNDS (or CI_MISSING_ROUNDS when no CI reports at all); the packet then fails.
   * v3 also stops at once when GitHub says the PR can't merge (`conflict`), and says how it ended.
   * `round` > 1 is a re-check after the no-CI question, under its own step names.
   */
  async waitForCi(
    b: number,
    headSha: string,
    version: number = 2,
    round = 1,
    label?: string,
  ): Promise<"success" | "failure" | "missing" | "pending" | "conflict" | "unreadable"> {
    for (let i = 1; i <= CI_ROUNDS; i++) {
      const sfx = (round === 1 ? "" : ` r${round}`) + (i === 1 ? "" : ` #${i}`);
      // v2's names, frozen; v4's merge queue waits under its own `label`.
      const ciName = label ? `${label}: ci${sfx}` : `verify #${b}: ci${sfx}`;
      const waitName = label ? `${label}: ci wait${sfx}` : `verify #${b}: ci wait${sfx}`;
      const ci = await this.call(ciName, "ci.read", {
        workItemId: this.workItemId,
        headSha,
      });
      if (ci.status !== "ok") return "unreadable"; // the packet records why and fails
      if (has(version, "conflicts") && ci.output.mergeable === false) return "conflict";
      const state = String(ci.output.state);
      if (state === "success" || state === "failure") return state;
      if (state === "missing" && i >= CI_MISSING_ROUNDS) return "missing";
      try {
        await this.step.waitForEvent(waitName, {
          type: ciEvent(this.workItemId, headSha),
          timeout: CI_WAIT,
        });
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
      }
    }
    return "pending";
  }

  /**
   * v3: whether GitHub says the just-opened PR can't merge into the default branch (ADR 0320). Reads
   * a few times while GitHub computes it; still unknown counts as mergeable (the CI reads look again).
   */
  async unmergeable(b: number, headSha: string): Promise<boolean> {
    for (let i = 1; i <= MERGEABLE_READS; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      const read = await this.call(`verify #${b}: mergeable${sfx}`, "ci.read", {
        workItemId: this.workItemId,
        headSha,
      });
      if (read.status !== "ok") return false;
      if (read.output.mergeable === false) return true;
      if (read.output.mergeable === true) return false;
      if (i < MERGEABLE_READS)
        await this.step.sleep(`verify #${b}: mergeable wait${sfx}`, MERGEABLE_WAIT);
    }
    return false;
  }

  /**
   * v4: the merge stage through the project's merge queue (ADR 0330). A check-only incident fix
   * tries auto-merge at the head of the queue first; anything else (and an incident fix that isn't
   * check-only) goes through the merge gate, then lands at the head of the queue with the approval.
   */
  async mergeV4(
    meta: Meta,
    b: number,
    headSha: string,
    touchesFactoryConfig: boolean,
    version = 4,
  ): Promise<
    | { kind: "done"; reason: string }
    | { kind: "sent_back"; note: string | null }
    | { kind: "conflict" }
    | { kind: "failed"; reason: string }
    | { kind: "withdrawn"; reason: string }
  > {
    const id = this.workItemId;
    if (meta.kind === "incident") {
      const auto = await this.landV4(b, "auto-merge", headSha, null, (at) => ({
        op: "pr.autoMerge",
        input: { workItemId: id, headSha: at },
      }));
      if (auto.kind === "done")
        return { kind: "done", reason: "auto-merged: a check-only incident fix (ADR 0230)" };
      if (auto.kind === "conflict" || auto.kind === "failed") return auto;
      if (auto.kind === "pending") {
        // The project's policy asks a person to approve the auto-merge: wait, then land with it.
        const decided = await this.awaitDecision(
          meta,
          `merge #${b}: auto-merge`,
          auto.pendingActionId,
        );
        if (decided.decision !== "approved") return this.notApproved(decided);
        const landed = await this.landV4(
          b,
          "auto-merge landing",
          auto.headSha,
          auto.pendingActionId,
          (at) => ({
            op: "pr.autoMerge",
            input: { workItemId: id, headSha: at },
          }),
        );
        if (landed.kind === "done")
          return { kind: "done", reason: "auto-merged: a check-only incident fix (ADR 0230)" };
        if (landed.kind === "conflict" || landed.kind === "failed") return landed;
        return {
          kind: "failed",
          reason: `pr.autoMerge after approval: ${landed.kind === "refused" ? landed.message : "still pending"}`,
        };
      }
      headSha = auto.headSha; // refused (not check-only): the normal merge gate on the current head
    }
    const input = (at: string) => ({ workItemId: id, headSha: at, touchesFactoryConfig });
    const decided = await this.gate(meta, `merge #${b}: gate`, "pr.merge", input(headSha), {
      apply: false,
    });
    // v11: the approval only says this head may merge; the babysitter lands it (spec 53). v12: an
    // approval it withdraws (ADR 0582) sends the item back to verify the new head; v11 has no
    // such path, so a withdrawal ends its delivery as failed and it goes back, as any failure does.
    if (has(version, "babysitter-delivery")) {
      if (decided.decision !== "approved") return this.notApproved(decided);
      if (!decided.pendingActionId) return { kind: "done", reason: "merged" };
      const delivered = await this.deliverV11(b, headSha, decided.pendingActionId);
      if (delivered.kind !== "withdrawn") return delivered;
      if (!has(version, "reverify-on-withdrawal")) {
        return { kind: "failed", reason: delivered.reason };
      }
      return delivered;
    }
    if (decided.decision !== "approved") return this.notApproved(decided);
    if (!decided.pendingActionId) {
      // pr.merge ran without a gate (never for `merge` risk; a policy can't loosen it): it merged.
      return { kind: "done", reason: "merged" };
    }
    const landed = await this.landV4(b, "queue", headSha, decided.pendingActionId, (at) => ({
      op: "pr.merge",
      input: input(at),
    }));
    if (landed.kind === "done") return { kind: "done", reason: "merged through the merge queue" };
    if (landed.kind === "conflict" || landed.kind === "failed") return landed;
    throw new Ended(
      "failed",
      `pr.merge failed after approval: ${landed.kind === "refused" ? landed.message : "still pending"}`,
    );
  }

  private notApproved(decided: {
    // `withdrawn` and `refused` are an attached PR's (its head moved); a factory item's head
    // doesn't move while its merge gate is open, so they end it like a rejection.
    decision: Exclude<GateEventPayload["decision"], "approved"> | "refused";
    note: string | null;
  }): { kind: "sent_back"; note: string | null } {
    if (decided.decision === "sent_back") return { kind: "sent_back", note: decided.note };
    throw new Ended("rejected", `merge rejected${decided.note ? `: ${decided.note}` : ""}`);
  }

  /** Waits for a person's decision on an existing pending action, escalating on each timeout. */
  async awaitDecision(
    meta: Meta,
    name: string,
    pendingActionId: string,
  ): Promise<
    | { decision: "approved" }
    | { decision: Exclude<GateEventPayload["decision"], "approved">; note: string | null }
  > {
    for (let i = 1; ; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      try {
        const event = await this.step.waitForEvent<GateEventPayload>(`${name}: wait${sfx}`, {
          type: approvalEvent(pendingActionId),
          timeout: meta.gateTimeoutMs,
        });
        const d = event.payload;
        return d.decision === "approved"
          ? { decision: "approved" }
          : { decision: d.decision, note: d.note };
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        await this.call(`${name}: escalate${sfx}`, "gate.escalate", { pendingActionId });
      }
    }
  }

  /**
   * v4: queue, wait for the head, bring the branch up to date, wait for CI on the new head, then
   * land with `land(head)` (ADR 0330). Leaves the queue on every way out.
   */
  async landV4(
    b: number,
    tag: string,
    headSha: string,
    approvalId: string | null,
    land: (head: string) => { op: string; input: unknown },
  ): Promise<
    | { kind: "done" }
    | { kind: "conflict" }
    | { kind: "failed"; reason: string }
    | { kind: "pending"; pendingActionId: string; headSha: string }
    | { kind: "refused"; message: string; headSha: string }
  > {
    const id = this.workItemId;
    const p = `merge #${b}: ${tag}`;
    const leave = (outcome: "merged" | "left", reason: string) =>
      this.act(`${p}: leave`, "mergeQueue.leave", { workItemId: id, outcome, reason });
    await this.act(`${p}: enqueue`, "mergeQueue.enter", {
      workItemId: id,
      headSha,
      pendingActionId: approvalId,
    });
    await this.waitTurn(p);

    let at = headSha;
    for (let i = 1; ; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      const u = await this.act(`${p}: update${sfx}`, "mergeQueue.update", { workItemId: id });
      const state = String(u.state);
      if (state === "current") break;
      if (state === "updating" && i < UPDATE_READS) {
        await this.step.sleep(`${p}: update wait${sfx}`, UPDATE_WAIT);
        continue;
      }
      if (state === "updated") {
        at = String(u.headSha);
        const ci = await this.waitForCi(b, at, 4, 1, p);
        if (ci === "success") break;
        if (ci === "conflict") {
          await leave("left", "the default branch moved again and now conflicts");
          return { kind: "conflict" };
        }
        const why = `CI is ${ci} on ${at.slice(0, 7)}, the branch with the default branch merged in`;
        await leave("left", why);
        return {
          kind: "failed",
          reason: `Merging the default branch into your branch broke CI (${ci} on ${at.slice(0, 7)}). Fix the branch against the latest default branch.`,
        };
      }
      if (state === "conflict") {
        await leave("left", String(u.reason ?? "conflict"));
        return { kind: "conflict" };
      }
      const reason =
        state === "updating"
          ? "GitHub didn't finish merging the default branch in"
          : `the merge queue couldn't update the branch (${state}): ${String(u.reason ?? "")}`;
      await leave("left", reason);
      return { kind: "failed", reason };
    }

    const { op, input } = land(at);
    const landed = await this.call(`${p}: land`, op, input, approvalId ?? undefined);
    if (landed.status === "ok") {
      await leave("merged", "merged");
      return { kind: "done" };
    }
    await leave("left", landed.status === "refused" ? landed.message : "awaiting approval");
    if (landed.status === "pending")
      return { kind: "pending", pendingActionId: landed.pendingActionId, headSha: at };
    return { kind: "refused", message: landed.message, headSha: at };
  }

  /**
   * v11: hands the approved merge to the babysitter (spec 53, ADR 0580) and waits for how it ended.
   * The entry carries the outcome too, so a missed `delivered-<item>` costs one QUEUE_WAIT.
   */
  async deliverV11(
    b: number,
    headSha: string,
    approvalId: string,
  ): Promise<
    | { kind: "done"; reason: string }
    | { kind: "conflict" }
    | { kind: "failed"; reason: string }
    | { kind: "withdrawn"; reason: string }
  > {
    const id = this.workItemId;
    const p = `merge #${b}: deliver`;
    await this.act(`${p}: enqueue`, "mergeQueue.enter", {
      workItemId: id,
      headSha,
      pendingActionId: approvalId,
      driver: "babysitter",
    });
    for (let i = 1; ; i++) {
      let told: DeliveredEventPayload | null = null;
      try {
        const event = await this.step.waitForEvent<DeliveredEventPayload>(`${p}: wait #${i}`, {
          type: deliveredEvent(id),
          timeout: QUEUE_WAIT,
        });
        told = event.payload;
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        const read = await this.call(`${p}: read #${i}`, "mergeQueue.position", { workItemId: id });
        if (read.status !== "ok") throw new Ended("failed", "the merge queue couldn't be read");
        const o = read.output;
        if (o.queued === true) continue;
        if (
          o.outcome === "merged" ||
          o.outcome === "conflict" ||
          o.outcome === "failed" ||
          o.outcome === "withdrawn"
        ) {
          told = {
            outcome: o.outcome,
            reason: String(o.outcomeReason ?? ""),
            ...(typeof o.headSha === "string" ? { headSha: o.headSha } : {}),
          };
        } else {
          throw new Ended("failed", "the item left the merge queue");
        }
      }
      if (told.outcome === "merged") return { kind: "done", reason: "merged by the babysitter" };
      if (told.outcome === "conflict") return { kind: "conflict" };
      if (told.outcome === "withdrawn") return { kind: "withdrawn", reason: told.reason };
      return { kind: "failed", reason: told.reason };
    }
  }

  /** v4: waits until the item is the head of its project's merge queue. */
  async waitTurn(p: string): Promise<void> {
    for (let i = 1; ; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      const pos = await this.call(`${p}: position${sfx}`, "mergeQueue.position", {
        workItemId: this.workItemId,
      });
      if (pos.status !== "ok") throw new Ended("failed", "the merge queue couldn't be read");
      if (pos.output.queued !== true) throw new Ended("failed", "the item left the merge queue");
      if (pos.output.head === true) return;
      try {
        await this.step.waitForEvent(`${p}: turn${sfx}`, {
          type: mergeQueueEvent(this.workItemId),
          timeout: QUEUE_WAIT,
        });
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
      }
    }
  }

  /**
   * v3: no CI has reported on the head at all. That's the repo's setup (Actions off, a run waiting
   * for approval, no workflow on `pull_request`), not the build, so a person is asked to fix it and
   * re-check, or to stop the item; no build retry is spent (ADR 0320).
   */
  async askNoCi(meta: Meta, b: number, k: number, headSha: string): Promise<void> {
    const name = `verify #${b}: no ci${k === 1 ? "" : ` #${k}`}`;
    const asked = await this.act(`${name}: ask`, "question.ask", {
      workItemId: this.workItemId,
      questions: [
        {
          domain: "operations",
          prompt: `No CI has reported on ${headSha.slice(0, 7)}, the head of work item #${meta.number}'s pull request. Fix CI on GitHub, then re-check, or stop the item.`,
          context: [
            "The factory waited and GitHub shows no check run on this commit apart from the factory's own. Usual causes:",
            "- GitHub Actions is off for the repository, or the workflow doesn't run on `pull_request`;",
            "- the run is waiting for approval (the Actions tab: 'Approve and run', e.g. for a first-time contributor such as the App's bot);",
            "- the CI provider is down.",
            "A change to the code won't fix this, so no build retry was spent.",
          ].join("\n"),
          options: [NO_CI_RECHECK, NO_CI_STOP],
          defaultAnswer: NO_CI_RECHECK,
          recommendation: NO_CI_RECHECK,
          recommendationReason: "Once CI runs on the head, verify carries on where it stopped.",
          blocking: true,
        },
      ],
    });
    await this.waitForAnswers(meta, name);
    const questionId = (asked.questionIds as string[])[0];
    const answer = await this.step.do(`${name}: answer`, async () => {
      const row = await this.env.DB.prepare("SELECT answer FROM core_questions WHERE id = ?")
        .bind(questionId)
        .first<{ answer: string | null }>();
      return row?.answer ?? NO_CI_RECHECK;
    });
    if (answer === NO_CI_STOP) {
      throw new Ended("failed", `stopped: no CI reported on ${headSha.slice(0, 7)}`);
    }
  }

  /**
   * v5's spec stage (spec 20): the planning session drafts the spec and asks questions on its own;
   * each round waits for it to ask for the gate (`planning-ready-<item>-<k>`), escalating open
   * blocking questions to the backup owner on each question timeout (never auto-accepting), then
   * opens the spec gate. Changes requested go into the same session as the approver's message; a
   * decision ends the session. Returns the approved spec's acceptance criteria.
   */
  async planningStage(meta: Meta): Promise<string[]> {
    const id = this.workItemId;
    await this.act("planning: start", "planning.start", { workItemId: id });
    for (let k = 1; ; k++) {
      const awaited = await this.act(`planning #${k}: await`, "planning.awaitReady", {
        workItemId: id,
      });
      let specId = awaited.specId as string | null;
      for (let i = 1; !awaited.ready && !specId; i++) {
        const sfx = i === 1 ? "" : ` #${i}`;
        try {
          const event = await this.step.waitForEvent<{ specId: string }>(
            `planning #${k}: ready${sfx}`,
            { type: String(awaited.event), timeout: meta.questionTimeoutMs },
          );
          specId = event.payload.specId;
        } catch (error) {
          if (!isWaitTimeout(error)) throw error;
          await this.call(`planning #${k}: escalate${sfx}`, "question.escalate", {
            workItemId: id,
          });
        }
      }
      const decided = await this.gate(meta, `planning #${k}: gate`, "spec.accept", {
        workItemId: id,
        specId,
      });
      if (decided.decision === "approved") {
        await this.act(`planning #${k}: end`, "planning.end", {
          workItemId: id,
          reason: "spec approved",
        });
        return this.step.do(`planning #${k}: criteria`, async () => {
          const row = await this.env.DB.prepare(
            "SELECT acceptance_criteria FROM core_specs WHERE id = ?",
          )
            .bind(specId)
            .first<{ acceptance_criteria: string }>();
          try {
            return JSON.parse(row?.acceptance_criteria ?? "[]") as string[];
          } catch {
            return [];
          }
        });
      }
      if (decided.decision === "changes_requested") {
        await this.act(`planning #${k}: note`, "planning.note", {
          workItemId: id,
          note: decided.note,
          by: decided.by ?? "approver",
        });
        continue; // the same session revises (spec 20, criterion 10)
      }
      // A person's word took the spec back (ADR 0470): the message is in the chat already and the
      // round moved on, so the planner revises and asks again. No version bump: nothing emitted
      // `withdrawn` for a spec gate before this release.
      if (decided.decision === "withdrawn") continue;
      await this.act(`planning #${k}: end`, "planning.end", {
        workItemId: id,
        reason: `spec ${decided.decision}`,
      });
      throw new Ended(
        "rejected",
        `spec ${decided.decision}${decided.note ? `: ${decided.note}` : ""}`,
      );
    }
  }

  /** Waits until the open blocking questions are answered, escalating on each timeout. */
  async waitForAnswers(meta: Meta, name: string): Promise<void> {
    const awaited = await this.act(`${name}: await questions`, "workItem.awaitQuestions", {
      workItemId: this.workItemId,
    });
    // Re-read after the round started: answers before it are seen here, answers after it send the event.
    const open = await this.step.do(`${name}: open questions`, async () => {
      const row = await this.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM core_questions WHERE work_item_id = ? AND status = 'open' AND blocking = 1",
      )
        .bind(this.workItemId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    });
    if (open === 0) return;
    for (let i = 1; ; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      try {
        await this.step.waitForEvent(`${name}: answers${sfx}`, {
          type: String(awaited.event),
          timeout: meta.questionTimeoutMs,
        });
        return;
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        await this.call(`${name}: escalate questions${sfx}`, "question.escalate", {
          workItemId: this.workItemId,
        });
      }
    }
  }

  /** Queues a stage job and waits for its run to finish (or stall). Holds no slot while queued. */
  // ---- v7: shaping stages before release (spec 50 part C, ADR 0493) ----

  /**
   * Waits, after the shaping stages, until the item is released and pulled. An item released
   * before its Workflow started (no shaping first) is already pulled and goes straight on.
   */
  async waitForRelease(): Promise<boolean> {
    const id = this.workItemId;
    const pulled = async (name: string) =>
      this.step.do(name, async () => {
        const row = await this.env.DB.prepare("SELECT pulled_at FROM core_work_items WHERE id = ?")
          .bind(id)
          .first<{ pulled_at: string | null }>();
        return !!row?.pulled_at;
      });
    if (await pulled("release: check")) return false;
    const shaped = await this.act("release: shaped", "workItem.shaped", { workItemId: id });
    if (shaped.released === true) return true;
    for (let k = 1; ; k++) {
      try {
        await this.step.waitForEvent(`release: wait #${k}`, {
          type: releaseEvent(id),
          timeout: RELEASE_WAIT,
        });
        return true;
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        // An event that came before the wait started is not lost: the item says it was pulled.
        if (await pulled(`release: check #${k}`)) return true;
      }
    }
  }

  // ---- v6: workflows (spec 09 M2, ADR 0371) ----

  /**
   * The workflows triage may pick from. None since ADR 0492 (an item follows its project's
   * workflow, pinned when it was pulled), except for an item started before 0261, which keeps
   * triage's pick (no `pulled_at`). The step keeps its name so running instances replay.
   */
  async workflowOptions(): Promise<{ name: string; description: string }[]> {
    const text = await this.step.do("workflow: options", async () => {
      const row = await this.env.DB.prepare(
        "SELECT pulled_at, shaping_started_at FROM core_work_items WHERE id = ?",
      )
        .bind(this.workItemId)
        .first<{ pulled_at: string | null; shaping_started_at: string | null }>();
      // Only an item from before 0261 (never pulled, never shaped) is offered a pick.
      if (row?.pulled_at || row?.shaping_started_at) return JSON.stringify([]);
      const policy = await this.pinnedPolicy();
      return JSON.stringify(
        (policy?.workflows ?? []).map((w) => ({ name: w.name, description: w.description })),
      );
    });
    return JSON.parse(text) as { name: string; description: string }[];
  }

  /**
   * The item's workflow, fixed before the build: its steps per slot with their agents resolved and
   * conditions decided (from triage's size and domains), and the build agent. Journaled once.
   */
  async workflowPlan(): Promise<WorkflowPlan> {
    const text = await this.step.do("workflow: plan", async () => {
      const row = await this.env.DB.prepare(
        "SELECT workflow, size, domains FROM core_work_items WHERE id = ?",
      )
        .bind(this.workItemId)
        .first<{ workflow: string | null; size: string | null; domains: string | null }>();
      const policy = await this.pinnedPolicy();
      const plan = planWorkflow(
        policy,
        row?.workflow ?? null,
        row?.size ?? null,
        row?.domains ?? null,
      );
      return JSON.stringify(plan);
    });
    return JSON.parse(text) as WorkflowPlan;
  }

  /** The config version the item was created under (ADR 0370 §5), parsed; null if there is none. */
  private async pinnedPolicy() {
    const row = await this.env.DB.prepare(
      `SELECT p.raw FROM core_work_items w
       JOIN core_project_policies p ON p.project_id = w.project_id
         AND p.sha = COALESCE(w.policy_sha, (SELECT policy_sha FROM core_projects WHERE id = w.project_id))
       WHERE w.id = ?`,
    )
      .bind(this.workItemId)
      .first<{ raw: string }>();
    if (!row) return null;
    const parsed = parseProjectPolicy(row.raw);
    return parsed.ok ? parsed.policy : null;
  }

  /**
   * Runs one slot's steps in order. A work step's `sendBack` stops the slot and returns the note;
   * `ask` puts its questions to a person and goes on once they're answered. A gate step waits for a
   * person: rejected ends the item.
   */
  async runSlot(
    meta: Meta,
    plan: WorkflowPlan,
    slot: SlotName,
    round: number,
    input: { criteria: string[]; specPath: string | null; headSha: string | null },
  ): Promise<{ kind: "pass" } | { kind: "sendBack"; note: string }> {
    const id = this.workItemId;
    const steps = plan.slots[slot];
    for (const [i, s] of steps.entries()) {
      const name = `slot:${slot}:${round}:${i}:${s.id}`;
      const record = (outcome: "passed" | "sentBack" | "asked" | "skipped", summary: string) =>
        this.act(`${name}: record`, "workflow.record", {
          workItemId: id,
          workflow: plan.name ?? "",
          slot,
          stepId: s.id,
          name: s.name,
          outcome,
          summary,
        });
      if (s.skip) {
        await record("skipped", s.skip);
        continue;
      }
      if (s.kind === "gate") {
        const decided = await this.gate(meta, name, "workflow.gate", {
          workItemId: id,
          workflow: plan.name ?? "",
          stepId: s.id,
          name: s.name,
          ...(s.approver ? { approver: s.approver } : {}),
          ...(s.instructions ? { instructions: s.instructions } : {}),
        });
        if (decided.decision === "approved") continue;
        if (decided.decision === "sent_back" || decided.decision === "changes_requested") {
          return { kind: "sendBack", note: `${s.name}: ${decided.note ?? "sent back"}` };
        }
        throw new Ended("rejected", `${s.name} rejected${decided.note ? `: ${decided.note}` : ""}`);
      }
      const agent = s.agent as PlannedAgent;
      const { parsed } = await this.runWithRetries(
        meta,
        name,
        "verify",
        agent.role as ModelRole,
        stepPrompt(meta, {
          workflow: plan.name ?? "",
          step: s.name,
          slot,
          instructions: [agent.instructions, s.instructions].filter(Boolean).join("\n\n"),
          criteria: input.criteria,
          headSha: input.headSha,
          specPath: input.specPath,
        }),
        {
          step: { workflow: plan.name, slot, id: s.id },
          criteria: input.criteria,
          headSha: input.headSha,
        },
        (r) => stepResultSchema.safeParse(r),
        { tier: agent.tier, requires: agent.requires },
      );
      if (parsed.verdict === "sendBack") {
        await record("sentBack", parsed.summary);
        return { kind: "sendBack", note: `${s.name}: ${parsed.notes ?? parsed.summary}` };
      }
      if (parsed.verdict === "ask" && parsed.questions.length > 0) {
        await record("asked", parsed.summary);
        await this.act(`${name}: ask`, "question.ask", {
          workItemId: id,
          questions: parsed.questions,
        });
        await this.waitForAnswers(meta, name);
        continue;
      }
      await record("passed", parsed.summary);
    }
    return { kind: "pass" };
  }

  async runJob(
    name: string,
    stage: JobStage,
    role: ModelRole,
    prompt: string,
    context: Json,
    agent?: { tier: "standard" | "light"; requires: string[] },
  ): Promise<RunResult> {
    const { jobId } = (await this.act(`${name}: enqueue`, "job.enqueue", {
      workItemId: this.workItemId,
      stage,
      role,
      prompt,
      context,
      sessionTimeoutMs: JOB_TIMEOUT_MS,
      ...(agent ? { tier: agent.tier, agentRequires: agent.requires } : {}),
    })) as { jobId: string };
    for (let i = 1; ; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      let finished: RunEventPayload;
      try {
        const event = await this.step.waitForEvent<RunEventPayload>(`${name}: wait${sfx}`, {
          type: runEvent(jobId),
          timeout: JOB_TIMEOUT_MS + STALL_MARGIN_MS,
        });
        finished = event.payload;
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
        const expired = await this.act(`${name}: expire${sfx}`, "run.expire", {
          jobId,
          reason: "no hand-back before the stall timeout",
        });
        if (expired.expired === true) {
          return {
            outcome: "stalled",
            runId: null,
            headSha: null,
            summary: "the run stalled",
            result: null,
          };
        }
        continue; // still queued (no runner free) or already finished: keep waiting
      }
      const text = await this.step.do(`${name}: result`, async () => {
        const run = await this.env.DB.prepare(
          "SELECT id, head_sha, summary, result FROM core_runs WHERE id = ?",
        )
          .bind(finished.runId)
          .first<{
            id: string;
            head_sha: string | null;
            summary: string | null;
            result: string | null;
          }>();
        let result: unknown = null;
        try {
          result = run?.result ? JSON.parse(run.result) : null;
        } catch {
          result = null;
        }
        const out: RunResult = {
          outcome: finished.outcome,
          runId: run?.id ?? finished.runId,
          headSha: run?.head_sha ?? null,
          summary: run?.summary ?? finished.reason,
          result,
        };
        return JSON.stringify(out);
      });
      return JSON.parse(text) as RunResult;
    }
  }

  /** Runs a stage job until it completes with a result that parses, up to the retry limit. */
  async runWithRetries<T>(
    meta: Meta,
    name: string,
    stage: JobStage,
    role: ModelRole,
    prompt: string,
    context: Json,
    parse: (result: unknown) => { success: true; data: T } | { success: false },
    agent?: { tier: "standard" | "light"; requires: string[] },
  ): Promise<{ run: RunResult; parsed: T }> {
    let failures = 0;
    for (let a = 1; ; a++) {
      const run = await this.runJob(`${name} run ${a}`, stage, role, prompt, context, agent);
      if (run.outcome === "cancelled") continue;
      const parsed = run.outcome === "completed" ? parse(run.result) : { success: false as const };
      if (parsed.success) return { run, parsed: parsed.data };
      failures++;
      if (failures > meta.retryLimit) {
        throw new Ended("failed", `${stage} failed ${failures} times (${run.outcome})`, {
          kind: run.outcome === "stalled" ? "run_stalled" : "run_failed",
          runId: run.runId,
        });
      }
    }
  }
}
