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
  criteriaProven,
  stricterAutoApprove,
} from "../policy/auto-approve.ts";
import { onOrgWorkflow, parseProjectPolicy } from "../policy/project-policy.ts";
import { approverIds, loadPolicy } from "../scope.ts";
import { resolveProjectWorkflow } from "../stages/project-workflow.ts";
import { stageType } from "../stages/registry.ts";
import { has } from "../workflow-features.ts";
import { formatPolicy, writeVersion } from "./config.ts";
import { decidePending, mergeGateHead } from "./gates.ts";
import { pendingActionId, repoRef } from "./shared.ts";
import { currentOrgConfig, storedOrgConfig } from "./workflows.ts";

/** Who decides a merge gate under dark factory mode: code, recorded as the decider. */
export const AUTO_APPROVE: Actor = { type: "self-improve", id: "auto-approve" };

/** One sampled auto-approved merge in this many also goes to a person afterwards (ADR 0374, 0515). */
export const REVIEW_AFTER_MERGE_EVERY = 5;

/** Today's auto-approvals in a project, `<date>:<n>` (one row a project, so nothing grows). */
export const autoApprovedDayKey = (projectId: string) => `auto_approved_day:${projectId}`;

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
  // On only while it is on in both the version the item pinned and the org's current one, with the
  // stricter limits (review of #152): an admin switching it off stops items already at a gate.
  const pinnedSetting = await autoApproveSetting(
    ctx.db,
    project,
    w.policy_sha ?? project.policy_sha,
    w.org_config_version,
  );
  const currentSetting = await autoApproveSetting(ctx.db, project, project.policy_sha, null);
  const setting = stricterAutoApprove(pinnedSetting, currentSetting);
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
    // Only an item whose Workflow the babysitter delivers, with its re-check (review of #152).
    versionSupports: has(w.workflow_version, "dark-factory"),
  };
  // Nothing more is read (no GitHub call) when the setting is off or the project is held.
  const day = ctx.now.slice(0, 10);
  if (setting.enabled && !facts.hold && headSha) {
    // Today's count for the project (`core_meta`, one row a project: `<date>:<n>`), by key.
    const counted = await ctx.db
      .selectFrom("core_meta")
      .select("value")
      .where("key", "=", autoApprovedDayKey(project.id))
      .executeTakeFirst();
    facts.today = counted?.value.startsWith(`${day}:`) ? Number(counted.value.slice(11)) : 0;
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
        proven?: { weakened?: boolean };
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
        criteriaProven: criteriaProven(sections as Record<string, unknown>),
        specByPerson: await specApprovedByPerson(ctx, w.id),
        weakened: sections.proven?.weakened === true,
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
          // No diff from GitHub: binary, too large, or a submodule.
          ...(f.patch === undefined && f.status !== "removed" ? { unreadable: true } : {}),
          // A submodule pointer bump, whatever .gitmodules says.
          ...(f.patch?.includes("Subproject commit") ? { submodule: true } : {}),
        }));
        // A rename also touches where it came from.
        for (const f of files)
          if (f.previousPath) facts.changes.push({ path: f.previousPath, changes: 0 });
      } catch {
        facts.changes = null; // unread: a person decides
      }
      facts.factorySource = await isFactorySource(
        ctx,
        project,
        await repoRef(ctx, repository),
        repository.default_branch,
      );
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
    // The card says why, wherever either version has it on.
    if (pinnedSetting.enabled || currentSetting.enabled)
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
  // The daily cap, in the batch: refused if another approval took the last place meanwhile, then
  // counted (`<date>:<n>`, one row a project, so nothing grows).
  const dayKey = autoApprovedDayKey(project.id);
  ctx.write(
    ctx.d1
      .prepare(
        `INSERT INTO core_batch_guard (name, ok) SELECT 'auto-approve: daily cap',
           COALESCE((SELECT CASE WHEN substr(value, 1, 10) = ?2 THEN CAST(substr(value, 12) AS INTEGER) ELSE 0 END
             FROM core_meta WHERE key = ?1), 0) < ?3`,
      )
      .bind(dayKey, day, setting.maxPerDay),
  );
  ctx.write(
    ctx.d1
      .prepare(
        `INSERT INTO core_meta (key, value) VALUES (?1, ?2 || ':1') ON CONFLICT (key) DO UPDATE SET
           value = CASE WHEN substr(value, 1, 10) = ?2
             THEN ?2 || ':' || (CAST(substr(value, 12) AS INTEGER) + 1) ELSE ?2 || ':1' END`,
      )
      .bind(dayKey, day),
  );
  return verdict;
}

