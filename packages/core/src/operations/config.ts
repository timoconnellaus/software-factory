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
import { type ImpactClass, type PolicyImpact, policyImpact, same } from "../policy/impact.ts";
import {
  isOrgWorkflowId,
  onOrgWorkflow,
  POLICY_PATH,
  type ProjectPolicy,
  parseProjectPolicy,
} from "../policy/project-policy.ts";
import { overrideApprovals } from "../scope.ts";
import {
  configImpact,
  normaliseOverrides,
  resolveProjectWorkflow,
} from "../stages/project-workflow.ts";
import { requireAdjudicatorEarned } from "./adjudicator.ts";
import { projectId, requireProject } from "./shared.ts";
import { cleanText, titled } from "./summary.ts";
import { currentOrgConfig } from "./workflows.ts";

/** The config operations whose loosening saves wait for an approver. */
export const CONFIG_WRITES = ["config.save", "config.rollback"] as const;

/** How many waiting config changes `config.get` lists. */
export const PENDING_SHOWN = 20;

/** A waiting config save's or rollback's stored input; `{}` when it isn't readable. */
function pendingInput(raw: string): {
  note?: string;
  baseVersion?: number;
  toVersion?: number;
  policy?: Record<string, unknown>;
} {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, never>) : {};
  } catch {
    return {};
  }
}

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
    /** The project's highest version when the caller already read it (a write for many projects). */
    latest?: number | null;
  },
): Promise<{ version: number; sha: string }> {
  const latest =
    input.latest !== undefined
      ? { v: input.latest }
      : await ctx.db
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
  if (newOrgShapedName(at.scope.rawPolicy, parsed.policy)) return "write" as const;
  if (onOrgWorkflow(parsed.policy)) {
    // A workflow the org doesn't have, or overrides that don't apply: the handler refuses it.
    const resolved = resolveProjectWorkflow(
      parsed.policy,
      (await currentOrgConfig(at.db, orgId)).config,
      { kind: "requested" },
    );
    if (resolved && !resolved.ok) return "write" as const;
  }
  const impact = await impactOf(
    at.db,
    at.scope.project,
    at.scope.rawPolicy,
    parsed.policy,
    at.floor,
  );
  return impact.class === "loosens" ? ("self-modify" as const) : ("write" as const);
}

/**
 * Whether a save loosens the project's org workflow (an override looser than the org's value, or a
 * switch onto or between org workflows that drops something): an org admin decides it, not the
 * project's approvers (spec 52, Q6; the owner's answer).
 */
export async function orgAdminDecidesSave(
  draft: unknown,
  at: {
    db: Db;
    scope: { rawPolicy: ProjectPolicy | null; project: ProjectRow | null };
    floor: FloorParse;
  },
): Promise<boolean> {
  const parsed = parseProjectPolicy(JSON.stringify(draft));
  if (!parsed.ok || !at.scope.project) return false;
  const before = at.scope.rawPolicy;
  if (!onOrgWorkflow(parsed.policy) && !onOrgWorkflow(before)) return false;
  const impact = await impactOf(at.db, at.scope.project, before, parsed.policy, at.floor);
  return impact.changes.some(
    (c) => c.class === "loosens" && (c.path === "workflow" || c.path.startsWith("workflow.")),
  );
}

/**
 * A slot workflow the draft adds under a name shaped like an org workflow id (`wf_…`). Names like
 * that are reserved for org workflows from spec 52 PR (d) on; a slot workflow that already had one
 * keeps it, so existing configs are untouched.
 */
function newOrgShapedName(before: ProjectPolicy | null, after: ProjectPolicy): string | null {
  const had = new Set((before?.workflows ?? []).map((w) => w.name.toLowerCase()));
  return (
    after.workflows.find((w) => isOrgWorkflowId(w.name) && !had.has(w.name.toLowerCase()))?.name ??
    null
  );
}

function requireName(before: ProjectPolicy | null, after: ProjectPolicy) {
  const name = newOrgShapedName(before, after);
  if (name)
    throw new OperationError(
      "invalid_input",
      `a workflow can't be called "${name}": names like that are org workflow ids`,
    );
}

