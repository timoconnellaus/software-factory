// A project's factory config as versions in the app (ADR 0370, spec 09 M1). A version is a row of
// core_project_policies keyed `v<N>`; the project's policy_sha points at the current one, so every
// reader of the policy keeps working. Saving validates first, a stale base is a conflict, and a save
// that loosens the current version is `self-modify`: it waits for an approver.
import type { Db } from "@software-factory/db";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext, type ProjectRow } from "../operation.ts";
import type { FloorParse } from "../policy/gate.ts";
import { type ImpactClass, type PolicyImpact, policyImpact } from "../policy/impact.ts";
import {
  isOrgWorkflowId,
  POLICY_PATH,
  type ProjectPolicy,
  parseProjectPolicy,
} from "../policy/project-policy.ts";
import { configImpact, resolveProjectWorkflow } from "../stages/project-workflow.ts";
import { requireAdjudicatorEarned } from "./adjudicator.ts";
import { projectId, requireProject } from "./shared.ts";
import { currentOrgConfig } from "./workflows.ts";

/** The config operations whose loosening saves wait for an approver. */
export const CONFIG_WRITES = ["config.save", "config.rollback"] as const;

export const CONFIG_SOURCES = ["app", "import", "migrated", "improver", "rollback"] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

/** The version number in a `v<N>` key; null for a row read from git before migration 0140. */
export function versionOf(sha: string | null): number | null {
  const match = sha ? /^v(\d+)$/.exec(sha) : null;
  return match ? Number(match[1]) : null;
}

export const versionKey = (version: number) => `v${version}`;

/**
 * Queues a new version and points the project at it. The batch aborts if the project moved past
 * `expectSha` in the meantime (another save landed first), so two saves can't both apply.
 */
export async function writeVersion(
  ctx: HandlerContext,
  project: Pick<ProjectRow, "id" | "policy_sha">,
  input: {
    raw: string;
    valid: boolean;
    error: string | null;
    source: ConfigSource;
    note: string | null;
    ref?: string;
    /** Who the version is by, when not the caller (an approved proposal is its proposer's). */
    createdBy?: string;
  },
): Promise<{ version: number; sha: string }> {
  const latest = await ctx.db
    .selectFrom("core_project_policies")
    .select(sql<number | null>`max(version)`.as("v"))
    .where("project_id", "=", project.id)
    .executeTakeFirst();
  const version = (latest?.v ?? 0) + 1;
  const key = versionKey(version);
  const expect = project.policy_sha;
  ctx.guardExists(
    "config base unchanged",
    ctx.db
      .selectFrom("core_projects")
      .select("id")
      .where("id", "=", project.id)
      .where((eb) =>
        expect === null ? eb("policy_sha", "is", null) : eb("policy_sha", "=", expect),
      ),
  );
  ctx.write(
    ctx.db.insertInto("core_project_policies").values({
      project_id: project.id,
      sha: key,
      ref: input.ref ?? "app",
      raw: input.raw,
      valid: input.valid ? 1 : 0,
      error: input.error,
      received_at: ctx.now,
      version,
      source: input.source,
      created_by: input.createdBy ?? ctx.actor.id,
      note: input.note,
      parent_version: versionOf(expect),
    }),
  );
  ctx.write(
    ctx.db.updateTable("core_projects").set({ policy_sha: key }).where("id", "=", project.id),
  );
  ctx.change({
    entity: "project",
    id: project.id,
    before: { policySha: expect },
    after: { policySha: key, version, source: input.source, valid: input.valid },
  });
  return { version, sha: key };
}

/** Pretty JSON, the form a version is stored and exported in. */
export const formatPolicy = (policy: unknown) => `${JSON.stringify(policy, null, 2)}\n`;

const policyDocument = z.record(z.string(), z.unknown());

const impactView = z.object({
  class: z.enum(["loosens", "tightens", "neutral"]),
  changes: z.array(
    z.object({
      path: z.string(),
      class: z.enum(["loosens", "tightens", "neutral"]),
      summary: z.string(),
    }),
  ),
});

/**
 * The risk of saving `draft` over the current version: loosening (or anything unjudgeable) is
 * self-modify. A draft the handler will refuse anyway (invalid, or edited from a stale version)
 * is `write`, so it's refused at once instead of waiting at the gate.
 */
