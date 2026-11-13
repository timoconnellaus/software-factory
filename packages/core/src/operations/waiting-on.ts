// What an item in the pipeline is waiting on (the owner's "1 running" report, 2026-11-13): a list
// or board shows, for each running or waiting item, the one fact that says why nothing moves, read
// in the same query as the items (correlated subqueries on the items' own indexes, evaluated only
// for running and waiting rows), plus one read of the merge queues when an item is in merge. Never
// a guess: when the facts don't say, it is null.
//
// In order:
// - `person`: an open gate (a pending action) or an open blocking question on the item;
// - `agent`: a job for it is claimed by a runner (the runner is working on it);
// - `runner`: a job for it is queued, no runner has claimed it yet;
// - in merge, from its queue entry: `updating` (the head, GitHub merging the default branch in),
//   `ci` (the head, waiting on CI on its head before it merges), else `queue` with its position
//   (held: the default branch is red and it isn't a repair);
// - in verify: `ci` while this verify attempt's run has handed back and no review packet has been
//   recorded since the attempt began (the engine records the packet once CI has answered). Once
//   the packet exists the item may be on an afterVerify slot step: that shows as `agent`, `runner`
//   or `person` above, and otherwise as nothing.
import { type RawBuilder, sql } from "kysely";
import { z } from "zod";
import type { HandlerContext } from "../operation.ts";
import { headStep, queuedEntriesQuery } from "./merge-queue.ts";

export const waitingOn = z
  .object({
    kind: z.enum(["person", "agent", "runner", "queue", "updating", "ci"]),
    /** `person`: what asks, a gate or a question. */
    on: z.enum(["gate", "question"]).optional(),
    /** In merge: its place in its repository's merge queue (1 is the head, which lands next). */
    position: z.number().optional(),
    /** `queue`: the head is merging now. */
    merging: z.boolean().optional(),
    /** `queue`: held while the default branch is red (it isn't a repair). */
    held: z.boolean().optional(),
  })
  .nullable();
export type WaitingOn = z.infer<typeof waitingOn>;

/** The statuses an item is moving (or should be) in: the rest wait on nothing the factory does. */
const MOVING = sql`core_work_items.status IN ('running', 'waiting')`;

/**
 * The columns `waitingOnOf` reads, as subqueries correlated on `core_work_items`: select them in
 * the query that reads the items. Each uses the item's own index (core_pending_actions_item_idx,
 * core_questions_item_idx, core_jobs_item_idx, core_stages_item_idx, core_review_packets_item_idx).
 */
export function waitingOnColumns(): [
  RawBuilder<string | null>,
  RawBuilder<string | null>,
  RawBuilder<number | null>,
] {
  return [
    sql<string | null>`CASE WHEN ${MOVING} THEN CASE
      WHEN EXISTS (SELECT 1 FROM core_pending_actions pa WHERE pa.work_item_id = core_work_items.id AND pa.status = 'pending') THEN 'gate'
      WHEN EXISTS (SELECT 1 FROM core_questions qn WHERE qn.work_item_id = core_work_items.id AND qn.status = 'open' AND qn.blocking = 1) THEN 'question'
      END END`,
    // 'claimed' sorts before 'queued': a claimed job wins.
    sql<
      string | null
    >`CASE WHEN ${MOVING} THEN (SELECT MIN(j.status) FROM core_jobs j WHERE j.work_item_id = core_work_items.id AND j.status IN ('claimed', 'queued')) END`,
    // This verify attempt (its latest stage row) has a finished verify job and no packet yet.
    sql<number | null>`CASE WHEN ${MOVING} AND core_work_items.stage = 'verify' THEN (
      SELECT EXISTS (SELECT 1 FROM core_jobs vj WHERE vj.work_item_id = core_work_items.id AND vj.stage = 'verify' AND vj.status = 'done' AND vj.created_at >= a.at)
        AND NOT EXISTS (SELECT 1 FROM core_review_packets rp WHERE rp.work_item_id = core_work_items.id AND rp.created_at >= a.at)
      FROM (SELECT MAX(st.started_at) AS at FROM core_stages st WHERE st.work_item_id = core_work_items.id AND st.stage = 'verify') a
      WHERE a.at IS NOT NULL) END`,
  ];
}

/** The selections for a kysely `select`: `waitingOnColumns()` under their aliases. */
export function waitingOnSelections() {
  const [person, job, ci] = waitingOnColumns();
  return [person.as("wo_person"), job.as("wo_job"), ci.as("wo_ci")] as const;
}

export interface WaitingFacts {
  id: string;
  project_id: string;
  status: string;
  stage: string;
  wo_person: string | null;
  wo_job: string | null;
  wo_ci: number | null;
}

/** An item's place in its merge queue, and its head's step. */
export interface QueuePlace {
  position: number;
  step: "merging" | "updating" | "ci";
  held: boolean;
}

/**
 * The merge-queue places of the given items (those in merge), in one read of their projects' open
 * entries (core_merge_queue_project_idx): positions per repository, as delivery.status counts them.
 */
export async function queuePlaces(
  ctx: HandlerContext,
  items: readonly { id: string; project_id: string; stage: string; status: string }[],
): Promise<Map<string, QueuePlace>> {
  const inMerge = items.filter(
    (i) => i.stage === "merge" && (i.status === "running" || i.status === "waiting"),
  );
  if (inMerge.length === 0) return new Map();
  const projects = [...new Set(inMerge.map((i) => i.project_id))];
  return placesIn(await queuedEntriesQuery(ctx, projects).execute());
}

type QueueEntry = Parameters<typeof headStep>[0] & {
  project_id: string;
  work_item_id: string;
  repository_id: string | null;
  repairs_main: number;
  driver: string;
  stopped: number;
};

/** Each entry's place in its own repository's queue, from entries head first (queuedEntriesQuery). */
export function placesIn(entries: readonly QueueEntry[]): Map<string, QueuePlace> {
  const places = new Map<string, QueuePlace>();
  const seen = new Map<string, number>();
  for (const e of entries) {
    const queue = `${e.project_id}:${e.repository_id ?? ""}`;
    const position = (seen.get(queue) ?? 0) + 1;
    seen.set(queue, position);
    places.set(e.work_item_id, {
      position,
      step: headStep(e),
      held: e.stopped === 1 && e.repairs_main !== 1 && e.driver === "babysitter",
    });
  }
  return places;
}

/** What the item waits on, from its facts (pure). */
export function waitingOnOf(f: WaitingFacts, place: QueuePlace | undefined): WaitingOn {
  if (f.status !== "running" && f.status !== "waiting") return null;
  if (f.wo_person === "gate" || f.wo_person === "question")
    return { kind: "person", on: f.wo_person };
  if (f.wo_job === "claimed") return { kind: "agent" };
  if (f.wo_job === "queued") return { kind: "runner" };
  if (f.stage === "merge" && place) {
    if (place.held) return { kind: "queue", position: place.position, held: true };
    if (place.position === 1 && place.step === "updating") return { kind: "updating", position: 1 };
    if (place.position === 1 && place.step === "ci") return { kind: "ci", position: 1 };
    if (place.position === 1) return { kind: "queue", position: 1, merging: true };
    return { kind: "queue", position: place.position };
  }
  if (f.stage === "verify" && f.wo_ci === 1) return { kind: "ci" };
  return null;
}
