// The new core's inbox, workflow editor, plugins and gateways (spec 70; .kim/mockups/inbox.html,
// workflow-editor.html, plugins.html, gateways.html) as the desktop app reads them: the operations'
// shapes, typed by hand (a view imports neither @software-factory/ops nor the store), and the pure
// logic the screens need: the inbox's rows, a status's id from its name, a workflow edited and sent
// whole, a server problem placed beside its status, and an item's plugin fields as chips.
import type { FlowInbox, FlowItem, FlowProject, FlowStatus, FlowWorkflow } from "./flow.ts";

/** A field a plugin adds to items: `item.fields[id]` holds its value. */
export interface FlowField {
  id: string;
  label: string;
  type: string;
}

export interface FlowMember {
  userId: string;
  name: string;
  login: string;
}

export interface FlowPlugin {
  id: string;
  name: string;
  /** What the person asked for, in their own words. */
  request: string;
  enabled: boolean;
  /** When it last failed, the error in plain words. */
  lastError: string | null;
  updatedAt: string;
}

export interface FlowPluginDetail extends FlowPlugin {
  code: string;
}

export interface FlowGatewayAuth {
  kind: "none" | "bearer" | "header";
  /** The header's name, for `header`. */
  header?: string;
}

export interface FlowGateway {
  id: string;
  name: string;
  baseUrl: string;
  auth: FlowGatewayAuth;
  /** A secret is saved. It is never sent back. */
  hasSecret: boolean;
}

/** A workflow refused: each problem names the status it is about, or none. */
export interface WorkflowProblem {
  statusId: string | null;
  message: string;
}

type Org = { orgId: string };
type Definition = { name: string; statuses: FlowStatus[] };

/** The operations these screens call, for packages/client's OpMap (through FlowOpMap). */
export interface FlowEditOpMap {
  "flow.workflow.create": { input: Org & Definition; output: FlowWorkflow };
  "flow.workflow.update": {
    input: Org & Definition & { workflowId: string };
    output: FlowWorkflow;
  };
  "flow.project.setWorkflow": {
    input: Org & { projectId: string; workflowId: string };
    output: FlowProject;
  };
  "flow.member.list": { input: Org; output: { members: FlowMember[] } };
  "flow.plugin.list": { input: Org; output: { plugins: FlowPlugin[] } };
  "flow.plugin.get": { input: Org & { pluginId: string }; output: { plugin: FlowPluginDetail } };
  "flow.plugin.setEnabled": {
    input: Org & { pluginId: string; enabled: boolean };
    output: unknown;
  };
  "flow.plugin.delete": { input: Org & { pluginId: string }; output: unknown };
  "flow.gateway.list": { input: Org; output: { gateways: FlowGateway[] } };
  "flow.gateway.save": {
    input: Org & { name: string; baseUrl: string; auth: FlowGatewayAuth; secret?: string };
    output: unknown;
  };
  "flow.gateway.delete": { input: Org & { gatewayId: string }; output: unknown };
}

// ---- The inbox ----------------------------------------------------------------------------------

export interface InboxRow {
  item: FlowItem;
  kind: "work" | "decision";
}

/** The inbox's rows: what waits on a decision and the work the person owns, newest first, once each. */
export function inboxRows(inbox: FlowInbox | undefined): InboxRow[] {
  if (!inbox) return [];
  const seen = new Set<string>();
  const rows: InboxRow[] = [];
  for (const [items, kind] of [
    [inbox.decisions, "decision"],
    [inbox.work, "work"],
  ] as const) {
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push({ item, kind });
    }
  }
  return rows.sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt));
}

/** The row's question in plain words: "Review: A lighthouse", "Decide: A lighthouse". */
export function inboxQuestion(row: InboxRow, statusName: string | undefined): string {
  if (row.kind === "decision") return `Decide: ${row.item.title}`;
  return `${statusName ?? "Yours"}: ${row.item.title}`;
}

/** The row to show after acting on one: the next, else the one before, else none. */
export function nextRow(rows: InboxRow[], itemId: string): string | null {
  const at = rows.findIndex((r) => r.item.id === itemId);
  if (at < 0) return rows[0]?.item.id ?? null;
  return rows[at + 1]?.item.id ?? rows[at - 1]?.item.id ?? null;
}

// ---- The workflow editor ------------------------------------------------------------------------

/** A status added in the editor has this id until it is saved. */
const NEW = "new:";
export const isNewStatus = (id: string) => id.startsWith(NEW);

let made = 0;
/** A status the editor adds: named, owned by nobody, with an id it replaces on save. */
export function newStatus(name = "New status"): FlowStatus {
  made += 1;
  return { id: `${NEW}${Date.now().toString(36)}${made}`, name, owner: { kind: "none" } };
}

/** "Ready for review" → "ready-for-review", not one of `taken`. */
export function statusIdFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "status";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The statuses as the server takes them: a new status gets an id from its name (a saved one keeps
 * its id, so items stay where they are), and every "when done" and "if rejected" follows. `ids`
 * maps each draft id to the id sent.
 */
