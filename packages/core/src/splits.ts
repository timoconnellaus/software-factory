// A plan splits a work item (spec 24, ADR 0303, 0630). The planner lists children in the spec; one
// person's approval of the spec creates them, held in Ready until the parent's spec-only PR has
// merged, so their triage and planning read the parent's spec and `.kim/` from main. Then they are
// released together; a child with `after` waits (spec 50's "waits for" link) until its sibling has
// merged. The parent builds nothing: its PR carries exactly the approved files, and it closes when
// its last child ends (done if any merged, cancelled if all were cancelled).
import { parseJson } from "@software-factory/db";
import { type SpecChild, specChildSchema } from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "./errors.ts";
import type { HandlerContext, WorkItemRow } from "./operation.ts";
import { requestPull } from "./operations/backlog.ts";
import { createWorkItem } from "./operations/shared.ts";
import { park } from "./readiness.ts";

/** The most children one plan may split into (the schema's limit; bounds every read here). */
export const SPLIT_MAX = 8;

/** Statuses a work item doesn't leave. */
const ENDED = ["done", "failed", "rejected", "cancelled"] as const;

/** A spec version's children, or [] (none, or unreadable). */
export function childrenOf(json: string | null | undefined): SpecChild[] {
  if (!json) return [];
  const parsed = z.array(specChildSchema).max(SPLIT_MAX).safeParse(parseJson<unknown>(json, null));
  return parsed.success ? parsed.data : [];
}

/** A Workflow event: the last of a parent's children ended. Payload `{ done, cancelled }`. */
export const splitSettledEvent = (parentId: string) => `split-${parentId}`;

