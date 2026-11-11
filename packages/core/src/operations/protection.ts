// Protect `main` (ADR 0280): the factory generates the default-branch ruleset, a person imports it on
// GitHub, and the factory checks it, on Check now, on GitHub's ruleset and branch-protection
// webhooks, and daily. The App has `administration: read` only; nothing here writes to GitHub.
import { z } from "zod";
import { defineOperation, type HandlerContext, type ProjectRow } from "../operation.ts";
import { loadPolicy } from "../scope.ts";
import {
  DEFAULT_REQUIRED_CHECKS,
  PROTECTION_EVENTS,
  type ProtectionTarget,
  type ProtectionVerdict,
  RULESET_KINDS,
  type RulesetKind,
  rulesetFile,
  rulesetsUrl,
  verifyProtection,
} from "../verify/protection.ts";
import { projectForRepo, projectId, repoName, repoRef, requireProject } from "./shared.ts";

/** How often the cron re-checks a project nothing else has re-checked. */
export const PROTECTION_RECHECK_MS = 24 * 3_600_000;

export const protectionState = z.enum(["ok", "red", "unknown"]);
export type ProtectionState = z.infer<typeof protectionState>;

export const protectionView = z.object({
  state: protectionState,
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The files to offer: the default-branch ruleset, and the confinement one when it's missing. */
  files: z.array(z.object({ kind: z.enum(RULESET_KINDS), filename: z.string() })),
  rulesetsUrl: z.string(),
  branch: z.string(),
  /** Whether the viewer is an admin of the repo; null when GitHub couldn't say. */
  viewerIsRepoAdmin: z.boolean().nullable(),
  /** A message for the repo's admin, when the viewer can't apply the ruleset themselves. */
  adminMessage: z.string(),
});
export type ProtectionView = z.infer<typeof protectionView>;

/** The project's protection target: the factory's App and the policy's CI checks. */
async function targetFor(
  ctx: Pick<HandlerContext, "db" | "services">,
  project: ProjectRow,
): Promise<ProtectionTarget> {
  const { policy } = await loadPolicy(ctx.db, project);
  return {
    appId: ctx.services.github.app.id,
    requiredChecks: policy?.protection.requiredChecks ?? DEFAULT_REQUIRED_CHECKS,
  };
}

/** Asks GitHub (read-only) and compares. Never throws: a failed read is `unknown`. */
export async function inspectProtection(
  ctx: Pick<HandlerContext, "db" | "services" | "scope">,
  project: ProjectRow,
): Promise<{ state: ProtectionState; verdict: ProtectionVerdict; target: ProtectionTarget }> {
  const target = await targetFor(ctx, project);
  try {
    const repo = await repoRef(ctx as HandlerContext, project);
    const guards = await ctx.services.github.repoGuards(repo, project.default_branch);
    const verdict = verifyProtection(guards, project.default_branch, target);
    return { state: verdict.ok ? "ok" : "red", verdict, target };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "unknown",
      verdict: {
        ok: false,
        problems: [`couldn't read the rulesets: ${message}`],
        warnings: [],
        confined: false,
      },
      target,
    };
  }
}

