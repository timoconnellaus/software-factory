import { type Workflow, workflowSchema } from "./model.ts";

export interface WorkflowProblem {
  statusId: string | null;
  message: string;
}

/**
 * Parses a workflow and checks what the schema can't: status ids are unique, and every
 * "when done" and "if rejected" names a status in this workflow.
 */
export function checkWorkflow(
  input: unknown,
): { ok: true; workflow: Workflow } | { ok: false; problems: WorkflowProblem[] } {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => ({
        statusId: null,
        message: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const workflow = parsed.data;
  const problems: WorkflowProblem[] = [];
  const ids = new Set<string>();
  for (const s of workflow.statuses) {
    if (ids.has(s.id))
      problems.push({ statusId: s.id, message: `Two statuses have the id "${s.id}".` });
    ids.add(s.id);
  }
  for (const s of workflow.statuses) {
    for (const [field, label] of [
      ["onDone", "When done, move to"],
      ["onReject", "If rejected, send back to"],
    ] as const) {
      const target = s[field];
      if (target === undefined) continue;
      if (!ids.has(target)) {
        problems.push({
          statusId: s.id,
          message: `"${label}" on ${s.name} names "${target}", which isn't a status in this workflow.`,
        });
      } else if (target === s.id) {
        problems.push({
          statusId: s.id,
          message: `"${label}" on ${s.name} points at ${s.name} itself.`,
        });
      }
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, workflow };
}
