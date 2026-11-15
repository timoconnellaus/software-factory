// An org's plugins (spec 70 milestone 2): one ES module each, saved by name. What the module
// declares (its fields and the hooks it defines) is read by packages/plugins when it is saved and
// kept beside the code, so reads never load a worker. A save is live at once.
import { flowDb, iso, newId, StoreError } from "./db.ts";
import type { FlowPluginsTable } from "./schema.ts";

/** A field a plugin adds to the org's items. */
export interface PluginField {
  id: string;
  label: string;
  type: "text" | "number" | "date";
}

export interface Plugin {
  id: string;
  orgId: string;
  name: string;
  /** The person's plain words it was built from. */
  request: string;
  code: string;
  fields: PluginField[];
  /** The hooks its module defines: entered, leaving, runEnded, trigger. */
  hooks: string[];
  enabled: boolean;
  /** The last failure, cleared when it is saved again. */
  lastError: string | null;
  /** The key its trigger URL carries. */
  triggerKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function parseArray<T>(text: string): T[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function toPlugin(row: FlowPluginsTable): Plugin {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    request: row.request,
    code: row.code,
    fields: parseArray<PluginField>(row.fields),
    hooks: parseArray<string>(row.hooks),
    enabled: row.enabled === 1,
    lastError: row.last_error,
    triggerKey: row.trigger_key,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates the org's plugin `name`, or replaces its request, code and what it declares. A replace
 * keeps its id, trigger key, enabled flag and creator, and clears its last error.
 */
export async function savePlugin(
  d1: D1Database,
  input: {
    orgId: string;
    name: string;
    request: string;
    code: string;
    fields: PluginField[];
    hooks: string[];
    createdBy: string;
  },
): Promise<Plugin> {
  const now = iso();
  const row = await flowDb(d1)
    .insertInto("flow_plugins")
    .values({
      id: newId("fplg_"),
      org_id: input.orgId,
      name: input.name,
      request: input.request,
      code: input.code,
      fields: JSON.stringify(input.fields),
      hooks: JSON.stringify(input.hooks),
      enabled: 1,
      last_error: null,
      trigger_key: randomKey(),
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["org_id", "name"]).doUpdateSet((eb) => ({
        request: eb.ref("excluded.request"),
        code: eb.ref("excluded.code"),
        fields: eb.ref("excluded.fields"),
        hooks: eb.ref("excluded.hooks"),
        last_error: null,
        updated_at: eb.ref("excluded.updated_at"),
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return toPlugin(row);
}

export async function getPlugin(
  d1: D1Database,
  orgId: string,
  name: string,
): Promise<Plugin | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_plugins")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? toPlugin(row) : null;
}

export async function getPluginById(d1: D1Database, id: string): Promise<Plugin | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_plugins")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toPlugin(row) : null;
}

/** The org's plugins by name, enabled or not. A handful per org: no cap. */
export async function listPlugins(d1: D1Database, orgId: string): Promise<Plugin[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_plugins")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("name")
    .execute();
  return rows.map(toPlugin);
}

/** The org's enabled plugins by name: what a dispatch runs. */
export async function enabledPlugins(d1: D1Database, orgId: string): Promise<Plugin[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_plugins")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("enabled", "=", 1)
    .orderBy("name")
    .execute();
  return rows.map(toPlugin);
}

/**
 * The fields the org's enabled plugins declare, in plugin-name order; the first plugin to declare
 * an id wins. Read from what each module declared when saved: no worker is loaded.
 */
export async function declaredFields(d1: D1Database, orgId: string): Promise<PluginField[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_plugins")
    .select("fields")
    .where("org_id", "=", orgId)
    .where("enabled", "=", 1)
    .orderBy("name")
    .execute();
  const seen = new Set<string>();
  const out: PluginField[] = [];
  for (const row of rows) {
    for (const field of parseArray<PluginField>(row.fields)) {
      if (seen.has(field.id)) continue;
      seen.add(field.id);
      out.push(field);
    }
  }
  return out;
}

export async function deletePlugin(d1: D1Database, orgId: string, name: string): Promise<void> {
  const result = await flowDb(d1)
    .deleteFrom("flow_plugins")
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .executeTakeFirst();
  if (!result.numDeletedRows) throw new StoreError("not_found", `No plugin "${name}".`);
}

export async function setPluginEnabled(
  d1: D1Database,
  orgId: string,
  name: string,
  enabled: boolean,
): Promise<Plugin> {
  const row = await flowDb(d1)
    .updateTable("flow_plugins")
    .set({ enabled: enabled ? 1 : 0, updated_at: iso() })
    .where("org_id", "=", orgId)
    .where("name", "=", name)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", `No plugin "${name}".`);
  return toPlugin(row);
}

/** Records why the plugin last failed. Leaves `updated_at` alone: the code didn't change. */
export async function setPluginLastError(d1: D1Database, id: string, error: string): Promise<void> {
  await flowDb(d1)
    .updateTable("flow_plugins")
    .set({ last_error: error })
    .where("id", "=", id)
    .execute();
}
