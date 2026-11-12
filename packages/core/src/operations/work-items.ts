// Work items: intake (with dedupe), reads for the app, stage bookkeeping for the Workflow, triage,
// finishing and cancelling.

import { parseJson, readBatch } from "@software-factory/db";
import { capacityPausedSchema, triageResultSchema } from "@software-factory/runner-contract";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { endPlanningSessions } from "../planning.ts";
import { specRequired } from "../policy/project-policy.ts";
import { approverIds } from "../scope.ts";
import { desiredRunnerVersion } from "../services.ts";
import { RULESET_KINDS, rulesetsUrl } from "../verify/protection.ts";
import {
  ACTIVE_STATUSES,
  INTAKE_STATES,
  linkNewItem,
  PRE_PIPELINE,
  priority,
  priorityIndex,
  priorityOf,
  releaseRefusal,
  requestPull,
  requestPullsAfterEnd,
} from "./backlog.ts";
import { queuedEntriesQuery, releaseMergeQueue } from "./merge-queue.ts";
import { protectionDriftQuery } from "./protection.ts";
import {
  ATTACHED_SKIP_REASON,
  cancelWorkItem,
  createWorkItem,
  projectId,
  repositoryId,
  requireProject,
  requireWorkItem,
  STAGES,
  setItemStatus,
  workItemId,
} from "./shared.ts";

export const SIZES = ["small", "medium", "large"] as const;
export const ITEM_STATUSES = [
  // Before release (ADR 0491); `shaping` is spec 50 part C's.
  "backlog",
  "shaping",
  "ready",
  "queued",
  "running",
  "waiting",
  "paused",
  "done",
  "failed",
  "rejected",
  "cancelled",
] as const;

const linkView = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  status: z.string(),
  projectId: z.string(),
});
const toLink = (r: {
  id: string;
  number: number;
  title: string;
  status: string;
  project_id: string;
}) => ({
  id: r.id,
  number: r.number,
  title: r.title,
  status: r.status,
  projectId: r.project_id,
});

const itemSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  orgId: z.string(),
  number: z.number(),
  title: z.string(),
  kind: z.enum(["change", "incident", "attached"]),
  stage: z.enum(STAGES),
  status: z.enum(ITEM_STATUSES),
  statusReason: z.string().nullable(),
  size: z.enum(SIZES).nullable(),
  requesterUserId: z.string(),
  source: z.string(),
  branch: z.string(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** ADR 0491: pull priority, the repository it uses (ADR 0490), and when it was released. */
  priority: priority.optional(),
  repositoryId: z.string().nullable().optional(),
  releasedAt: z.string().nullable().optional(),
});

type ItemRow = NonNullable<HandlerContext["scope"]["workItem"]>;
const summarise = (w: ItemRow): z.input<typeof itemSummary> => ({
  id: w.id,
  projectId: w.project_id,
  orgId: w.org_id,
  number: w.number,
  title: w.title,
  kind: w.kind,
  stage: w.stage,
  status: w.status,
  statusReason: w.status_reason,
  size: w.size,
  requesterUserId: w.requester_user_id,
  source: w.source,
  branch: w.branch,
  prUrl: w.pr_url,
  createdAt: w.created_at,
  updatedAt: w.updated_at,
  priority: priorityOf(w.priority),
  repositoryId: w.repository_id,
  releasedAt: w.released_at,
});

