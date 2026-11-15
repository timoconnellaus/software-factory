// What a chat's model did (migration 0433): when it changes something through the engine's MCP
// server during a chat's run, and the call succeeded, a `did` message is added to that chat: a short
// plain sentence built from the operation, and `data` naming the kind and id of what changed (and,
// for an item or project it created, `created`, so the chat's `made` lists it). Reads write
// nothing, nor do the chat operations themselves.
import type { CallResult } from "@software-factory/ops";
import { addDid, type DidData, getPlugin, type Run } from "@software-factory/store";

export interface Did {
  text: string;
  data: DidData;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

/** The sentence and data for a successful call of `op`, or null when it changed nothing worth one. */
export function didFor(op: string, input: Rec, result: unknown): Did | null {
  const r = rec(result);
  const named = (kind: string, id: unknown, name: unknown) => ({
    kind,
    id: str(id),
    name: str(name),
  });
  const say = (text: string, data: DidData): Did | null => (data.id ? { text, data } : null);
  switch (op) {
    case "flow.workflow.create":
    case "flow.workflow.update": {
      const w = rec(r.workflow);
      const statuses = Array.isArray(w.statuses) ? w.statuses.length : 0;
      const verb = op.endsWith("create") ? "Created" : "Changed";
      const data = named("workflow", r.id, w.name);
      return say(`${verb} the workflow ${data.name} (${statuses} statuses)`, data);
    }
    case "flow.project.create":
      return say(`Created the project ${str(r.name)}`, {
        ...named("project", r.id, r.name),
        created: true,
      });
    case "flow.project.setWorkflow":
      return say(
        `Put the project ${str(r.name)} on another workflow`,
        named("project", r.id, r.name),
      );
    case "flow.agent.create":
      return say(`Added the agent ${str(r.name)}`, named("agent", r.id, r.name));
    case "flow.agent.update":
      return say(`Changed the agent ${str(r.name)}`, named("agent", r.id, r.name));
    case "flow.item.create":
      return say(`Created the item ${str(r.title)}`, {
        ...named("item", r.id, r.title),
        created: true,
        projectId: str(r.projectId),
        ...(typeof r.number === "number" ? { number: r.number } : {}),
      });
    case "flow.item.move":
    case "flow.item.finish":
    case "flow.item.decide":
    case "flow.item.retry": {
      const verb = {
        "flow.item.move": "Moved",
        "flow.item.finish": "Finished",
        "flow.item.decide": "Decided on",
        "flow.item.retry": "Retried",
      }[op];
      return say(`${verb} the item ${str(r.title)}`, named("item", r.id, r.title));
    }
    case "flow.item.comment":
      return say("Commented on an item", { kind: "item", id: str(input.itemId) });
    case "flow.item.setField":
      return say(`Set a field on the item ${str(r.title)}`, named("item", r.id, r.title));
    case "flow.plugin.save": {
      const fresh = str(r.createdAt) !== "" && r.createdAt === r.updatedAt;
      const data = named("plugin", r.id, r.name);
      return say(`${fresh ? "Built" : "Changed"} the plugin ${data.name}`, data);
    }
    case "flow.plugin.setEnabled":
      return say(
        `Turned the plugin ${str(r.name)} ${r.enabled ? "on" : "off"}`,
        named("plugin", r.id, r.name),
      );
    case "flow.gateway.save":
      return say(`Set up the gateway ${str(r.name)}`, named("gateway", r.id, r.name));
    case "flow.gateway.delete":
      return say(`Removed the gateway ${str(input.name)}`, {
        kind: "gateway",
        id: str(input.name),
        name: str(input.name),
        deleted: true,
      });
    default:
      return null;
  }
}

/**
 * Before a call that deletes a plugin: its id and name, so the `did` row can name what went (the
 * delete answers only { ok }). Null when the run isn't a chat's, or there is no such plugin.
 */
export async function beforeDelete(
  d1: D1Database,
  run: Run,
  op: string,
  input: Rec,
): Promise<Did | null> {
  if (run.chatId === null || op !== "flow.plugin.delete") return null;
  const plugin = await getPlugin(d1, run.orgId, str(input.name));
  if (!plugin) return null;
  return {
    text: `Deleted the plugin ${plugin.name}`,
    data: { kind: "plugin", id: plugin.id, name: plugin.name, deleted: true },
  };
}

/**
 * Adds the `did` row for a call the model of a chat's run made, if it succeeded and changed
 * something. A failure to write it is logged, never the tool call's failure.
 */
export async function recordDid(
  d1: D1Database,
  run: Run,
  op: string,
  input: Rec,
  out: CallResult,
  deleted: Did | null = null,
): Promise<void> {
  if (run.chatId === null || !out.ok) return;
  const did = deleted ?? didFor(op, input, out.result);
  if (!did) return;
  try {
    await addDid(d1, { chatId: run.chatId, orgId: run.orgId, runId: run.id, ...did });
  } catch (error) {
    console.error(`recording what ${op} did in chat ${run.chatId} failed`, error);
  }
}
