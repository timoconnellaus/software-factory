// The words for a policy decision made with a presence proof (ADR 0391, 0610): from the engine's
// own records, never the caller's. The Touch ID prompt and the audit journal show them, and the key
// helper signs only a summary of at most 300 characters with no control or format characters, so:
// - the facts come first and whole (what is decided, the versions, then what it loosens: the
//   unusual condition in the first words);
// - names (a workflow's, an agent's, a project's, the org's) come last, cleaned, in the room the
//   facts leave under MAX_SUMMARY, and never pose as a fact;
// - every piece that came from a document (a change sentence naming a stage, an id) is cleaned too.
// The rules are summary.ts's (`titled`, `cleanTitle`, MAX_FACTS), shared with every other summary.
import type { Db } from "@software-factory/db";
import type { FloorParse } from "../policy/gate.ts";
import type { PolicyImpact } from "../policy/impact.ts";
import { type OrgConfig, parseOrgConfig } from "../stages/org-config.ts";
import { cleanTitle, MAX_FACTS, titled } from "./summary.ts";
import {
  currentOrgConfig,
  orgConfigImpact,
  storedOrgConfig,
  withAgent,
  withWorkflow,
} from "./workflows.ts";

/** `s` cut to `max` characters with an ellipsis. */
const cut = (s: string, max: number) => {
  const c = [...s];
  return c.length <= max ? s : `${c.slice(0, Math.max(1, max - 1)).join("")}…`;
};

/** A name for the prompt, quoted (kept for the config summaries' callers). */
export const quotedName = (name: string) => `"${cut(cleanTitle(name), 60)}"`;

/**
 * "loosens: <the change>" or "loosens 3 things: <the first>…": the class first, then the first
 * change of that class, cleaned and cut to the room left. The full list is on the screen.
 */
export function impactWords(impact: PolicyImpact, room = 160): string {
  const mine = impact.changes.filter((c) => c.class === impact.class);
  const lead = mine.length > 1 ? `${impact.class} ${mine.length} things` : impact.class;
  const first = mine[0] ? cleanTitle(mine[0].summary.replace(/\.$/, "")) : "";
  if (!first) return lead;
  const more = mine.length > 1 ? "…" : "";
  return `${lead}: ${cut(first, Math.max(12, room - lead.length - 2 - more.length))}${more}`;
}

/** Facts never past MAX_FACTS: the impact words give way first (they come last among the facts). */
export function facts(head: string, impact?: PolicyImpact | string | null): string {
  const h = cleanTitle(head);
  if (!impact) return cut(h, MAX_FACTS);
  const room = MAX_FACTS - [...h].length - 2;
  const words =
    typeof impact === "string" ? cut(cleanTitle(impact), room) : impactWords(impact, room);
  return `${h}: ${words}`;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** An id from a request, shown only if it looks like one. */
const idOf = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(v) ? v : "an unnamed one";

async function orgName(db: Db, orgId: string): Promise<string> {
  const row = await db
    .selectFrom("core_organization")
    .select("name")
    .where("id", "=", orgId)
    .executeTakeFirst();
  return row?.name ?? orgId;
}

/**
 * The summary of an org config write (`workflow.save`, `agent.save`, `workflow.archive`,
 * `workflow.createFromTemplate`, `orgConfig.rollback`, `orgConfig.adoptProjectWorkflows`), made
 * directly or approved as a waiting change (`verb`). Null for any other operation.
 */
export async function describeOrgConfigDecision(
  db: Db,
  op: string,
  raw: Record<string, unknown>,
  verb?: "Approve" | "Reject",
): Promise<string | null> {
  const orgId = typeof raw.orgId === "string" ? raw.orgId : null;
  if (!orgId) return null;
  const { version, config } = await currentOrgConfig(db, orgId);
  const org = await orgName(db, orgId);
  const base = typeof raw.baseVersion === "number" ? raw.baseVersion : version;
  const versions =
    base !== version ? `drafted on v${base}, now v${version}` : `v${version} to v${version + 1}`;
  const say = (act: string) => (verb ? `${verb}: ${act}` : act[0]?.toUpperCase() + act.slice(1));
  const impactOf = (after: OrgConfig | null) => {
    if (!after) return "the change can't be read";
    const parsed = parseOrgConfig(after);
    return parsed.ok ? orgConfigImpact(config, parsed.config) : "not valid";
  };
  const attempt = (fn: () => OrgConfig) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  switch (op) {
    case "workflow.save": {
      const wf = obj(raw.workflow);
      const after = attempt(() => withWorkflow(config, wf as never));
      return titled(
        facts(say(`save an org workflow (${versions})`), impactOf(after)),
        `${String(wf.name ?? "")} in ${org}`,
      );
    }
    case "agent.save": {
      const agent = obj(raw.agent);
      const after = attempt(() => withAgent(config, agent as never));
      return titled(
        facts(say(`save an org agent (${versions})`), impactOf(after)),
        `${String(agent.name ?? "")} in ${org}`,
      );
    }
    case "workflow.archive": {
      const wf = config.workflows.find((w) => w.id === raw.workflowId);
      return titled(
        facts(say(`archive an org workflow (${versions})`)),
        `${wf?.name ?? ""} in ${org}`,
      );
    }
    case "workflow.createFromTemplate":
      return titled(
        facts(say(`add an org workflow from the ${idOf(raw.templateId)} template (${versions})`)),
        `${String(raw.name ?? "")} in ${org}`,
      );
    case "orgConfig.rollback": {
      const to = typeof raw.toVersion === "number" ? raw.toVersion : 0;
      return titled(
        facts(
          say(`roll the org's workflows back to v${to} (${versions})`),
          impactOf(await storedOrgConfig(db, orgId, to)),
        ),
        org,
      );
    }
    case "orgConfig.adoptProjectWorkflows":
      return titled(
        facts(
          say(`move the projects on their own workflows onto org workflows (${versions})`),
          "as the dry run showed",
        ),
        org,
      );
    default:
      return null;
  }
}

/** Turning a kill switch off: what resumes. */
export async function describeKillSwitchOff(
  db: Db,
  raw: Record<string, unknown>,
): Promise<string | null> {
  if (raw.on !== false || typeof raw.id !== "string") return null;
  if (raw.scope === "org")
    return titled("Turn the org's kill switch off: its work resumes", await orgName(db, raw.id));
  const p = await db
    .selectFrom("core_projects")
    .select("name")
    .where("id", "=", raw.id)
    .executeTakeFirst();
  return titled("Turn a project's kill switch off: its work resumes", p?.name ?? raw.id);
}

/**
 * An org admin approving a project's looser override: the setting, the org's value and the
 * override's value, all from the engine's records and the bound input (review of #156, item 2).
 */
export async function describeOverrideApprove(
  db: Db,
  _floor: FloorParse,
  raw: Record<string, unknown>,
  orgValue: unknown,
  verb = "Approve",
): Promise<string> {
  const p =
    typeof raw.projectId === "string"
      ? await db
          .selectFrom("core_projects")
          .select("name")
          .where("id", "=", raw.projectId)
          .executeTakeFirst()
      : undefined;
  const v = (x: unknown) =>
    cut(cleanTitle(x === undefined ? "unset" : typeof x === "string" ? x : JSON.stringify(x)), 40);
  return titled(
    facts(
      `${verb} a looser override (config v${Number(raw.configVersion)}, org v${Number(raw.orgVersion)})`,
      `loosens: ${idOf(raw.stageId)} ${idOf(raw.setting)} from the org's ${v(orgValue)} to ${v(raw.value)}`,
    ),
    p?.name ?? String(raw.projectId),
  );
}