export const workItemCreate = defineOperation({
  name: "workItem.create",
  description:
    'Capture work on a project (ADR 0491). By default it lands in the backlog and nothing runs; `state: "ready"` marks it shaped; `state: "queued"` creates and releases it in one step (as New work and `sf new` do), and the factory starts its Workflow (triage → spec gate when needed → build → verify → merge gate) as soon as the project is under its active limit and what it waits for is done. Releasing follows workItem.release\'s rules: a person may; an agent or intake only where the config allows; refused when its workflow needs a repository and it has none. Idempotent per intake event: a redelivered `eventId` is a no-op; a new event whose `dedupeKey` maps to an existing item attaches to it instead of creating a second. Refused when the project has no valid `.factory/policy.json` on its default branch.',
  risk: "write",
  actors: ["human", "intake"],
  permission: "member",
  input: z
    .object({
      projectId,
      /** The repository it uses (ADR 0490): needed only when the project has several. */
      repositoryId: repositoryId.optional(),
      /** Defaults to the first line of the body. */
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(50_000).default(""),
      /** Where it came from: `app`, `cli`, `github`, … */
      source: z.string().min(1).max(40).default("app"),
      /** Unique per delivery (a webhook delivery id, a client-generated id for a form submit). */
      eventId: z.string().min(1).max(200).optional(),
      /** The thing it is about (`github:owner/repo#42`). Events with the same key attach. */
      dedupeKey: z.string().min(1).max(300).optional(),
      /** Who the work is for. Intake must name them; for a person it is themselves. */
      requesterUserId: z.string().min(1).optional(),
      /** Where it starts (ADR 0491): `queued` is create-and-release. */
      state: z.enum(INTAKE_STATES).default("backlog"),
      priority: priority.default("normal"),
      /** Items it waits for (same org, any project): it isn't pulled until they are done. */
      waitsFor: z.array(workItemId).max(20).default([]),
      acceptanceCriteria: z.array(z.string().min(1).max(2_000)).max(50).optional(),
    })
    .refine((v) => v.title || v.body.trim(), { message: "a title or a body is needed" }),
  output: z.object({
    workItemId: z.string(),
    number: z.number(),
    branch: z.string(),
    outcome: z.enum(["created", "attached", "duplicate"]),
    /** Where a created item is now: `running` when the pull started it at once. */
    status: z.string().optional(),
  }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    if (!ctx.scope.policy) {
      throw new OperationError(
        "unavailable",
        `project ${project.name} has no valid config (${ctx.scope.policyError}); agents can't work on it`,
      );
    }
    // The repository it uses: named, or the project's only one; none yet is fine before release.
    const repository = ctx.scope.repository;
    if (input.state === "queued") {
      const refused = releaseRefusal(ctx, {
        status: "ready",
        repository_id: repository?.id ?? null,
        number: project.next_number,
      });
      if (refused) throw refused;
    }
    const requester = ctx.actor.type === "human" ? ctx.actor.id : input.requesterUserId;
    if (!requester) throw new OperationError("invalid_input", "intake must name the requester");
    const eventId = input.eventId ?? crypto.randomUUID();
    const dedupeKey = input.dedupeKey ?? `${input.source}:${eventId}`;
    const title = input.title ?? input.body.trim().split("\n")[0]?.slice(0, 200) ?? "Work";

    const seen = await ctx.db
      .selectFrom("core_intake_events")
      .innerJoin("core_work_items", "core_work_items.id", "core_intake_events.work_item_id")
      .select(["core_work_items.id", "core_work_items.number", "core_work_items.branch"])
      .where("core_intake_events.event_id", "=", eventId)
      .executeTakeFirst();
    if (seen) {
      ctx.subject({ workItemId: seen.id });
      return {
        workItemId: seen.id,
        number: seen.number,
        branch: seen.branch,
        outcome: "duplicate" as const,
      };
    }

    const event = {
      event_id: eventId,
      dedupe_key: dedupeKey,
      source: input.source,
      title,
      body: input.body,
      actor_id: ctx.actor.id,
      received_at: ctx.now,
    };
    const existing = await ctx.db
      .selectFrom("core_intake_keys")
      .innerJoin("core_work_items", "core_work_items.id", "core_intake_keys.work_item_id")
      .select([
        "core_work_items.id",
        "core_work_items.number",
        "core_work_items.branch",
        "core_work_items.requester_user_id",
        "core_work_items.title",
      ])
      .where("core_intake_keys.dedupe_key", "=", dedupeKey)
      .executeTakeFirst();
    if (existing) {
      ctx.write(
        ctx.db
          .insertInto("core_intake_events")
          .values({ ...event, work_item_id: existing.id, outcome: "attached" }),
      );
      ctx.emit({
        kind: "notify",
        payload: {
          event: "workItem.attached",
          userId: existing.requester_user_id,
          workItemId: existing.id,
          title: `New activity on ${existing.title}`,
          url: `/work/${existing.id}`,
        },
      });
      ctx.subject({ workItemId: existing.id });
      return {
        workItemId: existing.id,
        number: existing.number,
        branch: existing.branch,
        outcome: "attached" as const,
      };
    }

    const created = createWorkItem(ctx, {
      project,
      repositoryId: repository?.id ?? null,
      title,
      body: input.body,
      source: input.source,
      requesterUserId: requester,
      number: project.next_number,
      state: input.state,
      priority: priorityIndex(input.priority),
      acceptanceCriteria: input.acceptanceCriteria ?? null,
    });
    await linkNewItem(ctx, { id: created.id, org_id: project.org_id }, input.waitsFor);
    // Create and release: the pull runs right after this commits, in its own batch.
    if (input.state === "queued") requestPull(ctx, project.id);
    ctx.write(
      ctx.db
        .insertInto("core_intake_keys")
        .values({ dedupe_key: dedupeKey, work_item_id: created.id, created_at: ctx.now }),
    );
    ctx.write(
      ctx.db
        .insertInto("core_intake_events")
        .values({ ...event, work_item_id: created.id, outcome: "created" }),
    );
    return {
      workItemId: created.id,
      number: project.next_number,
      branch: created.branch,
      outcome: "created" as const,
      status: input.state,
    };
  },
});

