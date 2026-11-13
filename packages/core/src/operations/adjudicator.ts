// The adjudicator (ADR 0374, spec 09 M4). For each open spec gate or workflow gate step of a kind a
// project enables, a read-only review job records the verdict it would give. Shadow mode only
// records. Active mode approves, never rejects, and only after earning it: at least 20 decisions a
// person also made, with ≥95% of its approvals matching theirs. Even then, every fifth approval is
// left to the person as a check, so its precision stays measured. Merge, deploy and self-modify are
// never its to decide.
import { RESULT_FILE } from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext, type PendingActionRow } from "../operation.ts";
import { ALWAYS_REVIEW } from "../policy/gate.ts";
import { approverIds } from "../scope.ts";
import { formatPolicy, versionOf, writeVersion } from "./config.ts";
import { approvingSpecGate, decidePending } from "./gates.ts";
import { pendingActionId, projectId, requireProject } from "./shared.ts";

export const ADJUDICATOR_MIN_DECISIONS = 20;
export const ADJUDICATOR_PRECISION = 0.95;
/** In active mode, every Nth approval verdict is still left to a person, to keep it measured. */
export const ADJUDICATOR_SAMPLE_EVERY = 5;

export type AdjudicatorKind = "spec" | "step";

/** Which kind of gate a pending action is for the adjudicator, or null if it's never its call. */
export function adjudicatorKind(pa: Pick<PendingActionRow, "kind" | "operation" | "risk">) {
  if ((ALWAYS_REVIEW as readonly string[]).includes(pa.risk) || pa.kind === "merge") return null;
  if (pa.kind === "spec" && pa.operation === "spec.accept") return "spec" as const;
  if (pa.operation === "workflow.gate") return "step" as const;
  return null;
}

export interface AdjudicatorStats {
  /** Its verdicts on gates a person decided (the last 20). */
  decisions: number;
  approvals: number;
  /** Approvals the person also approved. */
  agreed: number;
  precision: number;
  eligible: boolean;
}

/** How well its verdicts matched people's decisions, over the last 20 a person decided. */
export async function adjudicatorStats(
  ctx: Pick<HandlerContext, "db">,
  project: string,
  kind: AdjudicatorKind,
): Promise<AdjudicatorStats> {
  const rows = await ctx.db
    .selectFrom("core_adjudications as a")
    .innerJoin("core_pending_actions as pa", "pa.id", "a.pending_action_id")
    .select(["a.verdict", "pa.decision"])
    .where("a.project_id", "=", project)
    .where("a.kind", "=", kind)
    .where("a.verdict", "is not", null)
    .where("a.acted", "=", 0)
    .where("pa.decision", "is not", null)
    .orderBy("a.created_at", "desc")
    .limit(ADJUDICATOR_MIN_DECISIONS)
    .execute();
  const approvals = rows.filter((r) => r.verdict === "approve");
  const agreed = approvals.filter((r) => r.decision === "approved").length;
  const precision = approvals.length ? agreed / approvals.length : 0;
  return {
    decisions: rows.length,
    approvals: approvals.length,
    agreed,
    precision,
    eligible: rows.length >= ADJUDICATOR_MIN_DECISIONS && precision >= ADJUDICATOR_PRECISION,
  };
}

/** Refuses switching a kind to active before the adjudicator has earned it (ADR 0374). */
export async function requireAdjudicatorEarned(
  ctx: Pick<HandlerContext, "db" | "scope">,
  next: { adjudicator?: { spec?: string; step?: string } },
) {
  const project = ctx.scope.project;
  const current = ctx.scope.policy?.adjudicator;
  if (!project) return;
  for (const kind of ["spec", "step"] as const) {
    if (next.adjudicator?.[kind] !== "active" || current?.[kind] === "active") continue;
    const stats = await adjudicatorStats(ctx, project.id, kind);
    if (!stats.eligible) {
      throw new OperationError(
        "conflict",
        `the adjudicator hasn't earned ${kind === "spec" ? "spec gates" : "gate steps"} yet: ${stats.decisions} of ${ADJUDICATOR_MIN_DECISIONS} decisions, ${Math.round(stats.precision * 100)}% precision (needs ${ADJUDICATOR_PRECISION * 100}%). Run it in shadow mode until it has.`,
        { stats },
      );
    }
  }
}

