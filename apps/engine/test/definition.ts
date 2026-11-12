// Spec 52 PR (a): a real engine run compared with the compiled definition. Each assertion reads what
// today's Workflow wrote (`core_stages`, `core_work_items`, `core_jobs`, `core_pending_actions`) and
// what the definition says from the registry; nothing is restated by hand.
import { parseProjectPolicy } from "@software-factory/core";
import {
  compileItemWorkflow,
  engineStages,
  planFromDefinition,
  type Size,
  stageType,
  type WorkflowDefinition,
} from "@software-factory/core/stages";
import { expect } from "vitest";
import { all, first } from "./helpers.ts";

export function definitionFor(
  policyJson: unknown,
  kind: "change" | "incident" | "attached",
): { def: WorkflowDefinition; policy: ReturnType<typeof parsed> } {
  const policy = parsed(policyJson);
  return { def: compileItemWorkflow(policy, policy.workflow, kind), policy };
}

function parsed(policyJson: unknown) {
  const p = parseProjectPolicy(JSON.stringify(policyJson));
  if (!p.ok) throw new Error(p.error);
  return p.policy;
}

type Row = { stage: string; status: string; started_at: string };
const ENGINE = ["triage", "spec", "build", "verify", "merge"];

/**
 * The stages the engine passed and skipped are the ones the definition runs and skips: the full
 * sequence, or, for a run a test stops early, the sequence up to and including `until` (the stage
 * the test expects it to have reached last), never just any prefix.
 */
export async function expectStagesAsDefined(
  workItemId: string,
  def: WorkflowDefinition,
  size: Size,
  options: { requested?: "skip" | "require"; until?: string } = {},
) {
  const rows = await stageRows(workItemId);
  const seen = new Map<string, boolean>();
  for (const r of rows) if (!seen.has(r.stage)) seen.set(r.stage, r.status !== "skipped");
  const ran = [...seen].filter(([stage]) => ENGINE.includes(stage));
  const want = engineStages(def, size, options.requested).map((x) => [x.stage, x.runs]);
  if (options.until === undefined) {
    expect(ran).toEqual(want);
    return;
  }
  const end = want.findIndex(([stage]) => stage === options.until);
  if (end < 0) throw new Error(`the definition has no stage ${options.until}`);
  expect(ran).toEqual(want.slice(0, end + 1));
}

/**
 * The phases as the engine ran them: a stage that started before the item was released shaped,
 * anything after delivered. The definition's shaping stages are exactly the ones that ran before
 * release, for an item that was shaped; an item opened released (an incident, an attached PR) shaped
 * nothing and never started shaping.
 */
export async function expectPhasesAsDefined(
  workItemId: string,
  def: WorkflowDefinition,
  size: Size,
) {
  const item = await first<{ released_at: string | null; shaping_started_at: string | null }>(
    "SELECT released_at, shaping_started_at FROM core_work_items WHERE id = ?",
    workItemId,
  );
  if (!item?.released_at) throw new Error("the item was never released");
  const released = item.released_at;
  const rows = (await stageRows(workItemId)).filter(
    (r) => ENGINE.includes(r.stage) && r.status !== "skipped",
  );
  const before = [...new Set(rows.filter((r) => r.started_at < released).map((r) => r.stage))];
  const shaping = engineStages(def, size)
    .filter((s) => s.runs && s.phase === "shaping")
    .map((s) => s.stage);
  if (item.shaping_started_at === null) {
    expect(before, "an item opened released shapes nothing").toEqual([]);
    expect(shaping, "so its definition has no shaping stage").toEqual([]);
  } else {
    expect(before).toEqual(shaping);
  }
}

/**
 * Every send-back the engine made (a failed verify, an agent check's or a person's send-back) went
 * to the stage the definition says builds the head: the nearest earlier stage whose type produces a
 * `git-head`, read from the registry.
 */
export async function expectSendBacksAsDefined(workItemId: string, def: WorkflowDefinition) {
  const rows = (await stageRows(workItemId)).filter((r) => ENGINE.includes(r.stage));
  let sendBacks = 0;
  rows.forEach((r, i) => {
    if (r.status !== "sent_back" && r.status !== "failed") return;
    const next = rows[i + 1];
    if (!next) return;
    sendBacks++;
    expect(next.stage, `after ${r.stage} ${r.status}`).toBe(builderBefore(def, r.stage));
  });
  return sendBacks;
}

/**
 * The stage that rebuilds the head for `stageId`: itself when it builds the head (a retry, or a slot
 * step inside it sending a note back), else the nearest earlier builder.
 */
function builderBefore(def: WorkflowDefinition, stageId: string): string | null {
  const at = def.stages.findIndex((s) => s.id === stageId);
  for (let i = at; i >= 0; i--) {
    const s = def.stages[i];
    if (s && stageType(s.type)?.produces.includes("git-head")) return s.id;
  }
  return null;
}

/**
 * The slot steps the engine ran (an agent check's job, a decision's `workflow.gate`), in order, are
 * the definition's slot stages that hold for the item, in order.
 */
export async function expectSlotStepsAsDefined(
  workItemId: string,
  def: WorkflowDefinition,
  policy: { agents: Parameters<typeof planFromDefinition>[1]; workflow: string | null },
  size: Size,
  domains: readonly string[],
) {
  const jobs = await all<{ step: string; at: string }>(
    "SELECT json_extract(context, '$.step.id') AS step, created_at AS at FROM core_jobs WHERE work_item_id = ? AND json_extract(context, '$.step.id') IS NOT NULL ORDER BY created_at, rowid",
    workItemId,
  );
  const gates = await all<{ step: string; at: string }>(
    "SELECT json_extract(input, '$.stepId') AS step, created_at AS at FROM core_pending_actions WHERE work_item_id = ? AND operation = 'workflow.gate' ORDER BY created_at, rowid",
    workItemId,
  );
  // First runs only: a step that runs again after a send-back is the same step.
  const ran = [
    ...new Set([...jobs, ...gates].sort((a, b) => (a.at < b.at ? -1 : 1)).map((x) => x.step)),
  ];
  const plan = planFromDefinition(def, policy.agents, size, domains, policy.workflow);
  const want = [...plan.slots.afterSpec, ...plan.slots.beforeVerify, ...plan.slots.afterVerify]
    .filter((s) => !s.skip)
    .map((s) => s.id);
  expect(ran).toEqual(want);
  return ran.length;
}

function stageRows(workItemId: string) {
  return all<Row>(
    "SELECT stage, status, started_at FROM core_stages WHERE work_item_id = ? ORDER BY started_at, rowid",
    workItemId,
  );
}
