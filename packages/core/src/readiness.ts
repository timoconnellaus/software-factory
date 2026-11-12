// The readiness pre-check and parking (spec 23, ADR 0304 as amended 2026-11-12). The pre-check is a
// floor for emptiness, not a judgement of clarity: code can't tell whether a request is clear, and
// triage (an agent stage) asks what it needs. It parks only an item with nothing to act on (no body
// and a title of under four words, or a body that is only a template's headings or only a link) or
// an exact duplicate of an open item from the same source, and only when no person released it
// (intake, MCP, the foreman, autopilots, the improver). A person on the app, the desktop, the phone
// or the sf CLI is never parked; they get the result as a hint. A parked item stays in the Backlog
// (no Workflow, no slot) with a needs-info marker and a question to its requester; answering, or
// editing the request, re-runs the check and sends it on to where it was heading.
import { parseJson } from "@software-factory/db";
import { OperationError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { HandlerContext } from "./operation.ts";

/** Where a parked item goes when it's ready: back to Ready, released (Queued), or to shaping. */
export type Heading = "ready" | "queued" | "shaping";

/** Why the pre-check parks an item. */
export type Missing = "content" | "duplicate";

/** The marker on a parked item (`core_work_items.needs_info`). */
export interface NeedsInfo {
  /** Who it waits on: the requester. */
  waitingOn: string;
  /** Why, in a sentence. */
  reason: string;
  /** What parked it: the pre-check (deterministic) or triage (`not_actionable`). */
  source: "precheck" | "triage";
  missing: Missing[];
  /** The questions asked of `waitingOn`. */
  questionIds: string[];
  /** Where it goes once answered. */
  heading: Heading;
  at: string;
}

/** The surfaces whose calls are a person's own (spec 23): MCP is an agent with a person's token. */
export const PERSON_SURFACES = ["app", "desktop", "mobile", "cli", "test"] as const;

/** Whether a person (not an agent, intake or automation) is the one making this call. */
export function byPerson(ctx: Pick<HandlerContext, "actor" | "origin">): boolean {
  return (
    ctx.actor.type === "human" &&
    (PERSON_SURFACES as readonly string[]).includes(ctx.origin.surface)
  );
}

/** What's left of a body without template headings, HTML comments, empty checkboxes and links. */
function substance(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n")
    .filter((l) => !/^\s*#{1,6}(\s|$)/.test(l))
    .map((l) => l.replace(/^\s*([-*+]|\d+[.)])\s*(\[[ xX]?\]\s*)?/, ""))
    .join(" ")
    .replace(/<?https?:\/\/\S+>?/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The pre-check (spec 23): only what code can know for certain. Nothing to act on is no body and a
 * title of fewer than four words, or a body that is nothing but a template's headings or a link.
 * A parent item stands in for a body (a split of approved work). Answers count as body.
 */
export function precheck(item: {
  title: string;
  body: string;
  parentId: string | null;
  answers?: string[];
}): { ok: true } | { ok: false; missing: Missing[] } {
  if (item.parentId) return { ok: true };
  const body = [item.body, ...(item.answers ?? [])].join("\n");
  const titleWords = item.title.trim().split(/\s+/).filter(Boolean).length;
  if (body.trim() === "")
    return titleWords < 4 ? { ok: false, missing: ["content"] } : { ok: true };
  return substance(body) ? { ok: true } : { ok: false, missing: ["content"] };
}

/** The fixed prompt to the requester. */
export function precheckPrompt(missing: Missing[], duplicateOf?: number): string {
  if (missing.includes("duplicate")) {
    return `This reads the same as #${duplicateOf ?? "?"}. Say what's different about it, or close it.`;
  }
  return 'There is nothing here to work on yet. Say what you want done, in a sentence or two. For example: "When a labelled issue is opened, an item appears in the project\'s backlog within a minute."';
}

type Parkable = {
  id: string;
  project_id: string;
  org_id: string;
  number: number;
  title: string;
  requester_user_id: string;
  planning_round?: number;
};

/**
 * Parks an item in the Backlog with a needs-info marker and asks its requester `prompts`. Writes in
 * the operation's batch; the caller decides whether to go on. Returns the marker.
 */
export function park(
  ctx: HandlerContext,
  w: Parkable,
  args: {
    heading: Heading;
    source: NeedsInfo["source"];
    reason: string;
    missing: Missing[];
    /** The questions: a prompt, or triage's draft (options and a default). */
    prompts: (
      | string
      | { prompt: string; options?: string[]; defaultAnswer?: string; context?: string }
    )[];
  },
): NeedsInfo {
  const hours = ctx.scope.policy?.timeouts.questionHours ?? 48;
  const timeoutAt = new Date(Date.parse(ctx.now) + hours * 3_600_000).toISOString();
  const questionIds = args.prompts.map(() => newId("question"));
  const marker: NeedsInfo = {
    waitingOn: w.requester_user_id,
    reason: args.reason,
    source: args.source,
    missing: args.missing,
    questionIds,
    heading: args.heading,
    at: ctx.now,
  };
  ctx.write(
    ctx.db
      .updateTable("core_work_items")
      .set({
        status: "backlog",
        status_reason: `needs info: ${args.reason}`,
        needs_info: JSON.stringify(marker),
        updated_at: ctx.now,
      })
      .where("id", "=", w.id),
  );
  // Numbers continue the item's own; a parked item has no planning session.
  args.prompts.forEach((asked, i) => {
    const q = typeof asked === "string" ? { prompt: asked } : asked;
    const options = q.options ?? [];
    ctx.write(
      ctx.db.insertInto("core_questions").values({
        id: questionIds[i] as string,
        work_item_id: w.id,
        project_id: w.project_id,
        org_id: w.org_id,
        assignee_user_id: w.requester_user_id,
        planning_round: w.planning_round ?? 0,
        timeout_at: timeoutAt,
        asked_by: ctx.actor.id,
        created_at: ctx.now,
        domain: "product",
        prompt: q.prompt,
        context: q.context ?? `#${w.number} ${w.title} waits for this before anyone works on it.`,
        options: JSON.stringify(options),
        kind: options.length ? "single-choice" : "text",
        default_answer: q.defaultAnswer ?? null,
        blocking: 1,
        irreversible: 0,
        position: i + 1,
      }),
    );
  });
  ctx.emit({
    kind: "notify",
    payload: {
      event: "workItem.needsInfo",
      userId: w.requester_user_id,
      workItemId: w.id,
      title: `Needs info: ${w.title}`,
      url: `/work/${w.id}`,
    },
  });
  ctx.change({ entity: "work_item", id: w.id, after: { needsInfo: marker } });
  return marker;
}

/** An item's marker, if it's parked. */
export const needsInfoOf = (raw: string | null | undefined): NeedsInfo | null =>
  raw ? parseJson<NeedsInfo | null>(raw, null) : null;

/**
 * Runs the pre-check for an item about to be marked ready, released or shaped. Passing: null, and
 * the caller goes on. Failing: the item is parked (in this batch) and the marker returned.
 */
export async function parkIfNotReady(
  ctx: HandlerContext,
  w: Parkable & {
    body: string;
    parent_work_item_id: string | null;
    kind?: string;
    source?: string;
  },
  heading: Heading,
): Promise<NeedsInfo | null> {
  // A person's release is their judgement (ADR 0304 as amended): only what no person released parks.
  if (byPerson(ctx)) return null;
  // An incident or an attached PR has its own path (spec 07, ADR 0080): the check is for requests.
  if (w.kind && w.kind !== "change") return null;
  const checked = precheck({ title: w.title, body: w.body, parentId: w.parent_work_item_id });
  if (!checked.ok) {
    return park(ctx, w, {
      heading,
      source: "precheck",
      reason: "there is nothing to act on yet",
      missing: checked.missing,
      prompts: [precheckPrompt(checked.missing)],
    });
  }
  // An exact duplicate of an open item from the same source (by core_work_items_project_title_idx,
  // migration 0371; one row at most).
  if (w.source) {
    const same = await ctx.db
      .selectFrom("core_work_items")
      .select(["number", "body"])
      .where("project_id", "=", w.project_id)
      .where("title", "=", w.title)
      .where("source", "=", w.source)
      .where("id", "!=", w.id)
      .where("status", "not in", ["done", "failed", "rejected", "cancelled"])
      .limit(5)
      .execute();
    const dup = same.find((d) => d.body.trim() === w.body.trim());
    if (dup) {
      return park(ctx, w, {
        heading,
        source: "precheck",
        reason: `it's the same as #${dup.number}`,
        missing: ["duplicate"],
        prompts: [precheckPrompt(["duplicate"], dup.number)],
      });
    }
  }
  return null;
}

/** Refuses moving a parked item on by hand: answer its questions or edit the request instead. */
export function refuseIfParked(w: { number: number; needs_info: string | null }, what: string) {
  const marker = needsInfoOf(w.needs_info);
  if (marker) {
    throw new OperationError(
      "conflict",
      `work item #${w.number} needs info (${marker.reason}): answer its questions or edit the request, and it ${what} by itself`,
    );
  }
}

/**
 * The pre-check's result as a hint for a person (ADR 0304 as amended): null when the request reads
 * clear, else a sentence they may ignore. Shown on the item and in the release response.
 */
export function readinessHint(w: {
  title: string;
  body: string;
  parent_work_item_id: string | null;
  kind?: string;
}): string | null {
  if (w.kind && w.kind !== "change") return null;
  const checked = precheck({ title: w.title, body: w.body, parentId: w.parent_work_item_id });
  if (checked.ok) return null;
  return "There's little here to work on: triage will ask what it needs, or add a sentence on what you want done.";
}

/**
 * The next Workflow generation's instance id (spec 23): a Workflow instance id can't be reused, so
 * an item triage parked starts its next run as `<id>-r2`, `<id>-r3`, …
 */
export function nextGeneration(workItemId: string, current: string | null): string {
  const n = current?.startsWith(`${workItemId}-r`)
    ? Number(current.slice(workItemId.length + 2))
    : 1;
  return `${workItemId}-r${(Number.isFinite(n) ? n : 1) + 1}`;
}
