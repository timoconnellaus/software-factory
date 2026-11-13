// The words for a policy decision made with a presence proof (ADR 0391, 0610): from the engine's
// own records, never the caller's. The Touch ID prompt and the audit journal show them, so each
// names what is decided and, first, what it loosens. Names come last, cleaned and cut short.
import type { Db } from "@software-factory/db";
import type { FloorParse } from "../policy/gate.ts";
import type { PolicyImpact } from "../policy/impact.ts";
import { type OrgConfig, parseOrgConfig } from "../stages/org-config.ts";
import {
  currentOrgConfig,
  orgConfigImpact,
  storedOrgConfig,
  withAgent,
  withWorkflow,
} from "./workflows.ts";

/** At most this many changes are listed; the Touch ID prompt has little room. */
const SUMMARY_CHANGES = 3;

/**
 * A name as the prompt shows it: no quotes, control or invisible characters (a name can't pose as
 * the engine's words), spaces collapsed, at most 60 characters, in quotes.
 */
export function quotedName(name: string): string {
  const clean = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `"${clean.length > 60 ? `${clean.slice(0, 59)}…` : clean}"`;
}

/** "loosens: A; B (+2 more)": the impact's class and the changes of that class, first. */
export function impactWords(impact: PolicyImpact): string {
  const shown = impact.changes.filter((c) => c.class === impact.class).slice(0, SUMMARY_CHANGES);
  const rest = impact.changes.length - shown.length;
  const what = shown.map((c) => c.summary.replace(/\.$/, "")).join("; ");
  return `${impact.class}${what ? `: ${what}` : ""}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

async function orgName(db: Db, orgId: string): Promise<string> {
  const row = await db
    .selectFrom("core_organization")
    .select("name")
    .where("id", "=", orgId)
    .executeTakeFirst();
  return quotedName(row?.name ?? orgId);
}

/**
 * The summary of an org config write (`workflow.save`, `agent.save`, `workflow.archive`,
 * `workflow.createFromTemplate`, `orgConfig.rollback`, `orgConfig.adoptProjectWorkflows`), made
 * directly or approved as a waiting change. `verb` starts it ("Save", "Approve", "Reject"). Null for
 * any other operation.
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
    base !== version
      ? `drafted on v${base}, the org's workflows are now v${version}`
      : `v${version} to v${version + 1}`;
  // "Approve: save …" for a waiting change; "Save …" made directly.
  const say = (act: string) => (verb ? `${verb}: ${act}` : act[0]?.toUpperCase() + act.slice(1));
  const loosening = (after: OrgConfig | null) => {
    if (!after) return "the change can't be read";
    const parsed = parseOrgConfig(after);
    return parsed.ok ? impactWords(orgConfigImpact(config, parsed.config)) : "not valid";
  };
  switch (op) {
    case "workflow.save": {
      const wf = obj(raw.workflow);
      let after: OrgConfig | null = null;
      try {
        after = withWorkflow(config, wf as never);
      } catch {
        after = null;
      }
      return say(
        `save the org workflow (${versions}): ${loosening(after)}: ${quotedName(String(wf.name ?? wf.id ?? "a workflow"))} in ${org}`,
      );
    }
    case "agent.save": {
      const agent = obj(raw.agent);
      let after: OrgConfig | null = null;
      try {
        after = withAgent(config, agent as never);
      } catch {
        after = null;
      }
      return say(
        `save the org agent (${versions}): ${loosening(after)}: ${quotedName(String(agent.name ?? "an agent"))} in ${org}`,
      );
    }
    case "workflow.archive": {
      const wf = config.workflows.find((w) => w.id === raw.workflowId);
      return say(
        `archive the org workflow (${versions}): ${quotedName(wf?.name ?? String(raw.workflowId))} in ${org}`,
      );
    }
    case "workflow.createFromTemplate":
      return say(
        `add an org workflow from the ${String(raw.templateId)} template (${versions}): ${quotedName(String(raw.name ?? ""))} in ${org}`,
      );
    case "orgConfig.rollback": {
      const to = typeof raw.toVersion === "number" ? raw.toVersion : 0;
      return say(
        `roll the org's workflows back to v${to} (${versions}): ${loosening(await storedOrgConfig(db, orgId, to))}: ${org}`,
      );
    }
    case "orgConfig.adoptProjectWorkflows":
      return say(
        `move every project still on its own workflow onto org workflows (${versions}), keeping what each item does: ${org}`,
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
    return `Turn the org's kill switch off: its work resumes: ${await orgName(db, raw.id)}`;
  const p = await db
    .selectFrom("core_projects")
    .select("name")
    .where("id", "=", raw.id)
    .executeTakeFirst();
  return `Turn the project's kill switch off: its work resumes: ${quotedName(p?.name ?? raw.id)}`;
}

/** An org admin approving a project's looser override. */
export async function describeOverrideApprove(
  db: Db,
  _floor: FloorParse,
  raw: Record<string, unknown>,
): Promise<string> {
  const p =
    typeof raw.projectId === "string"
      ? await db
          .selectFrom("core_projects")
          .select("name")
          .where("id", "=", raw.projectId)
          .executeTakeFirst()
      : undefined;
  return `Approve a looser override (loosens: ${String(raw.stageId)} ${String(raw.setting)}, for org workflows v${String(raw.orgVersion)}): ${quotedName(p?.name ?? String(raw.projectId))}`;
}
