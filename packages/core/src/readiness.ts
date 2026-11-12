// The readiness pre-check and parking (spec 23, ADR 0304 as amended 2026-11-12). Deterministic, no
// model: before an item is marked ready, released or sent to shaping, its request should state an
// outcome and at least one thing someone could check, or have a parent item. A person doing so is
// their judgement that it's clear enough: they get the result as a hint they may ignore, and triage
// asks what's needed. An item no person released (intake, an autopilot, an agent) that fails is
// parked: it stays in the Backlog (no Workflow, no slot) with a "needs info" marker saying who it
// waits on, why, and the open questions, which are asked of that person (their Inbox). Answering
// them, or editing the request, re-runs the check; when it passes the item goes on to where it was
// heading, so nobody releases it twice. Triage's `not_actionable` parks the same way.
import { parseJson } from "@software-factory/db";
import { OperationError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { HandlerContext } from "./operation.ts";

/** Where a parked item goes when it's ready: back to Ready, released (Queued), or to shaping. */
export type Heading = "ready" | "queued" | "shaping";

/** What's missing from a request. */
export type Missing = "outcome" | "check";

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

/** Words that make a sentence something someone can check. */
const CHECKABLE =
  /\b(should|must|shall|when|then|given|expect(?:s|ed)?|returns?|shows?|fails?|errors?|appears?|can(?:not|'t)?|won't|will|never|always|within|at most|at least|so that|instead of|only)\b/i;

/** A request's sentences and list items, without Markdown marks. */
function statements(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(/^\s*([-*+]|\d+[.)]|#+)\s*/, "")
        .replace(/[`*_>]/g, "")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * The pre-check. A stated outcome: the request's body (not just its title) has a statement of at
 * least five words. A checkable statement: a statement in the title or body with a word that makes it
 * testable ("should", "when", "returns", "must", …) and at least four words. A parent item stands in
 * for both (a split of approved work). Answers to its needs-info questions count as part of the body.
 */
export function precheck(item: {
  title: string;
  body: string;
  parentId: string | null;
  answers?: string[];
}): { ok: true } | { ok: false; missing: Missing[] } {
  if (item.parentId) return { ok: true };
  const body = [item.body, ...(item.answers ?? [])].join("\n");
  const said = statements(body);
  const missing: Missing[] = [];
  if (!said.some((s) => words(s) >= 5)) missing.push("outcome");
  if (![item.title, ...said].some((s) => words(s) >= 4 && CHECKABLE.test(s))) missing.push("check");
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** The fixed prompt to the requester: what's missing, and an example. */
export function precheckPrompt(missing: Missing[]): string {
  const asks = [
    missing.includes("outcome") && "what should be true when this is done",
    missing.includes("check") && "one thing someone could check to know it works",
  ].filter(Boolean);
  return `Before anyone works on this, say ${asks.join(", and ")}. For example: "When a labelled issue is opened, an item appears in the project's backlog within a minute."`;
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
    prompts: string[];
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
  args.prompts.forEach((prompt, i) => {
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
        prompt,
        context: `#${w.number} ${w.title} waits for this before anyone works on it.`,
        options: "[]",
        kind: "text",
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
export function parkIfNotReady(
  ctx: HandlerContext,
  w: Parkable & { body: string; parent_work_item_id: string | null; kind?: string },
  heading: Heading,
): NeedsInfo | null {
  // A person's release is their judgement (ADR 0304 as amended): only what no person released parks.
  if (ctx.actor.type === "human") return null;
  // An incident or an attached PR has its own path (spec 07, ADR 0080): the check is for requests.
  if (w.kind && w.kind !== "change") return null;
  const checked = precheck({ title: w.title, body: w.body, parentId: w.parent_work_item_id });
  if (checked.ok) return null;
  return park(ctx, w, {
    heading,
    source: "precheck",
    reason:
      checked.missing.length === 2
        ? "the request doesn't say what it should achieve or how to check it"
        : checked.missing[0] === "outcome"
          ? "the request doesn't say what it should achieve"
          : "the request doesn't say how to check it's done",
    missing: checked.missing,
    prompts: [precheckPrompt(checked.missing)],
  });
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
  const what = checked.missing
    .map((m) => (m === "outcome" ? "no stated outcome" : "no checkable statement"))
    .join(", ");
  return `This may be too thin to build without questions: ${what}. Triage will ask what it needs.`;
}
