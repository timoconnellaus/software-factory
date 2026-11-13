// Dark factory mode on the server (ADR 0515, spec 52 build step (e)). The merge gate opens as a
// pending `merge` action as always. When the adjudicator, active for merges on the project and having
// earned it, approves the gate's commit, `autoApproveMerge` reads the facts and asks
// `autoApproveVerdict()`; only when every condition holds does it decide the gate, as the
// `auto-approve` actor, through this internal path: no operation any token can call approves a
// merge on its own. It only approves; the babysitter (spec 53) lands the merge.
//
// The per-project hold (ADR 0515 §7): an incident, a revert of a merge it approved, red CI on the
// default branch after one of its merges, or a person's "should not have merged" writes the
// project's `autoApproveHold`, a tightening, and tells the project's approvers and the org's admins.
// Lifting it is a config save an org admin makes and approves.
import type { Db } from "@software-factory/db";
import { z } from "zod";
import type { Actor } from "../actors.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import {
  defineOperation,
  type HandlerContext,
  type PendingActionRow,
  type ProjectRow,
} from "../operation.ts";
import {
  AUTO_APPROVE_OFF,
  type AutoApproveFacts,
  type AutoApproveSettings,
  type AutoApproveVerdict,
  autoApproveVerdict,
} from "../policy/auto-approve.ts";
import { onOrgWorkflow, parseProjectPolicy } from "../policy/project-policy.ts";
import { approverIds, loadPolicy } from "../scope.ts";
import { resolveProjectWorkflow } from "../stages/project-workflow.ts";
import { stageType } from "../stages/registry.ts";
import { formatPolicy, writeVersion } from "./config.ts";
import { decidePending, mergeGateHead } from "./gates.ts";
import { pendingActionId, repoRef } from "./shared.ts";
import { currentOrgConfig, storedOrgConfig } from "./workflows.ts";

/** Who decides a merge gate under dark factory mode: code, recorded as the decider. */
export const AUTO_APPROVE: Actor = { type: "self-improve", id: "auto-approve" };

/** One sampled auto-approved merge in this many also goes to a person afterwards (ADR 0374, 0515). */
export const REVIEW_AFTER_MERGE_EVERY = 5;

/** The key in `core_meta` that says the project has an auto-approved merge since main was last green. */
export const autoApprovedKey = (projectId: string) => `auto_approved:${projectId}`;

/** How many people one hold notifies, at most (owners and admins first, then approvers). */
const HOLD_NOTIFY = 10;

/**
 * The `autoApprove` setting of the workflow a project runs: its org workflow's merge stage, at
 * `version` (null: the org's current one). A project on its own slot workflow runs Software's
 * defaults, so it is off.
 */
export async function autoApproveSetting(
  db: Db,
  project: Pick<ProjectRow, "id" | "org_id" | "policy_sha">,
  policySha: string | null,
  version: number | null,
): Promise<AutoApproveSettings> {
  const raw = (await loadPolicy(db, { id: project.id, policy_sha: policySha })).policy;
  if (!raw || !onOrgWorkflow(raw)) return AUTO_APPROVE_OFF;
  const org =
    version === null
      ? (await currentOrgConfig(db, project.org_id)).config
      : await storedOrgConfig(db, project.org_id, version);
  if (!org) return AUTO_APPROVE_OFF;
  const def = resolveProjectWorkflow(raw, org);
  if (!def?.ok) return AUTO_APPROVE_OFF;
  const merge = def.value.stages.find((s) => s.type === "publish");
  const parsed = merge ? stageType(merge.type)?.settings.safeParse(merge.settings ?? {}) : null;
  if (!parsed?.success) return AUTO_APPROVE_OFF;
  return (parsed.data as { autoApprove?: AutoApproveSettings }).autoApprove ?? AUTO_APPROVE_OFF;
}

/**
 * The adjudicator approved a merge gate's commit: decide it with no person when every condition of
 * ADR 0515 holds, else leave it to its person with the reason on the gate. Journaled either way.
 */