/** Whether a person (not the adjudicator) approved the item's latest approved spec gate. */
async function specApprovedByPerson(ctx: HandlerContext, workItemId: string): Promise<boolean> {
  // core_pending_actions_item_idx: the item's gates, newest approved spec gate first.
  const gate = await ctx.db
    .selectFrom("core_pending_actions as pa")
    .leftJoin("core_user as u", "u.id", "pa.decided_by")
    .select(["u.id as person"])
    .where("pa.work_item_id", "=", workItemId)
    .where("pa.kind", "=", "spec")
    .where("pa.status", "in", ["approved", "applied"])
    .orderBy("pa.decided_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return !!gate?.person;
}

/** Files only the factory's own source has: any one of them present means it is (any name). */
export const FACTORY_MARKERS = [
  "apps/engine/package.json",
  "packages/core/package.json",
  "packages/runner-contract/package.json",
  "local/runner-host/package.json",
  "packages/harness-claude/package.json",
] as const;

/**
 * Whether the project's repository is the factory's own source (review of #152): the project says
 * so (`yes`, set explicitly on the factory's own project by migration 0286), or says it isn't
 * (`no`, an org admin's loosening). `auto` answers "not the factory" only on a positive result: every
 * marker read cleanly and none is there. A marker present (whatever its package is called, wherever
 * the engine moved), a read that fails or any doubt is yes: default-deny.
 */
async function isFactorySource(
  ctx: HandlerContext,
  _project: ProjectRow,
  repo: Awaited<ReturnType<typeof repoRef>>,
  branch: string,
): Promise<boolean> {
  const said = ctx.scope.rawPolicy?.factorySource ?? "auto";
  if (said !== "auto") return said === "yes";
  try {
    const reads = await Promise.all(
      FACTORY_MARKERS.map((path) => ctx.services.github.readFile(repo, path, branch)),
    );
    return reads.some((r) => r !== null);
  } catch {
    return true;
  }
}

/**
 * An auto-approved merge landed (review of #152): the red-main window starts here, at the merge
 * commit, and lasts until main's CI is green on it or a later commit; the merge is remembered (its
 * commit and PR) so a revert of it holds the project; and every fifth goes to a person to review.
 * Called by `pr.merge` once GitHub merged. Recorded with `happened`: the merge happened.
 */
export async function autoApprovedMergeLanded(
  ctx: HandlerContext,
  w: { id: string; number: number; pr_number: number | null; project_id: string },
  approval: PendingActionRow,
  mergeSha: string,
): Promise<void> {
  const project = ctx.scope.project;
  if (!project) return;
  ctx.happened(
    ctx.db
      .insertInto("core_meta")
      .values({ key: autoApprovedKey(project.id), value: `${ctx.now} ${mergeSha}` })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: `${ctx.now} ${mergeSha}` })),
  );
  // The project's recent auto-approved merges (one row, the last 50): what a revert is matched to.
  const key = autoMergedKey(project.id);
  const row = await ctx.db
    .selectFrom("core_meta")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  let merged: { sha: string; pr: number | null; number: number }[] = [];
  try {
    merged = row ? (JSON.parse(row.value) as typeof merged) : [];
  } catch {
    merged = [];
  }
  const value = JSON.stringify(
    [{ sha: mergeSha, pr: w.pr_number, number: w.number }, ...merged].slice(0, 50),
  );
  ctx.happened(
    ctx.db
      .insertInto("core_meta")
      .values({ key, value })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value })),
  );
  const adjudication = await ctx.db
    .selectFrom("core_adjudications")
    .select("job_id")
    .where("pending_action_id", "=", approval.id)
    .executeTakeFirst();
  const assignee =
    approval.assignee_user_id ??
    (await approverIds(ctx.db, project.org_id, ctx.scope.policy ?? null))[0] ??
    null;
  reviewAfterMerge(
    ctx,
    approval,
    w.number,
    mergeSha,
    adjudication?.job_id ?? "",
    assignee,
    project.id,
  );
}

