// An item whose pinned workflow can't be read (spec 52 Q3, reviews of #185): nothing may do its
// work or pass its checks. `invoke()` stops calls scoped to the item; an operation that finds its
// item inside its handler (by repository, PR or head) asks here before acting for it.
import { OperationError } from "./errors.ts";
import type { HandlerContext } from "./operation.ts";
import { resolveScope } from "./scope.ts";
import { runEvent } from "./workflow-events.ts";

/** Who asks the owner about it: the question is found again by this asker, not by its wording. */
export const UNREADABLE_ASKER = "workflow-unreadable";

/** The question's opening words, and the failing check's title. */
export const UNREADABLE_WORKFLOW_PROMPT = "This item's workflow version can't be read";

/**
 * Why the item's pinned workflow can't be read, or null when it can (or there is no item). Only a
 * definite result counts (a row that was read and doesn't parse): an error reading it throws a
 * retryable `unavailable`, so the caller refuses this call and nothing is cancelled, posted or
 * asked on a transient failure (sixth review of #185).
 */
export async function workflowUnreadable(
  ctx: Pick<HandlerContext, "db" | "scope">,
  workItemId: string | null | undefined,
): Promise<string | null> {
  if (!workItemId) return null;
  if (ctx.scope.workItemId === workItemId) return ctx.scope.pinnedError ?? null;
  try {
    const scope = await resolveScope(ctx.db, { workItemId });
    return scope.pinnedError ?? null;
  } catch (error) {
    throw new OperationError(
      "unavailable",
      `the item's workflow couldn't be read just now; try again (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Why an item's jobs are cancelled when its workflow can't be read. */
export const UNREADABLE_CANCEL = "the item's workflow version can't be read";

/**
 * Cancels an unreadable item's queued jobs, and wakes its Workflow for each (the job's run event,
 * `cancelled`): the Workflow's retry is refused (`workflow_unreadable`), which asks the owner, and
 * a v17 Workflow parks on that question; an older one ends. The one way such a job is cancelled
 * (`job.claim`, `workItem.markUnreadable`), so a Workflow never waits on a job that will never run.
 */
export function cancelUnreadableJobs(
  ctx: Pick<HandlerContext, "db" | "write" | "emit" | "changed">,
  item: { workflow_id: string },
  jobIds: readonly string[],
) {
  for (const id of jobIds) {
    ctx.changed();
    ctx.write(
      ctx.db
        .updateTable("core_jobs")
        .set({ status: "cancelled", wait_reason: UNREADABLE_CANCEL })
        .where("id", "=", id)
        .where("status", "=", "queued"),
    );
    ctx.emit({
      kind: "workflow.event",
      payload: {
        instanceId: item.workflow_id,
        type: runEvent(id),
        payload: { runId: "", outcome: "cancelled", reason: UNREADABLE_CANCEL },
      },
    });
  }
}

/** A plain sentence for a person, from the resolver's reason (which may be a raw parse error). */
export function unreadablePlain(why: string): string {
  if (/adopted/.test(why))
    return "a later org workflow version whose tightenings it took no longer reads";
  if (/started under/.test(why)) return "the project config it started under no longer reads";
  return "the org workflow version it runs on no longer reads";
}