async function saveRisk(
  draft: unknown,
  baseVersion: number,
  at: {
    db: Db;
    scope: { rawPolicy: ProjectPolicy | null; project: ProjectRow | null };
    floor: FloorParse;
  },
) {
  const parsed = parseProjectPolicy(JSON.stringify(draft));
  if (!parsed.ok) return "write" as const;
  if (!at.scope.project || (versionOf(at.scope.project.policy_sha) ?? 0) !== baseVersion) {
    return "write" as const;
  }
  const orgId = at.scope.project.org_id;
  if (isOrgWorkflowId(parsed.policy.workflow)) {
    // A workflow the org doesn't have, or overrides that don't apply: the handler refuses it.
    const resolved = resolveProjectWorkflow(
      parsed.policy,
      (await currentOrgConfig(at.db, orgId)).config,
    );
    if (resolved && !resolved.ok) return "write" as const;
  }
  const impact = await impactOf(at.db, orgId, at.scope.rawPolicy, parsed.policy, at.floor);
  return impact.class === "loosens" ? ("self-modify" as const) : ("write" as const);
}

/**
 * How `after` changes the saved config: `policyImpact`, with a change of org workflow or of its
 * overrides classified against the org's current workflow (spec 52 PR (d)). Compares the documents
 * as saved, never the resolved ones.
 */
async function impactOf(
  db: Db,
  orgId: string,
  before: ProjectPolicy | null,
  after: ProjectPolicy,
  floor: FloorParse,
): Promise<PolicyImpact> {
  const impact = policyImpact(before, after, floor);
  if (!before || !(isOrgWorkflowId(before.workflow) || isOrgWorkflowId(after.workflow)))
    return impact;
  return configImpact(impact, before, after, (await currentOrgConfig(db, orgId)).config);
}

/** A project on an org workflow must name one it can run, with overrides that apply. */
async function requireOrgWorkflow(db: Db, orgId: string, policy: ProjectPolicy) {
  if (!isOrgWorkflowId(policy.workflow)) return;
  const resolved = resolveProjectWorkflow(policy, (await currentOrgConfig(db, orgId)).config);
  if (resolved && !resolved.ok)
    throw new OperationError("invalid_input", `the config isn't valid: ${resolved.error}`, {
      error: resolved.error,
    });
}

/** A stored version's document, or null when there's no such valid version. */
async function storedVersion(db: Db, projectId: string, version: number) {
  const row = await db
    .selectFrom("core_project_policies")
    .select(["raw", "valid"])
    .where("project_id", "=", projectId)
    .where("version", "=", version)
    .executeTakeFirst();
  if (!row?.valid) return null;
  const parsed = parseProjectPolicy(row.raw);
  return parsed.ok ? { raw: row.raw, policy: parsed.policy } : null;
}

function requireBase(project: ProjectRow, baseVersion: number) {
  const current = versionOf(project.policy_sha) ?? 0;
  if (current !== baseVersion) {
    throw new OperationError(
      "conflict",
      `the config moved on: it's at v${current}, this was edited from v${baseVersion}. Reload and save again.`,
      { currentVersion: current },
    );
  }
}

function validate(draft: unknown): ProjectPolicy {
  const parsed = parseProjectPolicy(JSON.stringify(draft));
  if (!parsed.ok) {
    throw new OperationError("invalid_input", `the config isn't valid: ${parsed.error}`, {
      error: parsed.error,
    });
  }
  return parsed.policy;
}

const versionView = z.object({
  version: z.number().nullable(),
  sha: z.string(),
  source: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  valid: z.boolean(),
  /** How this version changed the one before it. */
  impact: z.enum(["loosens", "tightens", "neutral"]).nullable(),
  /** The version's document (for rollback and comparison); null when it isn't valid JSON. */
  policy: z.record(z.string(), z.unknown()).nullable(),
});