export async function autoApproveMerge(
  ctx: HandlerContext,
  pa: PendingActionRow,
  adjudicator: { active: boolean; eligible: boolean; approved: boolean; jobId: string },
): Promise<AutoApproveVerdict | null> {
  if (pa.status !== "pending" || pa.kind !== "merge" || !pa.work_item_id) return null;
  const w = await ctx.db
    .selectFrom("core_work_items")
    .selectAll()
    .where("id", "=", pa.work_item_id)
    .executeTakeFirst();
  const project = ctx.scope.project;
  if (!w || !project) return null;
  // The workflow the item runs (the org version it pinned); a hold is the project's current config.
  const setting = await autoApproveSetting(
    ctx.db,
    project,
    w.policy_sha ?? project.policy_sha,
    w.org_config_version,
  );
  const headSha = mergeGateHead(pa) ?? w.head_sha ?? "";
  let touchesFactoryConfig = false;
  try {
    touchesFactoryConfig =
      (JSON.parse(pa.input) as { touchesFactoryConfig?: unknown }).touchesFactoryConfig === true;
  } catch {
    touchesFactoryConfig = true; // unreadable: treated as the factory's own change
  }
  const facts: AutoApproveFacts = {
    headSha,
    packet: null,
    adjudicator: {
      active: adjudicator.active,
      eligible: adjudicator.eligible,
      approved: adjudicator.approved,
    },
    changes: null,
    hold: ctx.scope.rawPolicy?.autoApproveHold?.reason ?? null,
    touchesFactoryConfig,
  };
  // Nothing more is read (no GitHub call) when the setting is off or the project is held.
  if (setting.enabled && !facts.hold && headSha) {
    // The newest packet on this commit (core_review_packets_item_idx).
    const packet = await ctx.db
      .selectFrom("core_review_packets")
      .select(["verdict", "sections"])
      .where("work_item_id", "=", w.id)
      .where("head_sha", "=", headSha)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (packet) {
      let sections: {
        ci?: { state?: string };
        proven?: { proven: number; total: number };
        testsIntact?: { intact?: boolean };
      } = {};
      try {
        sections = JSON.parse(packet.sections) as typeof sections;
      } catch {
        sections = {};
      }
      facts.packet = {
        verdict: packet.verdict === "pass" ? "pass" : "fail",
        ci: sections.ci?.state ?? null,
        proven: sections.proven ?? null,
        testsIntact: sections.testsIntact?.intact ?? null,
      };
    }
    const repository = w.repository_id
      ? await ctx.db
          .selectFrom("core_repositories")
          .selectAll()
          .where("id", "=", w.repository_id)
          .executeTakeFirst()
      : undefined;
    if (repository) {
      try {
        const files = await ctx.services.github.compareFiles(
          await repoRef(ctx, repository),
          repository.default_branch,
          headSha,
        );
        facts.changes = files.map((f) => ({
          path: f.path,
          changes: typeof f.changes === "number" ? f.changes : null,
        }));
        // A rename also touches where it came from.
        for (const f of files)
          if (f.previousPath) facts.changes.push({ path: f.previousPath, changes: 0 });
      } catch {
        facts.changes = null; // unread: a person decides
      }
    }
  }
  const verdict = autoApproveVerdict(facts, setting);
  ctx.change({
    entity: "pending_action",
    id: pa.id,
    after: { autoApprove: verdict.approve, reason: verdict.reason, conditions: verdict.conditions },
  });
  if (!verdict.approve) {
    // The gate's card says which condition sent it to a person.
    if (setting.enabled)
      ctx.write(
        ctx.db
          .updateTable("core_pending_actions")
          .set({ reason: `Not auto-approved: ${verdict.reason}` })
          .where("id", "=", pa.id)
          .where("status", "=", "pending"),
      );
    return verdict;
  }
  const facts_ = verdict.conditions.map((c) => `- ${c.why}`).join("\n");
  decidePending(
    { ...ctx, actor: AUTO_APPROVE } as HandlerContext,
    pa,
    "approved",
    `${verdict.reason}\n${facts_}`,
  );
  // Remembered until main is next green: red CI before then holds the project (ADR 0515 §7).
  ctx.write(
    ctx.db
      .insertInto("core_meta")
      .values({ key: autoApprovedKey(project.id), value: ctx.now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: ctx.now })),
  );
  // Sampling doesn't hold the merge (decided by the owner): every Nth also goes to a person after.
  const count = await ctx.db
    .selectFrom("core_meta")
    .select("value")
    .where("key", "=", `auto_approved_count:${project.id}`)
    .executeTakeFirst();
  const n = Number(count?.value ?? "0") + 1;
  ctx.write(
    ctx.db
      .insertInto("core_meta")
      .values({ key: `auto_approved_count:${project.id}`, value: String(n) })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: String(n) })),
  );
  if (n % REVIEW_AFTER_MERGE_EVERY === 0)
    reviewAfterMerge(ctx, pa, w.number, headSha, adjudicator.jobId);
  return verdict;
}