export const workItemList = defineOperation({
  name: "workItem.list",
  description: "List work items in a project or an org, newest first, optionally by status.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z
    .object({
      projectId: projectId.optional(),
      orgId: z.string().min(1).optional(),
      status: z.array(z.enum(ITEM_STATUSES)).optional(),
      /** One work item by its number (within `projectId`): how `sf show 12` finds it. */
      number: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .refine((v) => v.projectId || v.orgId, { message: "projectId or orgId" }),
  output: z.object({ items: z.array(itemSummary) }),
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_work_items")
      .selectAll()
      .orderBy("updated_at", "desc")
      .limit(input.limit);
    if (input.projectId) query = query.where("project_id", "=", input.projectId);
    else if (input.orgId) query = query.where("org_id", "=", input.orgId);
    if (input.status?.length) query = query.where("status", "in", input.status);
    if (input.number !== undefined) query = query.where("number", "=", input.number);
    return { items: (await query.execute()).map(summarise) };
  },
});

const stageView = z.object({
  stage: z.enum(STAGES),
  attempt: z.number(),
  status: z.string(),
  reason: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});

export const workItemGet = defineOperation({
  name: "workItem.get",
  description:
    "Everything about one work item for its detail page: the item, its stage history (with the triage reason for a skipped spec), the current spec and acceptance criteria, questions, open gates, runs and the latest review packet.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ workItemId }),
  output: z.object({
    item: itemSummary.extend({
      body: z.string(),
      specRequired: z.boolean().nullable(),
      specDecisionReason: z.string().nullable(),
      domains: z.array(z.string()),
      headSha: z.string().nullable(),
      prNumber: z.number().nullable(),
      policySha: z.string().nullable(),
      /** The workflow it follows (ADR 0371), null for the skeleton alone, and why. */
      workflow: z.string().nullable(),
      workflowReason: z.string().nullable(),
    }),
    /** The workflows it could follow (of the version it started under), for "change workflow". */
    workflows: z.array(z.object({ name: z.string(), description: z.string() })),
    /** ADR 0491: who released it, and its "waits for" links both ways. */
    releasedBy: z.string().nullable().optional(),
    /** ADR 0493: shaping before release: when it started and finished, and the base it planned on. */
    shaping: z
      .object({
        startedAt: z.string(),
        shapedAt: z.string().nullable(),
        baseSha: z.string().nullable(),
      })
      .nullable()
      .optional(),
    waitsFor: z.array(linkView).optional(),
    waitedOnBy: z.array(linkView).optional(),
    stages: z.array(stageView),
    spec: z
      .object({
        id: z.string(),
        version: z.number(),
        status: z.string(),
        bodyMd: z.string(),
        acceptanceCriteria: z.array(z.string()),
        assumptions: z.array(z.string()),
        path: z.string().nullable(),
        commitSha: z.string().nullable(),
      })
      .nullable(),
    questions: z.array(
      z.object({
        id: z.string(),
        domain: z.string(),
        prompt: z.string(),
        options: z.array(z.string()),
        defaultAnswer: z.string().nullable(),
        recommendation: z.string().nullable(),
        blocking: z.boolean(),
        irreversible: z.boolean(),
        status: z.string(),
        answer: z.string().nullable(),
        acceptedDefault: z.boolean(),
        assigneeUserId: z.string().nullable(),
      }),
    ),
    gates: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        operation: z.string(),
        status: z.string(),
        decision: z.string().nullable(),
        assigneeUserId: z.string().nullable(),
        createdAt: z.string(),
        decidedAt: z.string().nullable(),
        decidedBy: z.string().nullable(),
        note: z.string().nullable(),
      }),
    ),
    runs: z.array(
      z.object({
        id: z.string(),
        jobId: z.string(),
        runNo: z.number(),
        stage: z.string(),
        runnerId: z.string(),
        branch: z.string(),
        status: z.string(),
        outcome: z.string().nullable(),
        summary: z.string().nullable(),
        headSha: z.string().nullable(),
        takeover: z.object({ label: z.string(), hint: z.string() }).nullable(),
        startedAt: z.string(),
        endedAt: z.string().nullable(),
      }),
    ),
    reviewPacket: z
      .object({
        id: z.string(),
        headSha: z.string(),
        verdict: z.enum(["pass", "fail"]),
        summary: z.string(),
        criteria: z.array(z.unknown()),
        checks: z.array(z.unknown()),
        reviewer: z.unknown().nullable(),
        riskFlags: z.array(z.string()),
        sections: z.record(z.string(), z.unknown()),
        createdAt: z.string(),
      })
      .nullable(),
    /**
     * Where the item stands in its project's merge queue (ADR 0330): null when it isn't queued.
     * `position` 1 is the head, which lands next; `ahead` the work item numbers before it.
     */
    mergeQueue: z.object({ position: z.number(), ahead: z.array(z.number()) }).nullable(),
    /**
     * The project's policy as the detail page and review packet need it (spec 13, 14): null when
     * the project has no valid `.factory/policy.json`. `reviewPacketSections` null: show all.
     */
    policy: z
      .object({
        autonomyPolicy: z.string(),
        specRequiredFrom: z.enum(SIZES),
        reviewPacketSections: z.array(z.string()).nullable(),
      })
      .nullable(),
    /** Who decides this item's gates, and the rule that makes them approvers. */
    approvers: z.object({
      rule: z.string(),
      users: z.array(
        z.object({ id: z.string(), name: z.string(), githubLogin: z.string().nullable() }),
      ),
    }),
    /** What the caller may do here: the UI disables what the server would refuse anyway. */
    viewer: z.object({ isApprover: z.boolean(), isRequester: z.boolean() }),
  }),
  async handler(_input, ctx) {
    const w = requireWorkItem(ctx);
    const policy = ctx.scope.policy;
    // The approvers (two lookups) alongside the item's own rows: one wait, not three.
    const approversLookup = (async () => {
      const ids = await approverIds(ctx.db, w.org_id, policy);
      const users = ids.length
        ? await ctx.db
            .selectFrom("core_user")
            .select(["id", "name", "github_login"])
            .where("id", "in", ids)
            .execute()
        : [];
      return { ids, users };
    })();
    // The item's own rows go to D1 as one batch (ADR 0241), alongside the approver lookup.
    const [
      { ids: approverUserIds, users: approverUsers },
      [stages, specRows, questions, gates, runs, packetRows, queue, waitsForRows, waitedOnRows],
    ] = await Promise.all([
      approversLookup,
      readBatch(ctx.d1, [
        ctx.db
          .selectFrom("core_stages")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("started_at")
          .orderBy("id"),
        ctx.db
          .selectFrom("core_specs")
          .selectAll()
          .where("id", "=", w.current_spec_id ?? ""),
        ctx.db
          .selectFrom("core_questions")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("created_at"),
        ctx.db
          .selectFrom("core_pending_actions")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("created_at"),
        ctx.db
          .selectFrom("core_runs")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("run_no"),
        ctx.db
          .selectFrom("core_review_packets")
          .selectAll()
          .where("work_item_id", "=", w.id)
          .orderBy("created_at", "desc")
          .limit(1),
        // Where the item stands in the merge queue (ADR 0330); empty outside the merge stage.
        queuedEntriesQuery(ctx, w.stage === "merge" ? w.project_id : "", w.repository_id),
        ctx.db
          .selectFrom("core_work_item_links as l")
          .innerJoin("core_work_items as t", "t.id", "l.waits_for_id")
          .select(["t.id", "t.number", "t.title", "t.status", "t.project_id"])
          .where("l.work_item_id", "=", w.id),
        ctx.db
          .selectFrom("core_work_item_links as l")
          .innerJoin("core_work_items as t", "t.id", "l.work_item_id")
          .select(["t.id", "t.number", "t.title", "t.status", "t.project_id"])
          .where("l.waits_for_id", "=", w.id),
      ]),
    ]);
    const spec = w.current_spec_id ? specRows[0] : undefined;
    const packet = packetRows[0];
    return {
      item: {
        ...summarise(w),
        body: w.body,
        specRequired: w.spec_required === null ? null : w.spec_required === 1,
        specDecisionReason: w.spec_decision_reason,
        domains: parseJson<string[]>(w.domains, []),
        headSha: w.head_sha,
        prNumber: w.pr_number,
        policySha: w.policy_sha,
        workflow: w.workflow,
        workflowReason: w.workflow_reason,
      },
      workflows:
        (ctx.scope.pinnedPolicy ?? policy)?.workflows.map((x) => ({
          name: x.name,
          description: x.description,
        })) ?? [],
      releasedBy: w.released_by,
      shaping: w.shaping_started_at
        ? { startedAt: w.shaping_started_at, shapedAt: w.shaped_at, baseSha: w.shaped_base_sha }
        : null,
      waitsFor: waitsForRows.map(toLink),
      waitedOnBy: waitedOnRows.map(toLink),
      stages: stages.map((s) => ({
        stage: s.stage,
        attempt: s.attempt,
        status: s.status,
        reason: s.reason,
        startedAt: s.started_at,
        endedAt: s.ended_at,
      })),
      spec: spec
        ? {
            id: spec.id,
            version: spec.version,
            status: spec.status,
            bodyMd: spec.body_md,
            acceptanceCriteria: parseJson<string[]>(spec.acceptance_criteria, []),
            assumptions: parseJson<string[]>(spec.assumptions, []),
            path: spec.path,
            commitSha: spec.commit_sha,
          }
        : null,
      questions: questions.map((q) => ({
        id: q.id,
        domain: q.domain,
        prompt: q.prompt,
        options: parseJson<string[]>(q.options, []),
        defaultAnswer: q.default_answer,
        recommendation: q.recommendation,
        blocking: q.blocking === 1,
        irreversible: q.irreversible === 1,
        status: q.status,
        answer: q.answer,
        acceptedDefault: q.accepted_default === 1,
        assigneeUserId: q.assignee_user_id,
      })),
      gates: gates.map((g) => ({
        id: g.id,
        kind: g.kind,
        operation: g.operation,
        status: g.status,
        decision: g.decision,
        assigneeUserId: g.assignee_user_id,
        createdAt: g.created_at,
        decidedAt: g.decided_at,
        decidedBy: g.decided_by,
        note: g.note,
      })),
      runs: runs.map((r) => ({
        id: r.id,
        jobId: r.job_id,
        runNo: r.run_no,
        stage: r.stage,
        runnerId: r.runner_id,
        branch: r.branch,
        status: r.status,
        outcome: r.outcome,
        summary: r.summary,
        headSha: r.head_sha,
        takeover: parseJson<{ label: string; hint: string } | null>(r.takeover, null),
        startedAt: r.started_at,
        endedAt: r.ended_at,
      })),
      reviewPacket: packet
        ? {
            id: packet.id,
            headSha: packet.head_sha,
            verdict: packet.verdict,
            summary: packet.summary,
            criteria: parseJson<unknown[]>(packet.criteria, []),
            checks: parseJson<unknown[]>(packet.checks, []),
            reviewer: parseJson<unknown>(packet.reviewer, null),
            riskFlags: parseJson<string[]>(packet.risk_flags, []),
            sections: parseJson<Record<string, unknown>>(packet.sections, {}),
            createdAt: packet.created_at,
          }
        : null,
      mergeQueue: queuePosition(queue, w.id),
      policy: policy
        ? {
            autonomyPolicy: policy.autonomyPolicy,
            specRequiredFrom: policy.spec.requiredFrom,
            reviewPacketSections: policy.reviewPacket?.sections ?? null,
          }
        : null,
      approvers: {
        rule: policy?.approvers.length
          ? "named in the project's config"
          : "org owners and admins (no approvers named in the project's config)",
        users: approverUserIds.flatMap((id) => {
          const u = approverUsers.find((a) => a.id === id);
          return u ? [{ id: u.id, name: u.name, githubLogin: u.github_login }] : [];
        }),
      },
      viewer: {
        isApprover: approverUserIds.includes(ctx.actor.id),
        isRequester: w.requester_user_id === ctx.actor.id,
      },
    };
  },
});

