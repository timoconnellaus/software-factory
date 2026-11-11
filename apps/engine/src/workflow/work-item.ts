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
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  approvalEvent,
  FOREMAN,
  type GateEventPayload,
  invoke,
  isOperationError,
  type RunEventPayload,
  runEvent,
} from "@software-factory/core";
import {
  type JobStage,
  type ModelRole,
  specResultSchema,
  triageResultSchema,
  verifyResultSchema,
} from "@software-factory/runner-contract";
import { invokeDeps } from "../deps.ts";
import { buildPrompt, type ItemBrief, specPrompt, triagePrompt, verifyPrompt } from "./prompts.ts";

export interface WorkItemParams {
  workItemId: string;
}

export type WorkItemOutcome =
  | { status: "done"; workItemId: string }
  | { status: "failed" | "rejected"; workItemId: string; reason: string };

/** The version new instances start on. Bump it (and add `runVn`) for any step-name change. */
export const WORKFLOW_VERSION = 1;
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
  retryLimit: number;
  gateTimeoutMs: number;
  questionTimeoutMs: number;
}

export class WorkItemWorkflow extends WorkflowEntrypoint<Env, WorkItemParams> {
  override async run(
    event: WorkflowEvent<WorkItemParams>,
    step: WorkflowStep,
  ): Promise<WorkItemOutcome> {
    const version = await step.do("meta: version", async () => WORKFLOW_VERSION);
    const flow = new ItemFlow(this.env, step, event.payload.workItemId, event.instanceId);
    switch (version) {
      case 1:
        return flow.runV1();
      default:
        throw new Error(`no implementation for Workflow version ${version}`);
    }
  }
}

class ItemFlow {
  constructor(
    private readonly env: Env,
    private readonly step: WorkflowStep,
    private readonly workItemId: string,
    private readonly workflowId: string,
  ) {}

  // ---- v1 ----

  async runV1(): Promise<WorkItemOutcome> {
    const id = this.workItemId;
    try {
      const meta = await this.meta();
      await this.act("triage: enter", "workItem.enterStage", {
        workItemId: id,
        stage: "triage",
        workflowVersion: 1,
      });
      await this.act("branch: ensure", "branch.ensure", { workItemId: id });

      // Triage: the foreman sizes the item on a runner; code decides the spec gate from policy.
      const triageRun = await this.runWithRetries(
        meta,
        "triage",
        "triage",
        "triage",
        triagePrompt(meta),
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
        for (let k = 1; ; k++) {
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
      let note: string | null = null;
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

      for (let b = 1; ; b++) {
        const build = await this.runJob(
          `build #${b}`,
          "build",
          "implement",
          buildPrompt(meta, { criteria, specPath, note, attempt: b }),
          {
            criteria,
            specPath,
            note,
          },
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
        const headSha = String(advanced.sha);

        await this.act(`verify #${b}: enter`, "workItem.enterStage", {
          workItemId: id,
          stage: "verify",
        });
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
        const passed =
          r.checks.every((c) => c.status !== "fail") &&
          r.criteria.every((c) => c.met) &&
          r.reviewer?.verdict !== "request_changes";
        await this.act(`verify #${b}: packet`, "reviewPacket.record", {
          workItemId: id,
          runId: verify.runId,
          headSha,
          verdict: passed ? "pass" : "fail",
          summary: r.summary,
          criteria: r.criteria,
          checks: r.checks,
          reviewer: r.reviewer ? { ...r.reviewer, sameModelAsImplementer: false } : null,
          riskFlags: r.riskFlags,
        });
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

        const pr = await this.act(`merge #${b}: open PR`, "pr.open", {
          workItemId: id,
          body: r.summary,
        });
        await this.act(`merge #${b}: enter`, "workItem.enterStage", {
          workItemId: id,
          stage: "merge",
        });
        const decided = await this.gate(meta, `merge #${b}: gate`, "pr.merge", {
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
  }

  // ---- building blocks ----

  private async meta(): Promise<Meta> {
    return this.step.do("meta: item", async () => {
      const row = await this.env.DB.prepare(
        `SELECT w.number, w.title, w.body, w.branch, p.raw FROM core_work_items w
         JOIN core_projects pr ON pr.id = w.project_id
         LEFT JOIN core_project_policies p ON p.project_id = pr.id AND p.sha = pr.policy_sha
         WHERE w.id = ?`,
      )
        .bind(this.workItemId)
        .first<{
          number: number;
          title: string;
          body: string;
          branch: string;
          raw: string | null;
        }>();
      if (!row) throw new Error(`work item ${this.workItemId} not found`);
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
   * approval.
   */
  async gate(
    meta: Meta | null,
    name: string,
    op: string,
    input: unknown,
  ): Promise<
    | { decision: "approved"; output: Json }
    | { decision: Exclude<GateEventPayload["decision"], "approved">; note: string | null }
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
        return { decision: decided.decision, note: decided.note };
      const applied = await this.call(`${name}: apply`, op, input, first.pendingActionId);
      if (applied.status !== "ok") {
        throw new Ended(
          "failed",
          `${op} failed after approval: ${applied.status === "refused" ? applied.message : "still pending"}`,
        );
      }
      return { decision: "approved", output: applied.output };
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
  async runJob(
    name: string,
    stage: JobStage,
    role: ModelRole,
    prompt: string,
    context: Json,
  ): Promise<RunResult> {
    const { jobId } = (await this.act(`${name}: enqueue`, "job.enqueue", {
      workItemId: this.workItemId,
      stage,
      role,
      prompt,
      context,
      sessionTimeoutMs: JOB_TIMEOUT_MS,
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
  ): Promise<{ run: RunResult; parsed: T }> {
    let failures = 0;
    for (let a = 1; ; a++) {
      const run = await this.runJob(`${name} run ${a}`, stage, role, prompt, context);
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