export function adminMessage(project: ProjectRow, target: ProtectionTarget, files: string[]) {
  const checks = [...(target.requiredChecks ?? DEFAULT_REQUIRED_CHECKS), "factory/verify"];
  const repo = `${project.repo_owner}/${project.repo_name}`;
  return [
    `Could you protect \`${project.default_branch}\` on ${repo}? It's for our software factory.`,
    "",
    `1. Open ${rulesetsUrl({ owner: project.repo_owner, name: project.repo_name })}`,
    `2. New ruleset → Import a ruleset → choose the attached ${files.join(" (then the same for ") + (files.length > 1 ? ")" : "")} → Create`,
    "",
    `It requires a pull request and the ${checks.map((c) => `\`${c}\``).join(" and ")} checks (branch up to date), and blocks force pushes and deleting the branch, with no bypass for anyone. The factory's GitHub App can only read repository settings, so it can't apply this itself.`,
  ].join("\n");
}

/** The view Setup and the inbox card show: verdict, files, deep link, who applies it. */
export async function protectionViewFor(
  ctx: Pick<HandlerContext, "db" | "services" | "scope" | "actor">,
  project: ProjectRow,
  inspected?: Awaited<ReturnType<typeof inspectProtection>>,
): Promise<ProtectionView> {
  const { state, verdict, target } = inspected ?? (await inspectProtection(ctx, project));
  const kinds: RulesetKind[] = verdict.confined
    ? ["default-branch"]
    : ["default-branch", "factory-branches"];
  const files = kinds.map((kind) => ({
    kind,
    filename: rulesetFile(kind, project.repo_name, target).filename,
  }));
  let viewerIsRepoAdmin: boolean | null = null;
  if (ctx.actor.type === "human") {
    const user = await ctx.db
      .selectFrom("core_user")
      .select("github_login")
      .where("id", "=", ctx.actor.id)
      .executeTakeFirst();
    if (user?.github_login) {
      try {
        const repo = await repoRef(ctx as HandlerContext, project);
        const role = await ctx.services.github.repoPermission(repo, user.github_login);
        viewerIsRepoAdmin = role === "admin";
      } catch {
        viewerIsRepoAdmin = null;
      }
    }
  }
  return {
    state,
    problems: verdict.problems,
    warnings: verdict.warnings,
    files,
    rulesetsUrl: rulesetsUrl({ owner: project.repo_owner, name: project.repo_name }),
    branch: project.default_branch,
    viewerIsRepoAdmin,
    adminMessage: adminMessage(
      project,
      target,
      files.map((f) => f.filename),
    ),
  };
}

/** The App events drift detection needs that the App isn't subscribed to (empty when unknown). */
export async function missingProtectionEvents(ctx: Pick<HandlerContext, "services">) {
  try {
    const settings = await ctx.services.github.appSettings();
    return PROTECTION_EVENTS.filter((e) => !settings.events.includes(e));
  } catch {
    return [];
  }
}

/**
 * Records a verdict. A red after an ok is drift: the org's owners and admins get a notification
 * and the inbox shows "Protection on `main` changed" until it's green again.
 */
async function record(
  ctx: HandlerContext,
  project: ProjectRow,
  state: ProtectionState,
  verdict: ProtectionVerdict,
  trigger: string,
): Promise<{ previous: ProtectionState | null; drifted: boolean }> {
  const prev = await ctx.db
    .selectFrom("core_project_protection")
    .selectAll()
    .where("project_id", "=", project.id)
    .executeTakeFirst();
  const previous = prev?.state ?? null;
  const changed = previous !== state;
  const lastOk = state === "ok" ? ctx.now : (prev?.last_ok_at ?? null);
  const row = {
    project_id: project.id,
    state,
    problems: JSON.stringify(verdict.problems),
    warnings: JSON.stringify(verdict.warnings),
    trigger,
    checked_at: ctx.now,
    changed_at: changed ? ctx.now : (prev?.changed_at ?? ctx.now),
    last_ok_at: lastOk,
  };
  ctx.write(
    ctx.db
      .insertInto("core_project_protection")
      .values(row)
      .onConflict((oc) =>
        oc.column("project_id").doUpdateSet({
          state: row.state,
          problems: row.problems,
          warnings: row.warnings,
          trigger: row.trigger,
          checked_at: row.checked_at,
          changed_at: row.changed_at,
          last_ok_at: row.last_ok_at,
        }),
      ),
  );
  if (changed) {
    ctx.change({
      entity: "project_protection",
      id: project.id,
      before: prev ? { state: prev.state } : null,
      after: { state, problems: verdict.problems },
    });
  }
  // Drift: it was green once, and now it's red.
  const drifted = state === "red" && previous === "ok";
  if (drifted) {
    const admins = await ctx.db
      .selectFrom("core_member")
      .select("user_id")
      .where("organization_id", "=", project.org_id)
      .where("role", "in", ["owner", "admin"])
      .execute();
    for (const a of admins) {
      ctx.emit({
        kind: "notify",
        payload: {
          event: "protection.changed",
          userId: a.user_id,
          title: `Protection on ${project.default_branch} changed: ${project.repo_owner}/${project.repo_name}`,
          url: "/setup",
        },
      });
    }
  }
  return { previous, drifted };
}

const checkOutput = z.object({
  state: protectionState,
  previous: protectionState.nullable(),
  drifted: z.boolean(),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
});

async function checkAndRecord(ctx: HandlerContext, trigger: string) {
  const project = requireProject(ctx);
  const { state, verdict } = await inspectProtection(ctx, project);
  const { previous, drifted } = await record(ctx, project, state, verdict, trigger);
  return { state, previous, drifted, problems: verdict.problems, warnings: verdict.warnings };
}

export const protectionRuleset = defineOperation({
  name: "protection.ruleset",
  description:
    "The ruleset file for a project, in the JSON GitHub's New ruleset → Import a ruleset accepts (ADR 0280): `default-branch` (a PR, `ci` and `factory/verify` pinned to the factory's App with the branch up to date, no force pushes, no deletion, no bypass) or `factory-branches` (the App may only create or update `factory/*`, ADR 0052). The factory never applies it: its App can only read repository settings.",
  risk: "read",
  actors: ["human", "agent"],
  permission: "member",
  bootstrapsPolicy: true,
  input: z.object({ projectId, kind: z.enum(RULESET_KINDS).default("default-branch") }),
  output: z.object({ filename: z.string(), json: z.string() }),
  async handler(input, ctx) {
    const project = requireProject(ctx);
    const file = rulesetFile(input.kind, project.repo_name, await targetFor(ctx, project));
    return { filename: file.filename, json: file.json };
  },
});

export const protectionCheck = defineOperation({
  name: "protection.check",
  description:
    "Check now (ADR 0280): read the project's rulesets and the rules in force on its default branch from GitHub (the App's read-only access) and compare them with the generated ruleset. Records the verdict: `ok`, or `red` with exactly what's missing (e.g. \"`factory/verify` not required\", \"bypass allowed for admins\"). A red after an ok is drift: it notifies the org's admins and shows in the inbox. Changes nothing on GitHub.",
  // It records the verdict (a factory row); GitHub is only read.
  risk: "write",
  actors: ["human"],
  permission: "member",
  // A check must work before a policy lands and while a kill switch is on (it's how a person sees
  // the branch is safe again).
  bootstrapsPolicy: true,
  allowWhenKilled: true,
  input: z.object({ projectId }),
  output: checkOutput,
  async handler(_input, ctx) {
    return checkAndRecord(ctx, "setup");
  },
});

export const protectionObserve = defineOperation({
  name: "protection.observe",
  description:
    'The GitHub connector saw a `repository_ruleset` or `branch_protection_rule` event, or the daily re-check came round (`event: "daily"`): re-check the project\'s default-branch protection (as protection.check) and record the verdict, so a ruleset changed or deleted on GitHub turns Setup red and raises the inbox card.',
  risk: "write",
  actors: ["intake"],
  permission: "signed-in",
  bootstrapsPolicy: true,
  allowWhenKilled: true,
  input: z.object({ repo: repoName, event: z.string().max(100), action: z.string().max(100) }),
  output: checkOutput,
  scope: async (input, db) => ({ projectId: await projectForRepo(db, input.repo) }),
  async handler(input, ctx) {
    return checkAndRecord(ctx, input.event === "daily" ? "daily" : "webhook");
  },
});

/** Projects with a red verdict after an ok one (drift), in these orgs: the inbox cards. */
export async function protectionDrift(ctx: Pick<HandlerContext, "db">, orgIds: string[]) {
  if (!orgIds.length) return [];
  return ctx.db
    .selectFrom("core_project_protection")
    .innerJoin("core_projects", "core_projects.id", "core_project_protection.project_id")
    .select([
      "core_projects.id as projectId",
      "core_projects.name as name",
      "core_projects.repo_owner as owner",
      "core_projects.repo_name as repo",
      "core_projects.default_branch as branch",
      "core_project_protection.problems as problems",
      "core_project_protection.changed_at as changedAt",
    ])
    .where("core_projects.org_id", "in", orgIds)
    .where("core_project_protection.state", "=", "red")
    .where("core_project_protection.last_ok_at", "is not", null)
    .execute();
}

/** Whether policy blocks build work on this project now (`protection.onRed: "block"` and red). */
export async function protectionBlocksBuild(
  ctx: Pick<HandlerContext, "db">,
  projectIdValue: string,
  onRed: "warn" | "block" | undefined,
): Promise<string | null> {
  if (onRed !== "block") return null;
  const row = await ctx.db
    .selectFrom("core_project_protection")
    .select(["state"])
    .where("project_id", "=", projectIdValue)
    .executeTakeFirst();
  return row?.state === "red" ? PROTECTION_WAIT_REASON : null;
}

/** The queued reason while policy blocks builds on red protection. */
export const PROTECTION_WAIT_REASON = "default-branch protection is red";