export const configGet = defineOperation({
  name: "config.get",
  description:
    "A project's factory config (ADR 0370): the current version's document with its number, author and source, and the last 50 versions with what each one loosened or tightened. Members only.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({
    projectId: z.string(),
    current: versionView.nullable(),
    error: z.string().nullable(),
    history: z.array(versionView),
    /** Saves and rollbacks waiting for an approver (they loosen the config). */
    pending: z.array(
      z.object({
        pendingActionId: z.string(),
        operation: z.string(),
        note: z.string().nullable(),
        by: z.string().nullable(),
        createdAt: z.string(),
        baseVersion: z.number().nullable(),
      }),
    ),
  }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    const rows = await ctx.db
      .selectFrom("core_project_policies as pp")
      .leftJoin("core_user as u", "u.id", "pp.created_by")
      .select([
        "pp.sha",
        "pp.version",
        "pp.source",
        "pp.note",
        "pp.raw",
        "pp.valid",
        "pp.received_at",
        "u.github_login",
        "u.name",
      ])
      .where("pp.project_id", "=", project.id)
      .where("pp.version", "is not", null)
      .orderBy("pp.version", "desc")
      .limit(51)
      .execute();
    const parsed = rows.map((r) => {
      const p = r.valid ? parseProjectPolicy(r.raw) : null;
      let doc: Record<string, unknown> | null = null;
      try {
        doc = JSON.parse(r.raw) as Record<string, unknown>;
      } catch {
        doc = null;
      }
      return { row: r, policy: p?.ok ? p.policy : null, doc };
    });
    const history = parsed.slice(0, 50).map((entry, i) => {
      const before = parsed[i + 1];
      let impact: ImpactClass | null = null;
      if (entry.policy) {
        impact = policyImpact(before?.policy ?? null, entry.policy, ctx.floor).class;
      }
      return {
        version: entry.row.version,
        sha: entry.row.sha,
        source: entry.row.source,
        note: entry.row.note,
        createdBy: entry.row.github_login ?? entry.row.name ?? null,
        createdAt: entry.row.received_at,
        valid: Boolean(entry.row.valid),
        impact,
        policy: entry.doc,
      };
    });
    const current =
      history.find((h) => h.sha === project.policy_sha) ??
      (project.policy_sha ? await legacyCurrent(ctx, project) : null);
    const waiting = await ctx.db
      .selectFrom("core_pending_actions as pa")
      .leftJoin("core_user as u", "u.id", "pa.actor_id")
      .select(["pa.id", "pa.operation", "pa.input", "pa.created_at", "u.github_login", "u.name"])
      .where("pa.project_id", "=", project.id)
      .where("pa.status", "=", "pending")
      .where("pa.operation", "in", [...CONFIG_WRITES])
      .orderBy("pa.created_at", "desc")
      .execute();
    const pending = waiting.map((p) => {
      let input: { note?: string; baseVersion?: number; toVersion?: number } = {};
      try {
        input = JSON.parse(p.input);
      } catch {
        input = {};
      }
      return {
        pendingActionId: p.id,
        operation: p.operation,
        note:
          input.note ??
          (p.operation === "config.rollback" ? `Roll back to v${input.toVersion}` : null),
        by: p.github_login ?? p.name ?? null,
        createdAt: p.created_at,
        baseVersion: input.baseVersion ?? null,
      };
    });
    return {
      projectId: project.id,
      current,
      error: ctx.scope.policyError,
      history,
      pending,
    };
  },
});

/** A project still pointing at a git-SHA row (migrated projects point at v1; this is the fallback). */
async function legacyCurrent(ctx: HandlerContext, project: ProjectRow) {
  const row = await ctx.db
    .selectFrom("core_project_policies")
    .selectAll()
    .where("project_id", "=", project.id)
    .where("sha", "=", project.policy_sha ?? "")
    .executeTakeFirst();
  if (!row) return null;
  let doc: Record<string, unknown> | null = null;
  try {
    doc = JSON.parse(row.raw) as Record<string, unknown>;
  } catch {
    doc = null;
  }
  return {
    version: row.version,
    sha: row.sha,
    source: row.source ?? "git",
    note: row.note,
    createdBy: null,
    createdAt: row.received_at,
    valid: Boolean(row.valid),
    impact: null,
    policy: doc,
  };
}

export const configPreview = defineOperation({
  name: "config.preview",
  description:
    "Check a draft of a project's config without saving it: whether it is valid (and the first error if not), and its impact summary against the current version: each change, and whether it loosens, tightens or is neutral. A loosening save waits for an approver.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ projectId, policy: policyDocument }),
  output: z.object({
    valid: z.boolean(),
    error: z.string().nullable(),
    impact: impactView.nullable(),
    currentVersion: z.number(),
  }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const parsed = parseProjectPolicy(JSON.stringify(input.policy));
    let error = parsed.ok ? null : parsed.error;
    if (parsed.ok && isOrgWorkflowId(parsed.policy.workflow)) {
      const resolved = resolveProjectWorkflow(
        parsed.policy,
        (await currentOrgConfig(ctx.db, project.org_id)).config,
      );
      if (resolved && !resolved.ok) error = resolved.error;
    }
    return {
      valid: error === null,
      error,
      impact: parsed.ok
        ? await impactOf(ctx.db, project.org_id, ctx.scope.rawPolicy, parsed.policy, ctx.floor)
        : null,
      currentVersion: versionOf(project.policy_sha) ?? 0,
    };
  },
});

export const configSave = defineOperation({
  name: "config.save",
  description:
    "Save a new version of a project's factory config (ADR 0370). Name the version you edited from (`baseVersion`; 0 if there is none): a stale base is refused as a conflict. An invalid document is refused and nothing is written. A save that loosens the current version (a looser autonomy policy, an added approver, a hidden review section, a wider harness…) is self-modify: it becomes a pending action an approver decides, judged under the current version. Other saves apply at once, for new work and as a tightening of running work. Any org member may save.",
  risk: "write",
  riskOf: (input, at) => saveRisk(input.policy, input.baseVersion, at),
  actors: ["human"],
  permission: "member",
  input: z.object({
    projectId,
    baseVersion: z.number().int().nonnegative(),
    policy: policyDocument,
    note: z.string().trim().max(500).optional(),
    /** `import` when the document came from an exported `.factory/` bundle. */
    source: z.enum(["app", "import"]).default("app"),
  }),
  output: z.object({ version: z.number(), sha: z.string(), impact: impactView }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const policy = validate(input.policy);
    requireBase(project, input.baseVersion);
    await requireOrgWorkflow(ctx.db, project.org_id, policy);
    await requireAdjudicatorEarned(ctx, policy);
    const impact = await impactOf(ctx.db, project.org_id, ctx.scope.rawPolicy, policy, ctx.floor);
    const written = await writeVersion(ctx, project, {
      raw: formatPolicy(input.policy),
      valid: true,
      error: null,
      source: input.source,
      note: input.note || null,
    });
    return { ...written, impact };
  },
});