export const workItemTimeline = defineOperation({
  name: "workItem.timeline",
  description:
    "A work item's timeline, straight from the audit journal (spec 13): every operation on it with actor, gate decision, outcome and reason, oldest first.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({ workItemId, limit: z.number().int().min(1).max(1000).default(500) }),
  output: z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        at: z.string(),
        operation: z.string(),
        actorType: z.string(),
        actorId: z.string(),
        decision: z.string(),
        outcome: z.string(),
        reason: z.string().nullable(),
        pendingActionId: z.string().nullable(),
        result: z.unknown(),
      }),
    ),
  }),
  async handler(input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_audit")
      .select([
        "id",
        "at",
        "operation",
        "actor_type",
        "actor_id",
        "decision",
        "outcome",
        "reason",
        "pending_action_id",
        "result",
      ])
      .where("work_item_id", "=", input.workItemId)
      .orderBy("at")
      .orderBy(sql`rowid`)
      .limit(input.limit)
      .execute();
    return {
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at,
        operation: r.operation,
        actorType: r.actor_type,
        actorId: r.actor_id,
        decision: r.decision,
        outcome: r.outcome,
        reason: r.reason,
        pendingActionId: r.pending_action_id,
        result: parseJson<unknown>(r.result, null),
      })),
    };
  },
});

export const workItemCancel = defineOperation({
  name: "workItem.cancel",
  description:
    "Cancel a work item: stops its Workflow and its runs, frees its runner slot, and closes its open gates. The requester or a project approver.",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, reason: z.string().max(1_000).default("cancelled") }),
  output: z.object({ cancelled: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (w.requester_user_id !== ctx.actor.id) {
      const approvers = await approverIds(ctx.db, w.org_id, ctx.scope.policy);
      if (!approvers.includes(ctx.actor.id)) {
        throw new OperationError("forbidden", "only the requester or an approver can cancel");
      }
    }
    // Nothing runs before the pull, unless the item is being (or was) shaped: then its Workflow,
    // runs and gates are cancelled like any running item's (ADR 0493).
    if ((PRE_PIPELINE as readonly string[]).includes(w.status) && !w.shaping_started_at) {
      // Nothing runs before the pull (ADR 0491): no Workflow, runs or gates to stop.
      ctx.write(
        ctx.db
          .updateTable("core_work_items")
          .set({
            status: "cancelled",
            status_reason: input.reason,
            closed_at: ctx.now,
            updated_at: ctx.now,
          })
          .where("id", "=", w.id)
          .where("status", "=", w.status),
      );
      ctx.guardChanged("cancel");
      ctx.change({
        entity: "work_item",
        id: w.id,
        before: { status: w.status },
        after: { status: "cancelled", reason: input.reason },
      });
      return { cancelled: true };
    }
    if (
      !(ACTIVE_STATUSES as readonly string[]).includes(w.status) &&
      !(w.shaping_started_at && (PRE_PIPELINE as readonly string[]).includes(w.status))
    ) {
      return { cancelled: false };
    }
    await releaseMergeQueue(ctx, w, "left", `cancelled: ${input.reason}`);
    cancelWorkItem(ctx, w, input.reason);
    // Its slot is free: the next queued item may start, after this commits (ADR 0491).
    requestPull(ctx, w.project_id);
    return { cancelled: true };
  },
});

