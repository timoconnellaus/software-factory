// The dock badge's count and the notifications' lines (spec 70): what waits on the signed-in person
// across every org they are in, from the new core's `flow.inbox.all`: items in statuses they own
// (`work`) and items waiting on a decision (`decisions`). Pure, so the test pins it.
import type { FlowInboxAll } from "@software-factory/client/flow";

export interface Waiting {
  /** The item's id: a notification is said once per item. */
  id: string;
  /** "API-10 needs you: Add rate limiting to the public API". */
  line: string;
}

/** Everything waiting on you, once per item, decisions first. */
export function waitingOnYou(all: FlowInboxAll | null | undefined): Waiting[] {
  const out: Waiting[] = [];
  const seen = new Set<string>();
  for (const org of all?.orgs ?? []) {
    for (const [items, what] of [
      [org.decisions, "waits on a decision"],
      [org.work, "needs you"],
    ] as const) {
      for (const i of items ?? []) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        out.push({ id: i.id, line: `${i.projectKey}-${i.number} ${what}: ${i.title}` });
      }
    }
  }
  return out;
}