export const configRollback = defineOperation({
  name: "config.rollback",
  description:
    "Make an earlier version of a project's config current again, as a new version (source `rollback`). The gate judges the change like any save: a rollback that loosens the current version waits for an approver; one that tightens or is neutral applies at once.",
  risk: "write",
  async riskOf(input, at) {
    const target = at.scope.project
      ? await storedVersion(at.db, at.scope.project.id, input.toVersion)
      : null;
    // A missing version is refused by the handler.
    return target ? saveRisk(target.policy, input.baseVersion, at) : "write";
  },
  actors: ["human"],
  permission: "member",
  input: z.object({
    projectId,
    baseVersion: z.number().int().nonnegative(),
    toVersion: z.number().int().positive(),
    note: z.string().trim().max(500).optional(),
  }),
  output: z.object({ version: z.number(), sha: z.string(), impact: impactView }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const target = await storedVersion(ctx.db, project.id, input.toVersion);
    if (!target) throw new OperationError("not_found", `no valid version ${input.toVersion}`);
    requireBase(project, input.baseVersion);
    await requireOrgWorkflow(ctx.db, project.org_id, target.policy);
    const impact = await impactOf(
      ctx.db,
      project.org_id,
      ctx.scope.rawPolicy,
      target.policy,
      ctx.floor,
    );
    const written = await writeVersion(ctx, project, {
      raw: target.raw,
      valid: true,
      error: null,
      source: "rollback",
      note: input.note || `Rolled back to v${input.toVersion}`,
    });
    return { ...written, impact };
  },
});

export const configExport = defineOperation({
  name: "config.export",
  description: `Export a project's current config as a \`.factory/\` bundle: a map of file path to text, today just \`${POLICY_PATH}\`. Import it into another project (or back) with config.save, source \`import\`.`,
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ projectId }),
  output: z.object({
    version: z.number().nullable(),
    files: z.record(z.string(), z.string()),
  }),
  async handler(_input, ctx) {
    const project = requireProject(ctx);
    if (!project.policy_sha)
      throw new OperationError("not_found", "this project has no config yet");
    const row = await ctx.db
      .selectFrom("core_project_policies")
      .select(["raw"])
      .where("project_id", "=", project.id)
      .where("sha", "=", project.policy_sha)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "the current version is missing");
    return { version: versionOf(project.policy_sha), files: { [POLICY_PATH]: row.raw } };
  },
});

/**
 * Applies an approved config proposal (a loosening `config.save` or `config.rollback` that waited
 * at the gate) in the approver's call: a project-level pending action has no Workflow to re-run
 * it. The proposer stays its author. Refuses, deciding nothing, when the config moved on since it
 * was proposed or the document no longer validates.
 */
export async function applyApprovedConfig(
  ctx: HandlerContext,
  pa: { id: string; operation: string; input: string; actor_id: string },
): Promise<{ version: number; sha: string }> {
  const project = requireProject(ctx);
  const input = JSON.parse(pa.input) as {
    baseVersion: number;
    policy: unknown;
    note?: string;
    source?: "app" | "import";
    toVersion?: number;
  };
  if (pa.operation === "config.save") {
    await requireAdjudicatorEarned(ctx, validate(input.policy));
  }
  requireBase(project, input.baseVersion);
  const rollback = pa.operation === "config.rollback";
  const restored = rollback ? await storedVersion(ctx.db, project.id, input.toVersion ?? 0) : null;
  if (rollback && !restored) {
    throw new OperationError("not_found", `no valid version ${input.toVersion}`);
  }
  const written = await writeVersion(ctx, project, {
    raw: restored?.raw ?? formatPolicy(input.policy),
    valid: true,
    error: null,
    source: rollback ? "rollback" : (input.source ?? "app"),
    note: input.note || (rollback ? `Rolled back to v${input.toVersion}` : null),
    createdBy: pa.actor_id,
  });
  ctx.writePendingStatus(
    "apply",
    ctx.db.updateTable("core_pending_actions").set({ status: "applied" }).where("id", "=", pa.id),
  );
  return written;
}