export const workItemTriage = defineOperation({
  name: "workItem.triage",
  description:
    "Record the foreman's triage of a work item: size, domains touched and draft acceptance criteria. Whether the spec gate is needed is decided here in code from the autonomy policy's threshold; the foreman's own request to skip the spec is advisory and can't skip a spec the policy requires. The decision and its reason are journaled.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ workItemId, result: triageResultSchema }),
  output: z.object({
    size: z.enum(SIZES),
    specRequired: z.boolean(),
    reason: z.string(),
    specId: z.string(),
    /** The workflow picked (ADR 0371), or null for the skeleton alone. */
    workflow: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const policy = ctx.scope.policy;
    if (!policy) throw new OperationError("denied", "no valid policy");
    // An item follows its project's workflow, pinned when it was pulled (ADR 0492): triage no
    // longer picks, and a pick it still sends is ignored. An item started before 0261 (no
    // `pulled_at`) was promised triage's pick (ADR 0371): it keeps that rule, so the deploy never
    // takes a workflow's gate steps away from work already under way.
    let workflow = w.kind === "attached" ? null : w.workflow;
    let workflowReason = w.kind === "attached" ? null : w.workflow_reason;
    // Legacy: never pulled and never shaped (a shaping item's workflow is pinned by
    // workItem.shape, and triage doesn't change it, ADR 0492/0493).
    if (w.kind !== "attached" && !w.pulled_at && !w.shaping_started_at) {
      const shape = ctx.scope.pinnedPolicy ?? policy;
      const picked = input.result.workflow
        ? (shape.workflows.find(
            (x) => x.name.toLowerCase() === input.result.workflow?.toLowerCase(),
          ) ?? null)
        : null;
      workflow = picked?.name ?? null;
      workflowReason = workflow
        ? (input.result.workflowReason ?? "picked by triage")
        : input.result.workflow
          ? `triage asked for "${input.result.workflow}", which this project doesn't have: the skeleton alone`
          : null;
    }
    // An attached PR is already built: spec and build are skipped whatever its size (spec 05).
    const decision =
      w.kind === "attached"
        ? { required: false, reason: ATTACHED_SKIP_REASON }
        : specRequired(policy, input.result.size, input.result.specRequested);
    const reason = `${decision.reason}. Triage: ${input.result.reason}`;
    const specId = newId("spec");
    const criteria = input.result.acceptanceCriteria;
    const body = [
      `# ${w.title}`,
      "",
      input.result.summary ?? w.body,
      "",
      "## Acceptance criteria",
      ...criteria.map((c, i) => `${i + 1}. ${c}`),
    ].join("\n");
    const version =
      ((
        await ctx.db
          .selectFrom("core_specs")
          .select((eb) => eb.fn.max("version").as("v"))
          .where("work_item_id", "=", w.id)
          .executeTakeFirst()
      )?.v ?? 0) + 1;
    ctx.write(
      ctx.db.insertInto("core_specs").values({
        id: specId,
        work_item_id: w.id,
        version,
        body_md: body,
        acceptance_criteria: JSON.stringify(criteria),
        assumptions: "[]",
        status: "draft",
        created_by: ctx.actor.id,
        created_at: ctx.now,
      }),
    );
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          size: input.result.size,
          spec_required: decision.required ? 1 : 0,
          spec_decision_reason: reason,
          domains: JSON.stringify(input.result.domains),
          current_spec_id: specId,
          workflow,
          workflow_reason: workflowReason,
          updated_at: ctx.now,
        })
        .where("id", "=", w.id),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { size: w.size, specRequired: w.spec_required, workflow: w.workflow },
      after: {
        size: input.result.size,
        specRequired: decision.required,
        reason,
        workflow,
        workflowReason,
      },
    });
    return { size: input.result.size, specRequired: decision.required, reason, specId, workflow };
  },
});

export const workItemEnterStage = defineOperation({
  name: "workItem.enterStage",
  description:
    "Move a work item to a stage: closes the active stage (done, sent back or failed), records skipped stages with their reason, and opens the new one. The Workflow calls it at every transition, so stage history and durations come from here.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    stage: z.enum(STAGES),
    closeAs: z.enum(["done", "sent_back", "failed"]).default("done"),
    reason: z.string().max(4_000).optional(),
    skipped: z
      .array(z.object({ stage: z.enum(STAGES), reason: z.string().max(4_000) }))
      .default([]),
    /** The Workflow version driving the item (ADR 0053), recorded on its first transition. */
    workflowVersion: z.number().int().positive().optional(),
  }),
  output: z.object({ stage: z.enum(STAGES), attempt: z.number() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    ctx.write(
      ctx.db
        .updateTable("core_stages")
        .set({ status: input.closeAs, ended_at: ctx.now, reason: input.reason ?? null })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "active"),
    );
    for (const skip of input.skipped) {
      ctx.write(
        ctx.db.insertInto("core_stages").values({
          id: newId("stage"),
          work_item_id: w.id,
          stage: skip.stage,
          attempt: 1,
          status: "skipped",
          reason: skip.reason,
          started_at: ctx.now,
          ended_at: ctx.now,
        }),
      );
    }
    const attempt =
      Number(
        (
          await ctx.db
            .selectFrom("core_stages")
            .select((eb) => eb.fn.countAll().as("n"))
            .where("work_item_id", "=", w.id)
            .where("stage", "=", input.stage)
            .where("status", "!=", "skipped")
            .executeTakeFirst()
        )?.n ?? 0,
      ) + 1;
    ctx.write(
      ctx.db.insertInto("core_stages").values({
        id: newId("stage"),
        work_item_id: w.id,
        stage: input.stage,
        attempt,
        status: input.stage === "done" ? "done" : "active",
        started_at: ctx.now,
        ended_at: input.stage === "done" ? ctx.now : null,
      }),
    );
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          stage: input.stage,
          updated_at: ctx.now,
          ...(input.workflowVersion ? { workflow_version: input.workflowVersion } : {}),
        })
        .where("id", "=", w.id),
    );
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { stage: w.stage },
      after: { stage: input.stage, attempt },
    });
    return { stage: input.stage, attempt };
  },
});