/**
 * How `after` changes the saved config: `policyImpact`, with a change of org workflow or of its
 * overrides classified against the org's current workflow (spec 52 PR (d)). Compares the documents
 * as saved, never the resolved ones.
 */
async function impactOf(
  db: Db,
  project: { id: string; org_id: string },
  before: ProjectPolicy | null,
  after: ProjectPolicy,
  floor: FloorParse,
): Promise<PolicyImpact> {
  const impact = policyImpact(before, after, floor);
  if (!before || !(onOrgWorkflow(before) || onOrgWorkflow(after))) return impact;
  const { version, config } = await currentOrgConfig(db, project.org_id);
  // What `before` runs now: its looser overrides only where approved for this org version.
  const approvals = onOrgWorkflow(before) ? await overrideApprovals(db, project.id, version) : {};
  return configImpact(impact, before, after, config, approvals);
}

/** A project on an org workflow must name one it can run, with overrides that apply. */
async function requireOrgWorkflow(db: Db, orgId: string, policy: ProjectPolicy) {
  if (!onOrgWorkflow(policy)) return;
  const resolved = resolveProjectWorkflow(policy, (await currentOrgConfig(db, orgId)).config, {
    kind: "requested",
  });
  if (resolved && !resolved.ok)
    throw new OperationError("invalid_input", `the config isn't valid: ${resolved.error}`, {
      error: resolved.error,
    });
}

/**
 * The document a version stores (spec 52, fourth review): on an org workflow, only the overrides
 * that differ from the org's value (`normaliseOverrides`), with the looser ones listed (each applies
 * once an org admin approves it for this org version). A document's own `workflowOverrideApprovals`
 * is never kept: approvals are the factory's record (`core_override_approvals`). A config not on an
 * org workflow is stored as written, less that field.
 */
async function storedDocument(
  db: Db,
  orgId: string,
  doc: Record<string, unknown>,
  policy: ProjectPolicy,
): Promise<{
  doc: Record<string, unknown>;
  looser: { stageId: string; key: string; value: unknown }[];
  orgVersion: number;
}> {
  const { workflowOverrideApprovals: _drop, ...rest } = doc;
  if (!onOrgWorkflow(policy)) return { doc: rest, looser: [], orgVersion: 0 };
  const { version, config } = await currentOrgConfig(db, orgId);
  const n = normaliseOverrides(policy, config);
  return {
    doc: { ...rest, workflowOverrides: n.workflowOverrides },
    looser: n.looser,
    orgVersion: version,
  };
}

/** Whether `after`'s override `l` was already in `before`, on the same workflow, with that value. */
function kept(
  before: ProjectPolicy | null,
  after: ProjectPolicy,
  l: { stageId: string; key: string; value: unknown },
): boolean {
  if (!before || !onOrgWorkflow(before) || before.workflow !== after.workflow) return false;
  const was = before.workflowOverrides[l.stageId];
  return !!was && Object.hasOwn(was, l.key) && same(was[l.key], l.value);
}

/**
 * Records an org admin's approval of a project's looser overrides for one org version: the only
 * writer of `core_override_approvals` besides the factory's carry to an unchanged next version.
 */
function approveOverrides(
  ctx: HandlerContext,
  project: { id: string; org_id: string },
  stored: { looser: { stageId: string; key: string; value: unknown }[]; orgVersion: number },
) {
  for (const l of stored.looser)
    ctx.write(
      ctx.db
        .insertInto("core_override_approvals")
        .values({
          project_id: project.id,
          org_id: project.org_id,
          org_version: stored.orgVersion,
          stage_id: l.stageId,
          setting: l.key,
          value: JSON.stringify(l.value),
          approved_by: ctx.actor.id,
          approved_at: ctx.now,
        })
        .onConflict((oc) =>
          oc.columns(["project_id", "org_version", "stage_id", "setting"]).doUpdateSet({
            value: JSON.stringify(l.value),
            approved_by: ctx.actor.id,
            approved_at: ctx.now,
          }),
        ),
    );
}

