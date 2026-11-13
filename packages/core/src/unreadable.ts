// An item whose pinned workflow can't be read (spec 52 Q3, reviews of #185): nothing may do its
// work or pass its checks. `invoke()` stops calls scoped to the item; an operation that finds its
// item inside its handler (by repository, PR or head) asks here before acting for it.
import type { HandlerContext } from "./operation.ts";
import { resolveScope } from "./scope.ts";

/** Who asks the owner about it: the question is found again by this asker, not by its wording. */
export const UNREADABLE_ASKER = "workflow-unreadable";

/** The question's opening words, and the failing check's title. */
export const UNREADABLE_WORKFLOW_PROMPT = "This item's workflow version can't be read";

/** Why the item's pinned workflow can't be read, or null when it can (or there is no item). */
export async function workflowUnreadable(
  ctx: Pick<HandlerContext, "db" | "scope">,
  workItemId: string | null | undefined,
): Promise<string | null> {
  if (!workItemId) return null;
  if (ctx.scope.workItemId === workItemId) return ctx.scope.pinnedError ?? null;
  // An error resolving it is "can't be read" too (fifth review of #185): fail closed.
  try {
    const scope = await resolveScope(ctx.db, { workItemId });
    return scope.pinnedError ?? null;
  } catch (error) {
    return `the item's scope can't be resolved (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** A plain sentence for a person, from the resolver's reason (which may be a raw parse error). */
export function unreadablePlain(why: string): string {
  if (/adopted/.test(why))
    return "a later org workflow version whose tightenings it took no longer reads";
  if (/started under/.test(why)) return "the project config it started under no longer reads";
  return "the org workflow version it runs on no longer reads";
}
