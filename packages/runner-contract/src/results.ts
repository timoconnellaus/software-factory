// What a `flow` run hands back in `Handback.result`: the harness writes it (as JSON) and the runner
// host passes it through untouched. The cloud parses it with `flowResultSchema`; a result that
// doesn't parse fails the run.
import { z } from "zod";

/**
 * Where the harness writes its result, relative to the workspace root. The runner host reads it
 * into `Handback.result`, then deletes it: it is never committed or pushed.
 */
export const RESULT_FILE = ".factory-result.json";

/**
 * `flow` (spec 70, ADR 0660): what an agent-owned status's run hands back. `done` moves the item
 * on; `rejected` says the agent couldn't or wouldn't do it. The summary is what a person reads.
 */
export const flowResultSchema = z.object({
  outcome: z.enum(["done", "rejected"]),
  summary: z.string(),
});

export type FlowResult = z.infer<typeof flowResultSchema>;