const verdictSchema = z.object({
  verdict: z.enum(["approve", "defer"]),
  reason: z.string().min(1).max(2_000),
});

function prompt(
  kind: AdjudicatorKind,
  item: { number: number; title: string; body: string },
  detail: string,
): string {
  return [
    `You are the adjudicator for work item #${item.number}: ${item.title}. A person is about to decide ${kind === "spec" ? "whether to approve its spec" : "a gate step before it goes on"}. Read the repository and the branch, but change nothing.`,
    "",
    item.body,
    "",
    detail,
    "",
    "Say what a careful approver on this project would do. `approve` only if they would approve it exactly as it is. If you have any doubt, or something needs a person's judgement, `defer`: a person decides. You can't reject; a person does that. Judge the work, not anyone's explanation of it.",
    "",
    `When you are done, write your result as JSON to \`${RESULT_FILE}\` at the repository root (do not commit it):`,
    "```",
    '{ "verdict": "approve|defer", "reason": "..." }',
    "```",
  ].join("\n");
}

export const adjudicatorRequest = defineOperation({
  name: "adjudicator.request",
  description:
    "Ask the adjudicator about an open gate (ADR 0374): queue a read-only review job for a spec gate or a workflow gate step, in a project that enables the adjudicator for that kind. Never for merge, deploy or self-modify. Idempotent per gate.",
  risk: "write",
  actors: ["self-improve"],
  permission: "signed-in",
  input: z.object({ pendingActionId }),
  output: z.object({ adjudicationId: z.string().nullable(), reason: z.string() }),
  async handler(input, ctx) {
    const pa = await ctx.db
      .selectFrom("core_pending_actions")
      .selectAll()
      .where("id", "=", input.pendingActionId)
      .executeTakeFirst();
    if (!pa) throw new OperationError("not_found", "no such gate");
    const kind = adjudicatorKind(pa);
    if (!kind || !pa.work_item_id || !pa.project_id) {
      return { adjudicationId: null, reason: "not a gate the adjudicator may take" };
    }
    const mode = ctx.scope.policy?.adjudicator[kind] ?? "off";
    if (mode === "off")
      return { adjudicationId: null, reason: `the adjudicator is off for ${kind}` };
    if (pa.status !== "pending") return { adjudicationId: null, reason: "already decided" };
    const existing = await ctx.db
      .selectFrom("core_adjudications")
      .select("id")
      .where("pending_action_id", "=", pa.id)
      .executeTakeFirst();
    if (existing) return { adjudicationId: existing.id, reason: "already asked" };
    const item = await ctx.db
      .selectFrom("core_work_items")
      .select(["number", "title", "body", "current_spec_id", "status"])
      .where("id", "=", pa.work_item_id)
      .executeTakeFirstOrThrow();
    let detail: string;
    if (kind === "spec") {
      const spec = item.current_spec_id
        ? await ctx.db
            .selectFrom("core_specs")
            .select("body_md")
            .where("id", "=", item.current_spec_id)
            .executeTakeFirst()
        : undefined;
      detail = `The spec:\n\n${spec?.body_md ?? "(no spec text recorded)"}`;
    } else {
      const step = JSON.parse(pa.input) as { name?: string; instructions?: string };
      detail = `The gate step "${step.name ?? "gate"}". What the person should check: ${step.instructions || "(no instructions)"}`;
    }
    const jobId = newId("job");
    const id = newId("adjudication");
    ctx.write(
      ctx.db.insertInto("core_jobs").values({
        id: jobId,
        work_item_id: pa.work_item_id,
        project_id: pa.project_id,
        org_id: pa.org_id ?? "",
        stage: "verify",
        role: "review",
        requires: "[]",
        prompt: prompt(kind, item, detail),
        context: JSON.stringify({ adjudicate: { pendingActionId: pa.id, kind } }),
        session_timeout_ms: 30 * 60_000,
        created_at: ctx.now,
        pool: "heavy",
        // Shaping work is claimed after released work (ADR 0493, migration 0363).
        shaping: item.status === "shaping" ? 1 : 0,
      }),
    );
    ctx.write(
      ctx.db.insertInto("core_adjudications").values({
        id,
        pending_action_id: pa.id,
        project_id: pa.project_id,
        work_item_id: pa.work_item_id,
        kind,
        mode,
        job_id: jobId,
        created_at: ctx.now,
      }),
    );
    ctx.change({
      entity: "adjudication",
      id,
      after: { pendingActionId: pa.id, kind, mode, jobId },
    });
    return { adjudicationId: id, reason: `asked (${mode})` };
  },
});

