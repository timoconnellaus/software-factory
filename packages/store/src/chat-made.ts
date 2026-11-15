// What a chat made (migration 0433, 0437): the `did` rows the MCP server writes during a chat's runs,
// folded into the items and projects the model created and the workflows, plugins, agents and
// gateways it created or changed. The app's side pane shows them.

/** Something a chat's model created or changed, by id and its latest name. */
export interface MadeThing {
  id: string;
  name: string;
  /** An item's project and number (the app shows `KEY-12`). */
  projectId?: string;
  number?: number;
}

/** What a chat made, by kind: the items and projects it created, and what else it changed. */
export interface Made {
  items: MadeThing[];
  projects: MadeThing[];
  workflows: MadeThing[];
  plugins: MadeThing[];
  agents: MadeThing[];
  gateways: MadeThing[];
}

/**
 * What a `did` row's data names. `deleted` marks one the model removed; `created` one it created
 * (items and projects count as made only then). An item's also carries its project and number.
 */
export interface DidData {
  kind: string;
  id: string;
  name?: string;
  deleted?: boolean;
  created?: boolean;
  projectId?: string;
  number?: number;
}

/** `made`'s groups by a `did` row's kind. Items and projects count only once created in the chat. */
const MADE_KINDS = {
  item: "items",
  project: "projects",
  workflow: "workflows",
  plugin: "plugins",
  agent: "agents",
  gateway: "gateways",
} as const satisfies Record<string, keyof Made>;
const CREATED_ONLY = new Set(["item", "project"]);

/** What the `did` rows say was made: each thing once, by its latest name, deletions removed. */
export function madeOf(dids: DidData[]): Made {
  const seen = new Map<keyof Made, Map<string, MadeThing>>(
    Object.values(MADE_KINDS).map((group) => [group, new Map()]),
  );
  for (const did of dids) {
    const group = MADE_KINDS[did.kind as keyof typeof MADE_KINDS];
    if (!group) continue;
    const things = seen.get(group) as Map<string, MadeThing>;
    const before = things.get(did.id);
    if (did.deleted) things.delete(did.id);
    else if (before || did.created || !CREATED_ONLY.has(did.kind)) {
      things.set(did.id, {
        ...before,
        id: did.id,
        name: did.name || before?.name || did.id,
        ...(did.projectId ? { projectId: did.projectId } : {}),
        ...(typeof did.number === "number" ? { number: did.number } : {}),
      });
    }
  }
  const list = (group: keyof Made) => [...(seen.get(group)?.values() ?? [])];
  return {
    items: list("items"),
    projects: list("projects"),
    workflows: list("workflows"),
    plugins: list("plugins"),
    agents: list("agents"),
    gateways: list("gateways"),
  };
}