export const workItemFinish = defineOperation({
  name: "workItem.finish",
  description:
    "End a work item's Workflow: done (merged), failed (retries exhausted, a run failed for good) or rejected (a person rejected a gate).",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    status: z.enum(["done", "failed", "rejected"]),
    reason: z.string().max(4_000),
  }),
  output: z.object({ status: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    // `shaping`: a spec rejected while shaping before release ends the item too (ADR 0493).
    if (!["running", "waiting", "paused", "shaping"].includes(w.status))
      return { status: w.status };
    setItemStatus(
      ctx,
      w.id,
      ["running", "waiting", "paused", "shaping"],
      input.status,
      input.reason,
    );
    // Its planning session, if it ended mid-planning, gives its slot back (spec 20).
    endPlanningSessions(ctx, w.id, `${input.status}: ${input.reason}`);
    // An item that ends in the queue (a Workflow giving up, or done without the queue's merge)
    // stops holding it; the next head is woken (ADR 0330).
    await releaseMergeQueue(
      ctx,
      w,
      input.status === "done" ? "merged" : "left",
      `${input.status}: ${input.reason}`,
    );
    ctx.write(
      ctx.db.updateTable("core_work_items").set({ closed_at: ctx.now }).where("id", "=", w.id),
    );
    ctx.write(
      ctx.db
        .updateTable("core_stages")
        .set({
          status: input.status === "done" ? "done" : "failed",
          ended_at: ctx.now,
          reason: input.reason,
        })
        .where("work_item_id", "=", w.id)
        .where("status", "=", "active"),
    );
    if (input.status === "done") {
      ctx.write(
        ctx.db.insertInto("core_stages").values({
          id: newId("stage"),
          work_item_id: w.id,
          stage: "done",
          attempt: 1,
          status: "done",
          started_at: ctx.now,
          ended_at: ctx.now,
        }),
      );
      ctx.write(
        ctx.db.updateTable("core_work_items").set({ stage: "done" }).where("id", "=", w.id),
      );
    }
    ctx.emit({
      kind: "notify",
      payload: {
        event: `workItem.${input.status}`,
        userId: w.requester_user_id,
        workItemId: w.id,
        title: `${input.status === "done" ? "Shipped" : input.status === "failed" ? "Failed" : "Rejected"}: ${w.title}`,
        url: `/work/${w.id}`,
      },
    });
    ctx.change({
      entity: "work_item",
      id: w.id,
      before: { status: w.status },
      after: { status: input.status },
    });
    // Its slot is free, and what waited on it may start (ADR 0491).
    await requestPullsAfterEnd(ctx, w, input.status);
    return { status: input.status };
  },
});