export function statusesToSave(statuses: FlowStatus[]): {
  statuses: FlowStatus[];
  ids: Map<string, string>;
} {
  const taken = new Set(statuses.filter((s) => !isNewStatus(s.id)).map((s) => s.id));
  const ids = new Map<string, string>();
  for (const s of statuses) {
    if (!isNewStatus(s.id)) {
      ids.set(s.id, s.id);
      continue;
    }
    const id = statusIdFor(s.name, taken);
    taken.add(id);
    ids.set(s.id, id);
  }
  const to = (id: string | undefined) => (id === undefined ? undefined : (ids.get(id) ?? id));
  return {
    ids,
    statuses: statuses.map((s) => {
      const out: FlowStatus = { ...s, id: to(s.id) as string, name: s.name.trim() };
      const onDone = to(s.onDone);
      const onReject = to(s.onReject);
      if (onDone === undefined) delete out.onDone;
      else out.onDone = onDone;
      if (onReject === undefined) delete out.onReject;
      else out.onReject = onReject;
      if (out.owner.kind !== "agent") delete out.brief;
      return out;
    }),
  };
}

/** The status at `index` moved one place left (-1) or right (+1). */
export function moveStatus(statuses: FlowStatus[], index: number, by: -1 | 1): FlowStatus[] {
  const to = index + by;
  if (index < 0 || to < 0 || to >= statuses.length) return statuses;
  const next = [...statuses];
  const [moved] = next.splice(index, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** The status at `index` removed; any status that sent items to it goes back to the default. */
export function removeStatus(statuses: FlowStatus[], index: number): FlowStatus[] {
  const gone = statuses[index]?.id;
  if (gone === undefined || statuses.length <= 1) return statuses;
  return statuses
    .filter((_, i) => i !== index)
    .map((s) => {
      if (s.onDone !== gone && s.onReject !== gone) return s;
      const out = { ...s };
      if (out.onDone === gone) delete out.onDone;
      if (out.onReject === gone) delete out.onReject;
      return out;
    });
}

/** Where a status sends rejected items, when that isn't the status before it. */
export function sendsBackTo(statuses: FlowStatus[], index: number): FlowStatus | null {
  const s = statuses[index];
  if (!s?.onReject) return null;
  if (statuses[index - 1]?.id === s.onReject) return null;
  return statuses.find((t) => t.id === s.onReject) ?? null;
}

/**
 * The server's problems, by the draft status they name. A problem the kernel's schema found names
 * no status but its path does ("statuses.2.name: …"); a problem that names neither is the
 * workflow's own (key "").
 */
export function problemsByStatus(
  problems: WorkflowProblem[],
  sent: FlowStatus[],
  draft: FlowStatus[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (key: string, message: string) => out.set(key, [...(out.get(key) ?? []), message]);
  for (const p of problems) {
    let index = p.statusId ? sent.findIndex((s) => s.id === p.statusId) : -1;
    let message = p.message;
    const path = /^statuses\.(\d+)\.(\w+):\s*(.*)$/.exec(p.message);
    if (index < 0 && path) {
      index = Number(path[1]);
      message = `${path[2] === "name" ? "Name" : path[2]}: ${path[3]}`;
    }
    const id = draft[index]?.id;
    add(id ?? "", message);
  }
  return out;
}

/** The problems an `invalid_input` refusal carries, if it carries any. */
export function asProblems(details: unknown): WorkflowProblem[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((d) =>
    d && typeof d === "object" && typeof (d as { message?: unknown }).message === "string"
      ? [
          {
            statusId:
              typeof (d as { statusId?: unknown }).statusId === "string"
                ? (d as { statusId: string }).statusId
                : null,
            message: (d as { message: string }).message,
          },
        ]
      : [],
  );
}

// ---- Plugin fields ------------------------------------------------------------------------------

/** An item's plugin fields as chips: each with a value, labelled from the fields' definitions. */
export function fieldChips(
  item: Pick<FlowItem, "fields">,
  defs: FlowField[] | undefined,
): { id: string; label: string; value: string }[] {
  const values = item.fields;
  if (!values || typeof values !== "object") return [];
  const order = defs?.map((d) => d.id) ?? [];
  const keys = [...order.filter((k) => k in values), ...Object.keys(values)].filter(
    (k, i, all) => all.indexOf(k) === i,
  );
  return keys.flatMap((id) => {
    const value = shown(values[id]);
    if (value === null) return [];
    return [{ id, label: defs?.find((d) => d.id === id)?.label ?? labelFor(id), value }];
  });
}

/** A field the definitions don't name, labelled from its id: "due_date" → "Due date". */
function labelFor(id: string): string {
  const words = id
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]?.toUpperCase() + words.slice(1) : id;
}

function shown(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => shown(v) ?? "").join(", ") || null;
  return null;
}