export const adjudicatorRecord = defineOperation({
  name: "adjudicator.record",
  decidesPending: true,
  description:
    "Record the adjudicator's verdict on a gate once its job has handed back (ADR 0374). In active mode, with the record to show for it, an `approve` approves the gate (every fifth is left to a person as a check). A `defer` always leaves it to a person, and it never rejects. If its precision has dropped below the bar, the kind goes back to shadow mode.",
  risk: "write",
  actors: ["self-improve"],
  permission: "signed-in",
  input: z.object({ pendingActionId }),
  output: z.object({
    status: z.enum(["waiting", "recorded", "approved"]),
    verdict: z.enum(["approve", "defer"]).nullable(),
  }),
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_adjudications")
      .selectAll()
      .where("pending_action_id", "=", input.pendingActionId)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "the adjudicator wasn't asked about this gate");
    if (row.verdict) return { status: "recorded" as const, verdict: row.verdict };
    const run = await ctx.db
      .selectFrom("core_runs")
      .select(["status", "result"])
      .where("job_id", "=", row.job_id)
      .orderBy("started_at", "desc")
      .executeTakeFirst();
    const job = await ctx.db
      .selectFrom("core_jobs")
      .select("status")
      .where("id", "=", row.job_id)
      .executeTakeFirst();
    const finished = run && ["handed_back", "failed", "cancelled"].includes(run.status);
    if (!finished && job?.status !== "failed" && job?.status !== "cancelled") {
      return { status: "waiting" as const, verdict: null };
    }
    let verdict: "approve" | "defer" = "defer";
    let reason = "the adjudicator's run didn't finish with a verdict";
    try {
      const parsed = verdictSchema.safeParse(run?.result ? JSON.parse(run.result) : null);
      if (parsed.success && run?.status === "handed_back") {
        verdict = parsed.data.verdict;
        reason = parsed.data.reason;
      }
    } catch {
      // An unreadable result is a defer.
    }
    const pa = await ctx.db
      .selectFrom("core_pending_actions")
      .selectAll()
      .where("id", "=", row.pending_action_id)
      .executeTakeFirstOrThrow();
    const kind = row.kind;
    const mode = ctx.scope.policy?.adjudicator[kind] ?? "off";
    const stats = await adjudicatorStats(ctx, row.project_id, kind);
    // How many of its approve verdicts it has had in active mode: every Nth stays a person's.
    const priorApprovals = await ctx.db
      .selectFrom("core_adjudications")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("project_id", "=", row.project_id)
      .where("kind", "=", kind)
      .where("mode", "=", "active")
      .where("verdict", "=", "approve")
      .executeTakeFirst();
    const sampled = ((priorApprovals?.n ?? 0) + 1) % ADJUDICATOR_SAMPLE_EVERY === 0;
    let act =
      mode === "active" &&
      stats.eligible &&
      verdict === "approve" &&
      pa.status === "pending" &&
      adjudicatorKind(pa) === kind &&
      !sampled;
    // A plan gate approved by the adjudicator goes through what a person's approval does (review of
    // #130): the planner still stands behind it, no pulled `.kim/` file changed since, and the kept
    // designs the gate shows are recorded so the commit writes them. When that refuses, the gate
    // stays with its person, who is told why.
    let blocked: string | null = null;
    if (act && pa.kind === "spec") {
      try {
        await approvingSpecGate(ctx, pa);
      } catch (e) {
        if (!(e instanceof OperationError)) throw e;
        act = false;
        blocked = e.message;
      }
    }
    ctx.write(
      ctx.db
        .updateTable("core_adjudications")
        .set({ verdict, reason, acted: act ? 1 : 0, decided_at: ctx.now })
        .where("id", "=", row.id)
        .where("verdict", "is", null),
    );
    ctx.change({
      entity: "adjudication",
      id: row.id,
      after: {
        verdict,
        reason,
        mode,
        acted: act,
        sampled: mode === "active" && sampled,
        ...(blocked ? { blocked } : {}),
      },
    });
    // Told to the gate's assignee, or the project's first approver when it has none (review of #144).
    const told = blocked
      ? (pa.assignee_user_id ??
        (await approverIds(ctx.db, pa.org_id ?? "", ctx.scope.policy ?? null))[0] ??
        null)
      : null;
    if (blocked && told) {
      ctx.emit({
        kind: "notify",
        payload: {
          event: "adjudicator.blocked",
          userId: told,
          workItemId: pa.work_item_id,
          title: `The adjudicator approved a plan, but it can't be approved yet: ${blocked}`,
          url: pa.work_item_id ? `/?item=${pa.work_item_id}` : "/",
        },
      });
    }
    if (act) {
      decidePending(ctx, pa, "approved", `Adjudicator: ${reason}`);
      return { status: "approved" as const, verdict };
    }
    // Lost its record while active: back to shadow, a tightening (ADR 0374).
    if (mode === "active" && !stats.eligible && stats.decisions >= ADJUDICATOR_MIN_DECISIONS) {
      await fallBackToShadow(ctx, kind, stats);
    }
    return { status: "recorded" as const, verdict };
  },
});