export const inboxList = defineOperation({
  name: "inbox.list",
  description:
    "What is waiting on the signed-in person (spec 12): open gates and questions assigned to them (or, unassigned, on projects they approve), grouped by project; running items; their runners' health; and projects held back by their WIP limit.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ orgId: z.string().min(1).optional() }),
  output: z.object({
    gates: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        workItemId: z.string().nullable(),
        projectId: z.string().nullable(),
        title: z.string(),
        operation: z.string(),
        createdAt: z.string(),
        timeoutAt: z.string().nullable(),
        escalated: z.boolean(),
      }),
    ),
    questions: z.array(
      z.object({
        id: z.string(),
        workItemId: z.string(),
        projectId: z.string(),
        title: z.string(),
        domain: z.string(),
        prompt: z.string(),
        options: z.array(z.string()),
        defaultAnswer: z.string().nullable(),
        recommendation: z.string().nullable(),
        irreversible: z.boolean(),
      }),
    ),
    running: z.array(itemSummary),
    runners: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        state: z.enum(["online", "busy", "rate-limited", "offline", "draining"]),
        inUse: z.number(),
        max: z.number(),
        /** The light pool (ADR 0301), when the runner reports one; `inUse`/`max` are then heavy. */
        light: z.object({ inUse: z.number(), max: z.number() }).nullable(),
        rateLimitedUntil: z.string().nullable(),
        lastSeenAt: z.string().nullable(),
        /**
         * Why it takes nothing new in some pools for now (ADR 0552): its load (with the numbers)
         * or its tmux. Null when it takes work everywhere, or is offline.
         */
        paused: capacityPausedSchema.nullable(),
        /**
         * Its code against the deployed commit (ADR 0360): null when it's current or doesn't
         * report a version. `behind`: updating on its own (`waiting`/`updating`); `blocked` and
         * `rolled_back` need a person, with the reason.
         */
        update: z
          .object({
            state: z.enum(["behind", "blocked", "rolled_back"]),
            reason: z.string().nullable(),
          })
          .nullable(),
      }),
    ),
    /** "Planning is ready" (spec 20): open planning sessions with a first draft, and what's open. */
    planning: z.array(
      z.object({
        workItemId: z.string(),
        projectId: z.string(),
        number: z.number(),
        title: z.string(),
        status: z.string(),
        openQuestions: z.number(),
        atGate: z.boolean(),
        announcedAt: z.string(),
      }),
    ),
    wipHolds: z.array(z.object({ projectId: z.string(), waitingBuilds: z.number() })),
    /** "Protection on `main` changed" (ADR 0280): projects whose protection went red after ok. */
    protection: z.array(
      z.object({
        projectId: z.string(),
        name: z.string(),
        repo: z.object({ owner: z.string(), name: z.string() }),
        branch: z.string(),
        problems: z.array(z.string()),
        changedAt: z.string(),
        rulesetsUrl: z.string(),
        files: z.array(z.object({ kind: z.enum(RULESET_KINDS), filename: z.string() })),
      }),
    ),
  }),
  async handler(input, ctx) {
    const me = ctx.actor.id;
    // The caller's orgs (narrowed to one when asked), as a subquery: everything below is one D1
    // request (ADR 0241).
    const myOrgs = ctx.db
      .selectFrom("core_member")
      .select("organization_id")
      .where("user_id", "=", me)
      .$if(!!input.orgId, (q) => q.where("organization_id", "=", input.orgId ?? ""));
    const [pending, questionRows, running, runnerRows, holds, drift, planningRows] =
      await readBatch(ctx.d1, [
        ctx.db
          .selectFrom("core_pending_actions")
          .leftJoin("core_work_items", "core_work_items.id", "core_pending_actions.work_item_id")
          .select([
            "core_pending_actions.id",
            "core_pending_actions.kind",
            "core_pending_actions.work_item_id",
            "core_pending_actions.project_id",
            "core_pending_actions.org_id",
            "core_pending_actions.operation",
            "core_pending_actions.assignee_user_id",
            "core_pending_actions.created_at",
            "core_pending_actions.timeout_at",
            "core_pending_actions.escalations",
            "core_work_items.title",
          ])
          .where("core_pending_actions.status", "=", "pending")
          .where("core_pending_actions.org_id", "in", myOrgs)
          .orderBy("core_pending_actions.project_id")
          .orderBy("core_pending_actions.created_at"),
        ctx.db
          .selectFrom("core_questions")
          .innerJoin("core_work_items", "core_work_items.id", "core_questions.work_item_id")
          .select([
            "core_questions.id",
            "core_questions.work_item_id",
            "core_questions.project_id",
            "core_questions.domain",
            "core_questions.prompt",
            "core_questions.options",
            "core_questions.default_answer",
            "core_questions.recommendation",
            "core_questions.irreversible",
            "core_work_items.title",
          ])
          .where("core_questions.status", "=", "open")
          .where("core_questions.assignee_user_id", "=", me)
          .where("core_questions.org_id", "in", myOrgs)
          .orderBy("core_questions.project_id")
          .orderBy("core_questions.created_at"),
        ctx.db
          .selectFrom("core_work_items")
          .selectAll()
          .where("org_id", "in", myOrgs)
          .where("status", "in", ["running", "waiting", "paused"])
          .orderBy("updated_at", "desc")
          .limit(100),
        ctx.db
          .selectFrom("core_runners")
          .selectAll()
          .select((eb) =>
            eb
              .selectFrom("core_runs")
              .select(eb.fn.countAll<number>().as("n"))
              .whereRef("core_runs.runner_id", "=", "core_runners.id")
              .where("core_runs.status", "in", ACTIVE_RUN_STATUSES)
              .as("active_runs"),
          )
          .select((eb) =>
            eb
              .selectFrom("core_runs")
              .innerJoin("core_jobs", "core_jobs.id", "core_runs.job_id")
              .select(eb.fn.countAll<number>().as("n"))
              .whereRef("core_runs.runner_id", "=", "core_runners.id")
              .where("core_runs.status", "in", ACTIVE_RUN_STATUSES)
              .where("core_jobs.pool", "=", "light")
              .as("light_runs"),
          )
          .where("owner_user_id", "=", me)
          .where("revoked_at", "is", null),
        ctx.db
          .selectFrom("core_jobs")
          .select(["project_id", (eb) => eb.fn.countAll().as("n")])
          .where("org_id", "in", myOrgs)
          .where("status", "=", "queued")
          .where("wait_reason", "=", WIP_WAIT_REASON)
          .groupBy("project_id"),
        protectionDriftQuery(ctx, myOrgs),
        ctx.db
          .selectFrom("core_planning_sessions")
          .innerJoin("core_work_items", "core_work_items.id", "core_planning_sessions.work_item_id")
          .select((eb) => [
            "core_planning_sessions.work_item_id",
            "core_planning_sessions.status",
            "core_planning_sessions.at_gate",
            "core_planning_sessions.announced_at",
            "core_work_items.project_id",
            "core_work_items.number",
            "core_work_items.title",
            eb
              .selectFrom("core_questions")
              .select(eb.fn.countAll<number>().as("n"))
              .whereRef("core_questions.work_item_id", "=", "core_planning_sessions.work_item_id")
              .where("core_questions.status", "=", "open")
              .as("open_questions"),
          ])
          .where("core_work_items.org_id", "in", myOrgs)
          .where("core_planning_sessions.announced_at", "is not", null)
          .where("core_planning_sessions.status", "not in", ["ended", "moved"])
          .orderBy("core_planning_sessions.announced_at", "desc")
          .limit(50),
      ]);
    const gates = pending
      .filter((g) => g.assignee_user_id === me)
      .map((g) => ({
        id: g.id,
        kind: g.kind,
        workItemId: g.work_item_id,
        projectId: g.project_id,
        title: g.title ?? g.operation,
        operation: g.operation,
        createdAt: g.created_at,
        timeoutAt: g.timeout_at,
        escalated: g.escalations > 0,
      }));
    const nowMs = Date.parse(ctx.now);
    const runners = runnerRows.map((r) => {
      const all = Number(r.active_runs ?? 0);
      const lightActive = Number(r.light_runs ?? 0);
      // With a light pool, `inUse` is the heavy pool's (ADR 0301).
      const active = r.light_max === null ? all : all - lightActive;
      const offline = !r.last_seen_at || nowMs - Date.parse(r.last_seen_at) > RUNNER_OFFLINE_MS;
      const limited = r.rate_limited_until !== null && Date.parse(r.rate_limited_until) > nowMs;
      const state = offline
        ? ("offline" as const)
        : limited
          ? ("rate-limited" as const)
          : !r.accepting
            ? ("draining" as const)
            : all > 0
              ? ("busy" as const)
              : ("online" as const);
      return {
        id: r.id,
        name: r.name,
        state,
        inUse: active,
        max: r.capacity_max,
        light: r.light_max === null ? null : { inUse: lightActive, max: r.light_max },
        rateLimitedUntil: limited ? r.rate_limited_until : null,
        lastSeenAt: r.last_seen_at,
        paused: offline
          ? null
          : (capacityPausedSchema.safeParse(parseJson<unknown>(r.paused, null)).data ?? null),
        update: runnerUpdate(r, desiredRunnerVersion(ctx.services)),
      };
    });

    return {
      gates,
      questions: questionRows.map((q) => ({
        id: q.id,
        workItemId: q.work_item_id,
        projectId: q.project_id,
        title: q.title,
        domain: q.domain,
        prompt: q.prompt,
        options: parseJson<string[]>(q.options, []),
        defaultAnswer: q.default_answer,
        recommendation: q.recommendation,
        irreversible: q.irreversible === 1,
      })),
      running: running.map(summarise),
      runners,
      planning: planningRows.map((p) => ({
        workItemId: p.work_item_id,
        projectId: p.project_id,
        number: p.number,
        title: p.title,
        status: p.status,
        openQuestions: Number(p.open_questions ?? 0),
        atGate: p.at_gate === 1,
        announcedAt: p.announced_at ?? "",
      })),
      wipHolds: holds.map((h) => ({ projectId: h.project_id, waitingBuilds: Number(h.n) })),
      protection: drift.map((d) => {
        const problems = parseJson<string[]>(d.problems, []);
        return {
          projectId: d.projectId,
          name: d.name,
          repo: { owner: d.owner, name: d.repo },
          branch: d.branch,
          problems,
          changedAt: d.changedAt,
          rulesetsUrl: rulesetsUrl({ owner: d.owner, name: d.repo }),
          files: (problems.some((p) => p.includes("confines the App's pushes"))
            ? (["default-branch", "factory-branches"] as const)
            : (["default-branch"] as const)
          ).map((kind) => ({ kind, filename: `${d.repo}-${kind}.json` })),
        };
      }),
    };
  },
});