/** Refuses when the org's config has a version newer than `since` (an ISO time). */
async function requireOrgUnchangedSince(db: Db, orgId: string, since: string) {
  // A point read: the org's row, and its current config version by primary key.
  const row = await db
    .selectFrom("core_organization as o")
    .innerJoin("core_org_configs as c", (j) =>
      j.onRef("c.org_id", "=", "o.id").onRef("c.version", "=", "o.config_version"),
    )
    .select(["c.version", "c.created_at"])
    .where("o.id", "=", orgId)
    .executeTakeFirst();
  if (row && row.created_at > since)
    throw new OperationError(
      "conflict",
      `the org's workflows changed (v${row.version}) after this was asked: save it again so it is judged against them`,
    );
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
        /**
         * What the save would make current (a rollback: the version it restores), so a client can
         * show its classified impact with `config.preview` before an approver decides.
         */
        policy: z.record(z.string(), z.unknown()).nullable(),
        /** A rollback's target version; null for a save. */
        toVersion: z.number().nullable(),
      }),
    ),
    /** More than `pending` shows are waiting (it shows the newest 20). */
    pendingMore: z.boolean(),
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
    // The newest PENDING_SHOWN waiting saves, and whether there are more (no count: the table
    // grows). Any member can make one with a loosening save, and each carries a whole document.
    const waiting = await ctx.db
      .selectFrom("core_pending_actions as pa")
      .leftJoin("core_user as u", "u.id", "pa.actor_id")
      .select(["pa.id", "pa.operation", "pa.input", "pa.created_at", "u.github_login", "u.name"])
      .where("pa.project_id", "=", project.id)
      .where("pa.status", "=", "pending")
      .where("pa.operation", "in", [...CONFIG_WRITES])
      .orderBy("pa.created_at", "desc")
      .limit(PENDING_SHOWN + 1)
      .execute();
    const inputs = waiting
      .slice(0, PENDING_SHOWN)
      .map((p) => ({ p, input: pendingInput(p.input) }));
    // A rollback's target by version, in one read for those older than the history above.
    const missing = [
      ...new Set(
        inputs
          .filter(({ p }) => p.operation === "config.rollback")
          .map(({ input }) => input.toVersion)
          .filter(
            (v): v is number =>
              typeof v === "number" && !history.some((h) => h.version === v && h.policy),
          ),
      ),
    ];
    const older = missing.length
      ? await ctx.db
          .selectFrom("core_project_policies")
          .select(["version", "raw"])
          .where("project_id", "=", project.id)
          .where("version", "in", missing)
          .where("valid", "=", 1)
          .execute()
      : [];
    const targetOf = (v: number | undefined) => {
      const h = history.find((x) => x.version === v)?.policy;
      if (h) return h;
      const row = older.find((r) => r.version === v);
      try {
        return row ? (JSON.parse(row.raw) as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };
    const pending = inputs.map(({ p, input }) => ({
      pendingActionId: p.id,
      operation: p.operation,
      note:
        input.note ??
        (p.operation === "config.rollback" ? `Roll back to v${input.toVersion}` : null),
      by: p.github_login ?? p.name ?? null,
      createdAt: p.created_at,
      baseVersion: input.baseVersion ?? null,
      policy:
        p.operation === "config.rollback"
          ? targetOf(input.toVersion)
          : input.policy && typeof input.policy === "object"
            ? input.policy
            : null,
      toVersion: p.operation === "config.rollback" ? (input.toVersion ?? null) : null,
    }));
    return {
      projectId: project.id,
      current,
      error: ctx.scope.policyError,
      history,
      pending,
      pendingMore: waiting.length > PENDING_SHOWN,
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
    if (parsed.ok) {
      const name = newOrgShapedName(ctx.scope.rawPolicy, parsed.policy);
      if (name)
        error = `a workflow can't be called "${name}": names like that are org workflow ids`;
    }
    if (parsed.ok && !error && onOrgWorkflow(parsed.policy)) {
      const resolved = resolveProjectWorkflow(
        parsed.policy,
        (await currentOrgConfig(ctx.db, project.org_id)).config,
        { kind: "requested" },
      );
      if (resolved && !resolved.ok) error = resolved.error;
    }
    return {
      valid: error === null,
      error,
      impact: parsed.ok
        ? await impactOf(ctx.db, project, ctx.scope.rawPolicy, parsed.policy, ctx.floor)
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
  decidedByOrgAdmin: (input, at) => orgAdminDecidesSave(input.policy, at),
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
    requireName(ctx.scope.rawPolicy, policy);
    await requireOrgWorkflow(ctx.db, project.org_id, policy);
    await requireAdjudicatorEarned(ctx, policy);
    const impact = await impactOf(ctx.db, project, ctx.scope.rawPolicy, policy, ctx.floor);
    const stored = await storedDocument(ctx.db, project.org_id, input.policy, policy);
    const written = await writeVersion(ctx, project, {
      raw: formatPolicy(stored.doc),
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
  async decidedByOrgAdmin(input, at) {
    const target = at.scope.project
      ? await storedVersion(at.db, at.scope.project.id, input.toVersion)
      : null;
    return target ? orgAdminDecidesSave(target.policy, at) : false;
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
    const impact = await impactOf(ctx.db, project, ctx.scope.rawPolicy, target.policy, ctx.floor);
    const restored = formatPolicy(
      (
        await storedDocument(
          ctx.db,
          project.org_id,
          JSON.parse(target.raw) as Record<string, unknown>,
          target.policy,
        )
      ).doc,
    );
    const written = await writeVersion(ctx, project, {
      raw: restored,
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
  pa: {
    id: string;
    operation: string;
    input: string;
    actor_id: string;
    created_at: string;
    decider: string | null;
  },
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
  const policy = restored?.policy ?? validate(input.policy);
  let raw = restored?.raw ?? formatPolicy(input.policy);
  if (onOrgWorkflow(policy)) {
    // The approval was of a loosening against the org's workflow as it was when it was asked: if the
    // org has saved since, what was approved may not be what would apply, so it's asked again.
    await requireOrgUnchangedSince(ctx.db, project.org_id, pa.created_at);
    await requireOrgWorkflow(ctx.db, project.org_id, policy);
    const stored = await storedDocument(
      ctx.db,
      project.org_id,
      JSON.parse(raw) as Record<string, unknown>,
      policy,
    );
    raw = formatPolicy(stored.doc);
    // An org admin approved it: the looser overrides this change itself brings or changes apply,
    // for this org version only. Never one it merely keeps, nor any a project approver decided: a
    // kept looser override still takes the stricter value until an org admin approves it.
    if (pa.decider === "org-admin")
      approveOverrides(ctx, project, {
        orgVersion: stored.orgVersion,
        looser: stored.looser.filter((l) => !kept(ctx.scope.rawPolicy, policy, l)),
      });
  }
  const written = await writeVersion(ctx, project, {
    raw,
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

/** At most this much of a summary lists changes; the Touch ID prompt has little room. */
const SUMMARY_CHANGES = 3;

/**
 * The words for deciding a waiting config save or rollback (ADR 0391, 0610), from the engine's own
 * records, never the caller's: the project, the versions, and the change as the engine classifies
 * it against the current version. The Touch ID prompt and the audit journal show them. Null when
 * the pending action isn't a project config change.
 */
export async function describeConfigDecision(
  ctx: { db: Db; floor: FloorParse },
  pa: { operation: string; input: string; project_id: string | null },
  verb: "Approve" | "Reject",
): Promise<string | null> {
  if (!(CONFIG_WRITES as readonly string[]).includes(pa.operation) || !pa.project_id) return null;
  const project = (await ctx.db
    .selectFrom("core_projects")
    .selectAll()
    .where("id", "=", pa.project_id)
    .executeTakeFirst()) as ProjectRow | undefined;
  if (!project) return null;
  const input = pendingInput(pa.input);
  const current = versionOf(project.policy_sha) ?? 0;
  const versions =
    input.baseVersion !== undefined && input.baseVersion !== current
      ? `drafted on v${input.baseVersion}, the policy is now v${current}`
      : `v${current} to v${current + 1}`;
  const rollback = pa.operation === "config.rollback";
  // The engine's facts first, the project's name last (titled, spec 40 M4b): a name can't push the
  // versions or what the change loosens off the prompt.
  const named = (facts: string) => titled(facts, project.name, "; project");
  const head = rollback
    ? `${verb}: roll the policy back to v${input.toVersion} (${versions})`
    : `${verb} a change to the policy (${versions})`;
  const before = current ? await storedVersion(ctx.db, project.id, current) : null;
  const target = rollback
    ? typeof input.toVersion === "number"
      ? (await storedVersion(ctx.db, project.id, input.toVersion))?.policy
      : undefined
    : (() => {
        const parsed = parseProjectPolicy(JSON.stringify(input.policy ?? null));
        return parsed.ok ? parsed.policy : undefined;
      })();
  if (!target) return named(`${head}: the change can't be read`);
  const impact = await impactOf(ctx.db, project, before?.policy ?? null, target, ctx.floor);
  const shown = impact.changes.filter((c) => c.class === impact.class).slice(0, SUMMARY_CHANGES);
  const rest = impact.changes.length - shown.length;
  const what = shown.map((c) => cleanText(c.summary).replace(/\.$/, "")).join("; ");
  return named(
    `${head}: ${impact.class}${what ? `: ${what}` : ""}${rest > 0 ? ` (+${rest} more)` : ""}`,
  );
}

/**
 * An org admin approves a project's existing looser override in one step (review of spec 52 (d2)):
 * the override the project already has, which the stricter org value overrides until approved (it
 * lapsed with an org change, or an org change made it looser). The approval counts for the org's
 * current version, as one given on a save does, and carries to later versions that leave the
 * setting's value unchanged. An override that isn't looser than the org's value has nothing to
 * approve.
 */
export const overrideApprove = defineOperation({
  name: "override.approve",
  description:
    "Approve a project's existing looser workflow override (spec 52, Q5/Q6): the value the project's config already sets for one stage setting, looser than the org workflow's, which the stricter org value replaces until an org admin approves it. Name the org config version you saw (`orgVersion`); a stale one is a conflict. Refused when the project has no such override or it isn't looser. Org admins only, in the app.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  // A policy decision (it lets a looser setting apply): made in the app (ADR 0340), never from the
  // CLI, MCP or a desktop device until a presence proof covers policy decisions.
  browserOnly: true,
  input: z.object({
    projectId,
    stageId: z.string().min(1).max(40),
    setting: z.string().min(1).max(40),
    orgVersion: z.number().int().positive(),
    note: z.string().max(2_000).optional(),
  }),
  output: z.object({ approved: z.boolean(), orgVersion: z.number(), value: z.unknown() }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    if (ctx.origin.surface !== "app" && ctx.origin.surface !== "test")
      throw new OperationError(
        "forbidden",
        `an override is approved in the app, not from ${ctx.origin.surface}`,
        { browserOnly: true },
      );
    const raw = ctx.scope.rawPolicy;
    if (!raw || !onOrgWorkflow(raw))
      throw new OperationError("invalid_input", "the project isn't on an org workflow");
    const { version, config } = await currentOrgConfig(ctx.db, project.org_id);
    if (version !== input.orgVersion)
      throw new OperationError(
        "conflict",
        `the org's workflows are at v${version}, not v${input.orgVersion}: look again before approving`,
      );
    const looser = normaliseOverrides(raw, config).looser.find(
      (l) => l.stageId === input.stageId && l.key === input.setting,
    );
    if (!looser)
      throw new OperationError(
        "invalid_input",
        `the project has no ${input.stageId} ${input.setting} override looser than the org's value: nothing to approve`,
      );
    // Guarded on the org still being at the version the admin saw.
    ctx.guardExists(
      "org config unchanged",
      ctx.db
        .selectFrom("core_organization")
        .select("id")
        .where("id", "=", project.org_id)
        .where("config_version", "=", version),
    );
    approveOverrides(ctx, project, { looser: [looser], orgVersion: version });
    ctx.change({
      entity: "project",
      id: project.id,
      after: {
        overrideApproved: { stage: input.stageId, setting: input.setting, value: looser.value },
        orgVersion: version,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    return { approved: true, orgVersion: version, value: looser.value };
  },
});