/** The project's recent auto-approved merges, `[{ sha, pr, number }]`, newest first. */
export const autoMergedKey = (projectId: string) => `auto_merged:${projectId}`;

/**
 * A person's look at a sampled auto-approved merge, after it (ADR 0515): an inbox item for the
 * gate's assignee (or the project's first approver), on every `REVIEW_AFTER_MERGE_EVERY`th
 * auto-approval. The counter and the items are written in one batch, each conditional on the count
 * the batch itself made, so the choice is atomic.
 */
function reviewAfterMerge(
  ctx: HandlerContext,
  merge: PendingActionRow,
  number: number,
  headSha: string,
  jobId: string,
  assignee: string | null,
  projectId: string,
) {
  const counter = `auto_approved_count:${projectId}`;
  const sampled = `(SELECT CAST(value AS INTEGER) FROM core_meta WHERE key = '${counter.replaceAll("'", "''")}') % ${REVIEW_AFTER_MERGE_EVERY} = 0`;
  ctx.happened(
    ctx.d1
      .prepare(
        `INSERT INTO core_meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
      )
      .bind(counter),
  );
  const id = newId("pendingAction");
  ctx.happened(
    ctx.d1
      .prepare(
        `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, workflow_id, kind, operation, risk,
           actor_type, actor_id, input, reason, assignee_user_id, created_at)
         SELECT ?, ?, ?, ?, NULL, 'approval', 'autoApprove.review', 'write', ?, ?, ?, ?, ?, ? WHERE ${sampled}`,
      )
      .bind(
        id,
        merge.org_id,
        merge.project_id,
        merge.work_item_id,
        AUTO_APPROVE.type,
        AUTO_APPROVE.id,
        JSON.stringify({ workItemId: merge.work_item_id, headSha, mergeGate: merge.id }),
        `Auto-approved merge of #${number}, sampled for a person's review after it merged: did it belong in main?`,
        assignee,
        ctx.now,
      ),
  );
  // Its verdict feeds the adjudicator's precision on merges: approved = it was right to approve.
  ctx.happened(
    ctx.d1
      .prepare(
        `INSERT INTO core_adjudications (id, pending_action_id, project_id, work_item_id, kind, mode, job_id,
           verdict, reason, acted, created_at, decided_at)
         SELECT ?, ?, ?, ?, 'merge', 'active', ?, 'approve', 'auto-approved, sampled for review after merge', 0, ?, ?
         WHERE ${sampled}`,
      )
      .bind(
        newId("adjudication"),
        id,
        merge.project_id ?? "",
        merge.work_item_id ?? "",
        jobId,
        ctx.now,
        ctx.now,
      ),
  );
  if (assignee)
    ctx.happened(
      ctx.d1
        .prepare(
          `INSERT INTO core_outbox (id, at, kind, payload, next_at) SELECT ?, ?, 'notify', ?, ? WHERE ${sampled}`,
        )
        .bind(
          newId("outbox"),
          ctx.now,
          JSON.stringify({
            event: "autoApprove.review",
            userId: assignee,
            workItemId: merge.work_item_id,
            title: `Review after merge: #${number} was auto-approved; say whether it should have merged`,
            url: merge.work_item_id ? `/?item=${merge.work_item_id}` : "/",
          }),
          ctx.now,
        ),
    );
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
  // Always written, whatever the setting says (review of #152): a project that turns it on later
  // starts held, and an org admin lifts it.
  if (!parsed.ok || parsed.policy.autoApproveHold) return false;
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