/** A runner not heard from in this long shows as offline. */
export const RUNNER_OFFLINE_MS = 2 * 60_000;
/** The queued reason when a project is at its WIP limit (spec 03, criterion 10). */
export const WIP_WAIT_REASON = "waiting on review";

/** Run statuses that hold a runner slot. */
const ACTIVE_RUN_STATUSES = ["claimed", "preparing", "running", "collecting"] as const;

export async function activeRunCount(
  ctx: Pick<HandlerContext, "db">,
  runnerId: string,
): Promise<number> {
  const row = await ctx.db
    .selectFrom("core_runs")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("runner_id", "=", runnerId)
    .where("status", "in", ACTIVE_RUN_STATUSES)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** The item's place in its project's merge queue, from the queue head first (ADR 0330). */
function queuePosition(
  queue: { work_item_id: string; number: number }[],
  item: string,
): { position: number; ahead: number[] } | null {
  const i = queue.findIndex((e) => e.work_item_id === item);
  return i < 0 ? null : { position: i + 1, ahead: queue.slice(0, i).map((e) => e.number) };
}

/**
 * How a runner's code stands against the commit runners should run, for the inbox's health line
 * (ADR 0360, 0520). A runner that says it is `current` checked that itself: it may be ahead of the
 * desired commit (on the deployed one, say), which only git on the runner can tell.
 */
function runnerUpdate(
  r: { version: string | null; update_state: string | null; update_reason: string | null },
  desired: string | null,
): { state: "behind" | "blocked" | "rolled_back"; reason: string | null } | null {
  if (r.update_state === "blocked" || r.update_state === "rolled_back") {
    return { state: r.update_state, reason: r.update_reason };
  }
  if (r.update_state === "current") return null;
  if (!r.version || !desired || r.version === desired) return null;
  return { state: "behind", reason: null };
}

export const workItemSetWorkflow = defineOperation({
  name: "workItem.setWorkflow",
  description:
    "Refused since ADR 0492: a work item follows its project's workflow (the config's `workflow`), pinned when its pipeline starts, and there is no per-item override. Change the project's workflow in its config instead (config.save).",
  risk: "write",
  actors: ["human"],
  permission: "member",
  input: z.object({ workItemId, workflow: z.string().max(60).nullable() }),
  output: z.object({ workflow: z.string().nullable() }),
  async handler(_input, ctx) {
    requireWorkItem(ctx);
    throw new OperationError(
      "conflict",
      "an item follows its project's workflow (ADR 0492): change the project's workflow in its config",
    );
  },
});

export const workflowGate = defineOperation({
  name: "workflow.gate",
  description:
    "A workflow's gate step (ADR 0371): a person decides before the work item goes on. Always waits for a person, whatever the autonomy policy: the named approver, or the project's approvers. The Workflow calls it; approving lets the item continue, rejecting ends it, sending back returns it to build.",
  risk: "plan",
  alwaysReview: true,
  assignee: (input) => input.approver ?? null,
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    workflow: z.string().max(60),
    stepId: z.string().max(40),
    name: z.string().max(80),
    approver: z.string().max(100).optional(),
    instructions: z.string().max(4_000).optional(),
  }),
  output: z.object({ passed: z.boolean() }),
  async handler(input, ctx) {
    requireWorkItem(ctx);
    ctx.change({
      entity: "work_item",
      id: input.workItemId,
      after: { gateStep: input.stepId, passed: true },
    });
    return { passed: true };
  },
});

export const workflowRecord = defineOperation({
  name: "workflow.record",
  description:
    "Record what one of a workflow's steps did (ADR 0371), for the timeline: a work step's advisory verdict (passed, sent back, asked) with its summary, or a step its condition skipped. The Workflow calls it.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    workflow: z.string().max(60),
    slot: z.enum(["afterSpec", "beforeVerify", "afterVerify"]),
    stepId: z.string().max(40),
    name: z.string().max(80),
    outcome: z.enum(["passed", "sentBack", "asked", "skipped"]),
    summary: z.string().max(4_000),
  }),
  output: z.object({ ok: z.boolean() }),
  async handler(input, ctx) {
    requireWorkItem(ctx);
    ctx.change({
      entity: "work_item",
      id: input.workItemId,
      after: {
        step: `${input.workflow} → ${input.name}`,
        slot: input.slot,
        outcome: input.outcome,
        summary: input.summary,
      },
    });
    return { ok: true };
  },
});