async function fallBackToShadow(
  ctx: HandlerContext,
  kind: AdjudicatorKind,
  stats: AdjudicatorStats,
) {
  const project = requireProject(ctx);
  const row = await ctx.db
    .selectFrom("core_project_policies")
    .select("raw")
    .where("project_id", "=", project.id)
    .where("sha", "=", project.policy_sha ?? "")
    .executeTakeFirst();
  if (!row) return;
  const doc = JSON.parse(row.raw) as Record<string, unknown>;
  const adjudicator = { ...((doc.adjudicator as Record<string, unknown>) ?? {}), [kind]: "shadow" };
  await writeVersion(ctx, project, {
    raw: formatPolicy({ ...doc, adjudicator }),
    valid: true,
    error: null,
    source: "improver",
    note: `Adjudicator back to shadow for ${kind}: ${Math.round(stats.precision * 100)}% precision over the last ${stats.decisions}`,
  });
}

const statsView = z.object({
  mode: z.enum(["off", "shadow", "active"]),
  decisions: z.number(),
  approvals: z.number(),
  agreed: z.number(),
  precision: z.number(),
  eligible: z.boolean(),
});

export const adjudicatorStatsOp = defineOperation({
  name: "adjudicator.stats",
  description:
    "How the adjudicator is doing on a project (ADR 0374), per gate kind: its mode, how many of its verdicts a person also decided (the last 20), and how often its approvals matched theirs. It can go active for a kind at 20 decisions and 95% precision.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({ spec: statsView, step: statsView, configVersion: z.number() }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const modes = ctx.scope.policy?.adjudicator ?? { spec: "off", step: "off" };
    const [spec, step] = await Promise.all([
      adjudicatorStats(ctx, project.id, "spec"),
      adjudicatorStats(ctx, project.id, "step"),
    ]);
    return {
      spec: { mode: modes.spec, ...spec },
      step: { mode: modes.step, ...step },
      configVersion: versionOf(project.policy_sha) ?? 0,
    };
  },
});