/** A person's look at a sampled auto-approved merge, after it (ADR 0515): an inbox item. */
function reviewAfterMerge(
  ctx: HandlerContext,
  merge: PendingActionRow,
  number: number,
  headSha: string,
  jobId: string,
) {
  const id = newId("pendingAction");
  ctx.write(
    ctx.db.insertInto("core_pending_actions").values({
      id,
      org_id: merge.org_id,
      project_id: merge.project_id,
      work_item_id: merge.work_item_id,
      workflow_id: null,
      kind: "approval",
      operation: "autoApprove.review",
      risk: "write",
      actor_type: AUTO_APPROVE.type,
      actor_id: AUTO_APPROVE.id,
      input: JSON.stringify({ workItemId: merge.work_item_id, headSha, mergeGate: merge.id }),
      reason: `Auto-approved merge of #${number}, sampled for a person's review after it merged: did it belong in main?`,
      assignee_user_id: merge.assignee_user_id,
      created_at: ctx.now,
    }),
  );
  // Its verdict feeds the adjudicator's precision on merges: approved = it was right to approve.
  ctx.write(
    ctx.db.insertInto("core_adjudications").values({
      id: newId("adjudication"),
      pending_action_id: id,
      project_id: merge.project_id ?? "",
      work_item_id: merge.work_item_id ?? "",
      kind: "merge",
      mode: "active",
      job_id: jobId,
      verdict: "approve",
      reason: "auto-approved, sampled for review after merge",
      acted: 0,
      created_at: ctx.now,
      decided_at: ctx.now,
    }),
  );
  if (merge.assignee_user_id)
    ctx.emit({
      kind: "notify",
      payload: {
        event: "autoApprove.review",
        userId: merge.assignee_user_id,
        workItemId: merge.work_item_id,
        title: `Review after merge: #${number} was auto-approved; say whether it should have merged`,
        url: merge.work_item_id ? `/?item=${merge.work_item_id}` : "/",
      },
    });
}

/**
 * Holds dark factory mode for a project (ADR 0515 §7): a new config version with `autoApproveHold`
 * (source `auto-approve`, a tightening), and a card for its approvers and the org's admins. Only for
 * a project whose workflow has it on and that isn't already held. Returns whether it held.
 */
export async function holdAutoApproval(
  ctx: HandlerContext,
  project: ProjectRow,
  reason: string,
  evidence: string[] = [],
): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("core_project_policies")
    .select("raw")
    .where("project_id", "=", project.id)
    .where("sha", "=", project.policy_sha ?? "")
    .executeTakeFirst();
  if (!row) return false;
  const parsed = parseProjectPolicy(row.raw);
  if (!parsed.ok || parsed.policy.autoApproveHold) return false;
  if (!(await autoApproveSetting(ctx.db, project, project.policy_sha, null)).enabled) return false;
  const doc = JSON.parse(row.raw) as Record<string, unknown>;
  doc.autoApproveHold = { since: ctx.now, reason, evidence: evidence.slice(0, 20) };
  await writeVersion(ctx, project, {
    raw: formatPolicy(doc),
    valid: true,
    error: null,
    source: "auto-approve",
    note: `Auto-approved merges held: ${reason}`,
  });
  const admins = await ctx.db
    .selectFrom("core_member")
    .select("user_id")
    .where("organization_id", "=", project.org_id)
    .where("role", "in", ["owner", "admin"])
    .limit(HOLD_NOTIFY)
    .execute();
  const approvers = await approverIds(ctx.db, project.org_id, parsed.policy);
  const people = [...new Set([...admins.map((a) => a.user_id), ...approvers])].slice(
    0,
    HOLD_NOTIFY,
  );
  for (const userId of people)
    ctx.emit({
      kind: "notify",
      payload: {
        event: "autoApprove.held",
        userId,
        workItemId: null,
        title: `Auto-approved merges are held on ${project.name}: ${reason}. An org admin lifts the hold.`,
        url: `/projects/${project.id}`,
      },
    });
  return true;
}

export const autoApproveReview = defineOperation({
  name: "autoApprove.review",
  decidesPending: true,
  description:
    "A person's review of a sampled auto-approved merge, after it merged (ADR 0515): `fine`, or `shouldNotHaveMerged`, which holds auto-approved merges on the project (an org admin lifts the hold). The verdict counts toward the adjudicator's precision on merges. Approvers only.",
  risk: "write",
  actors: ["human"],
  permission: "approver",
  browserOnly: true,
  input: z.object({
    pendingActionId,
    verdict: z.enum(["fine", "shouldNotHaveMerged"]),
    note: z.string().max(4_000).optional(),
  }),
  output: z.object({ decided: z.boolean(), held: z.boolean() }),
  async handler(input, ctx) {
    const pa = await ctx.db
      .selectFrom("core_pending_actions")
      .selectAll()
      .where("id", "=", input.pendingActionId)
      .executeTakeFirst();
    if (!pa || pa.operation !== "autoApprove.review")
      throw new OperationError("not_found", "no such review after merge");
    if (pa.status !== "pending") return { decided: false, held: false };
    decidePending(ctx, pa, input.verdict === "fine" ? "approved" : "rejected", input.note ?? null);
    const project = ctx.scope.project;
    const held =
      input.verdict === "shouldNotHaveMerged" && project
        ? await holdAutoApproval(
            ctx,
            project,
            `a person said an auto-approved merge should not have merged${input.note ? `: ${input.note}` : ""}`,
            [pa.work_item_id ?? ""].filter(Boolean),
          )
        : false;
    return { decided: true, held };
  },
});