/** A child's body: its slice of the approved plan, and where it came from. */
export function sliceBody(
  parent: Pick<WorkItemRow, "number" | "title" | "slug">,
  child: SpecChild,
  siblingNumbers: Map<string, number>,
): string {
  const after = child.after ? siblingNumbers.get(child.after) : undefined;
  return [
    `Part of #${parent.number} (${parent.title}), split off by its approved plan (\`docs/specs/wi-${parent.number}-${parent.slug}.md\`). This slice was approved with it [parent].`,
    after ? `\nWaits for #${after} to merge first.` : "",
    "\n## Goal",
    child.goal,
    "\n## Scope",
    ...child.scope.map((s) => `- ${s}`),
    "\n## Acceptance criteria",
    ...child.acceptanceCriteria.map((c) => `- ${c}`),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * At the spec gate's approval (spec 24, criterion 1): creates the approved spec's children in the
 * approval's batch, each with `parent_work_item_id`, source `planning`, its slice as body and its
 * criteria, held in Ready; an `after` becomes a "waits for" link. Nothing when the spec splits
 * nothing, or when the parent already has children (a repeated approval creates none).
 */
export async function createSplitChildren(
  ctx: HandlerContext,
  workItemId: string,
): Promise<string[]> {
  const w = await ctx.db
    .selectFrom("core_work_items")
    .selectAll()
    .where("id", "=", workItemId)
    .executeTakeFirst();
  if (!w?.current_spec_id) return [];
  const spec = await ctx.db
    .selectFrom("core_specs")
    .select("children")
    .where("id", "=", w.current_spec_id)
    .executeTakeFirst();
  const children = childrenOf(spec?.children);
  if (!children.length) return [];
  if (w.parent_work_item_id) {
    throw new OperationError("conflict", "a child's plan can't split again (depth 1, ADR 0303)");
  }
  // By core_work_items_parent_idx (migration 0401): one row is enough to know.
  const existing = await ctx.db
    .selectFrom("core_work_items")
    .select("id")
    .where("parent_work_item_id", "=", w.id)
    .limit(1)
    .executeTakeFirst();
  if (existing) return [];
  const project = await ctx.db
    .selectFrom("core_projects")
    .selectAll()
    .where("id", "=", w.project_id)
    .executeTakeFirstOrThrow();
  const numbers = new Map(children.map((c, i) => [c.key, project.next_number + i]));
  const ids = new Map<string, string>();
  for (const [i, c] of children.entries()) {
    const created = createWorkItem(ctx, {
      project,
      repositoryId: w.repository_id,
      title: c.title,
      body: sliceBody(w, c, numbers),
      source: "planning",
      requesterUserId: w.requester_user_id,
      parentWorkItemId: w.id,
      number: project.next_number + i,
      state: "ready",
      priority: w.priority,
      acceptanceCriteria: c.acceptanceCriteria,
    });
    ids.set(c.key, created.id);
  }
  for (const c of children) {
    const from = ids.get(c.key);
    const to = c.after ? ids.get(c.after) : undefined;
    if (!from || !to) continue;
    ctx.write(
      ctx.db.insertInto("core_work_item_links").values({
        work_item_id: from,
        waits_for_id: to,
        created_at: ctx.now,
        created_by: ctx.actor.id,
      }),
    );
  }
  ctx.change({
    entity: "work_item",
    id: w.id,
    after: { split: children.map((c) => ({ key: c.key, number: numbers.get(c.key) })) },
  });
  return [...ids.values()];
}

/**
 * The parent's spec-only PR merged (the Workflow, spec 24): its children leave Ready for the queue
 * together, and the pull starts them as slots allow ("waits for" holds a dependent one). A person
 * approved them with the parent's spec, so this release needs no other decision.
 */
export async function releaseSplitChildren(ctx: HandlerContext, parent: WorkItemRow) {
  const held = await ctx.db
    .selectFrom("core_work_items")
    .select(["id", "status"])
    .where("parent_work_item_id", "=", parent.id)
    .where("status", "=", "ready")
    .limit(SPLIT_MAX)
    .execute();
  if (!held.length) return 0;
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({
        status: "queued",
        released_at: ctx.now,
        released_by: ctx.actor.id,
        updated_at: ctx.now,
      })
      .where("parent_work_item_id", "=", parent.id)
      .where("status", "=", "ready"),
  );
  for (const h of held) {
    ctx.change({
      entity: "work_item",
      id: h.id,
      before: { status: "ready" },
      after: { status: "queued", released: "the parent's plan merged" },
    });
  }
  requestPull(ctx, parent.project_id);
  return held.length;
}

/**
 * A child ended (finished or cancelled; spec 24): siblings that wait for a cancelled one park with
 * a question to the owner rather than waiting forever, and when this was the last child still
 * open, the parent's Workflow is told (done if any child merged, cancelled if none). Reads by
 * core_work_items_parent_idx and the links' primary key, bounded by SPLIT_MAX.
 */
export async function childEnded(
  ctx: HandlerContext,
  child: Pick<WorkItemRow, "id" | "number" | "parent_work_item_id">,
  outcome: string,
): Promise<void> {
  // A parent that ends without merging its plan leaves no children held for it (spec 24): those
  // still in Ready, never started, are cancelled with it. Bounded by the split.
  if (outcome !== "done") {
    ctx.write(
      ctx.db
        .updateTable("core_work_items")
        .set({
          status: "cancelled",
          status_reason: `its parent #${child.number} ended (${outcome}) before its plan merged`,
          closed_at: ctx.now,
          updated_at: ctx.now,
        })
        .where("parent_work_item_id", "=", child.id)
        .where("status", "=", "ready"),
    );
  }
  if (!child.parent_work_item_id) return;
  const siblings = await ctx.db
    .selectFrom("core_work_items")
    .selectAll()
    .where("parent_work_item_id", "=", child.parent_work_item_id)
    .limit(SPLIT_MAX + 1)
    .execute();
  const statusOf = (s: (typeof siblings)[number]) => (s.id === child.id ? outcome : s.status);
  if (outcome !== "done") {
    const waiting = siblings.length
      ? await ctx.db
          .selectFrom("core_work_item_links")
          .select("work_item_id")
          .where("waits_for_id", "=", child.id)
          .where(
            "work_item_id",
            "in",
            siblings.map((s) => s.id),
          )
          .execute()
      : [];
    for (const l of waiting) {
      const s = siblings.find((x) => x.id === l.work_item_id);
      if (!s || !["backlog", "ready", "queued"].includes(s.status) || s.needs_info) continue;
      park(ctx, s, {
        heading: s.status === "queued" ? "queued" : "ready",
        source: "split",
        reason: `#${child.number}, which it waits for, ended without merging (${outcome})`,
        missing: ["dependency"],
        prompts: [
          {
            prompt: `#${s.number} waits for #${child.number}, which was ${outcome}. Start #${s.number} without it, or cancel #${s.number}?`,
            options: [`Start #${s.number} without #${child.number}`, `Cancel #${s.number}`],
            context: `#${s.number} was split off with #${child.number} and planned to build on it.`,
          },
        ],
      });
    }
  }
  const open = siblings.filter((s) => !(ENDED as readonly string[]).includes(statusOf(s)));
  if (open.length) return;
  const parent = await ctx.db
    .selectFrom("core_work_items")
    .select(["id", "workflow_id", "status"])
    .where("id", "=", child.parent_work_item_id)
    .executeTakeFirst();
  if (!parent?.workflow_id || (ENDED as readonly string[]).includes(parent.status)) return;
  const done = siblings.filter((s) => statusOf(s) === "done").length;
  ctx.emit({
    kind: "workflow.event",
    payload: {
      instanceId: parent.workflow_id,
      type: splitSettledEvent(parent.id),
      payload: { done, cancelled: siblings.length - done },
    },
  });
}

/**
 * The files a split parent's PR may change (spec 24, the coordinator's decision): the spec, the
 * plan's copy and the `.kim/` files a person approved, and nothing else. Null: not a split parent.
 */
export async function splitFiles(
  ctx: Pick<HandlerContext, "db">,
  w: Pick<WorkItemRow, "id">,
): Promise<string[] | null> {
  const spec = await ctx.db
    .selectFrom("core_specs")
    .select(["children", "path", "kim_files"])
    .where("work_item_id", "=", w.id)
    .where("status", "=", "approved")
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!spec || !childrenOf(spec.children).length) return null;
  const kim = parseJson<{ path?: unknown }[]>(spec.kim_files ?? "[]", []);
  const plan = spec.path ? [spec.path, spec.path.replace(/^docs\/specs\//, ".kim/plans/")] : [];
  return [
    ...plan,
    ...kim.flatMap((k) => (typeof k.path === "string" ? [k.path] : [])),
  ];
}
