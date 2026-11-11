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
import {
  attachedTriagePrompt,
  buildPrompt,
  type ItemBrief,
  specPrompt,
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
 */
export const WORKFLOW_VERSION = 2;
/** How long verify waits for a CI event before it reads CI again, and how many times. */
export const CI_WAIT = "10 minutes";
export const CI_ROUNDS = 12;
/** Rounds to wait when no CI has reported at all (a repo without CI fails after these). */
export const CI_MISSING_ROUNDS = 3;
/** How long an attached PR waits for a push before it re-reads its head (the webhook wakes it sooner). */
export const HEAD_RECHECK = "12 hours";
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
    if (version === 1 || version === 2) {
      // An attached PR's own path (spec 05), chosen by kind. "meta: item" is runV1's first step
      // anyway and is read once, so every other item runs exactly the steps it ran before.
      const meta = await flow.meta();
      if (meta.kind === "attached") return flow.runAttached(version, meta);
    }
    switch (version) {
      case 1:
        return flow.runV1(1);
      case 2:
        return flow.runV1(2);
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

  // ---- v1 and v2 ----
  // v2 only adds steps (`verify #b: open PR`, `verify #b: ci…`, `merge #b: auto-merge`); with
  // `version === 1` the step sequence is exactly v1's, so v1 instances replay unchanged.

  async runV1(version: 1 | 2 = 1): Promise<WorkItemOutcome> {
    const id = this.workItemId;
    try {
      const meta = await this.meta();
      await this.act("triage: enter", "workItem.enterStage", {
        workItemId: id,
        stage: "triage",
        workflowVersion: version,
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
        if (version >= 2) {
          // Open the PR first, so CI runs on this head while the reviewer works (spec 04). It
          // carries a factory/verify that isn't passing until the packet below says so.
          await this.act(`verify #${b}: open PR`, "pr.open", { workItemId: id, body: meta.body });
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
        if (version >= 2) await this.waitForCi(b, headSha);
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
        const passed = version >= 2 ? packet.verdict === "pass" : runnerPassed;
        if (!passed && version >= 2) {
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

        const pr = await this.act(`merge #${b}: open PR`, "pr.open", {
          workItemId: id,
          body: r.summary,
        });
        await this.act(`merge #${b}: enter`, "workItem.enterStage", {
          workItemId: id,
          stage: "merge",
        });
        let decided: Awaited<ReturnType<ItemFlow["gate"]>> | null = null;
        if (version >= 2 && meta.kind === "incident") {
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
        await this.waitForCi(b, headSha);
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

  private async readMeta(): Promise<Meta> {
    return this.step.do("meta: item", async () => {
      const row = await this.env.DB.prepare(
        `SELECT w.number, w.title, w.body, w.branch, w.kind, w.pr_number, w.head_sha,
                pr.default_branch, p.raw FROM core_work_items w
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
          kind: "change" | "incident" | "attached";
          pr_number: number | null;
          head_sha: string | null;
          default_branch: string;
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
    options: { returnRefusedApply?: boolean } = {},
  ): Promise<
    | { decision: "approved"; output: Json }
    | {
        decision: Exclude<GateEventPayload["decision"], "approved"> | "refused";
        note: string | null;
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
        return { decision: decided.decision, note: decided.note };
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
   */
  async waitForCi(b: number, headSha: string): Promise<void> {
    for (let i = 1; i <= CI_ROUNDS; i++) {
      const sfx = i === 1 ? "" : ` #${i}`;
      const ci = await this.call(`verify #${b}: ci${sfx}`, "ci.read", {
        workItemId: this.workItemId,
        headSha,
      });
      if (ci.status !== "ok") return; // unreadable: the packet records why and fails
      const state = String(ci.output.state);
      if (state === "success" || state === "failure") return;
      if (state === "missing" && i >= CI_MISSING_ROUNDS) return;
      try {
        await this.step.waitForEvent(`verify #${b}: ci wait${sfx}`, {
          type: ciEvent(this.workItemId, headSha),
          timeout: CI_WAIT,
        });
      } catch (error) {
        if (!isWaitTimeout(error)) throw error;
      }
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
