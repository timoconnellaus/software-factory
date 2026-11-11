// Protect `main` (ADR 0280). The factory generates the repository rulesets a project needs, in the
// JSON that GitHub's "Import a ruleset" button accepts, and verifies what GitHub reports against
// them. It never applies them: the App holds `administration: read` only, because write would let
// it delete repositories. The person applies the file; the factory checks it, now and on drift.
//
// Two rulesets:
//   <repo>-default-branch.json   the default branch: a PR, `ci` and `factory/verify` (pinned to the
//                                factory's App, strict), no force pushes, no deletion, no bypass.
//   <repo>-factory-branches.json the App may only create or update `factory/*` (ADR 0052 item 1).
import type { BranchRule, BypassActor, RepoGuards, RulesetInfo } from "../services.ts";
import { VERIFY_CHECK_NAME } from "./ci.ts";

/** The status checks a default branch requires besides `factory/verify`, unless the policy says. */
export const DEFAULT_REQUIRED_CHECKS = ["ci"] as const;
/** The name the default-branch ruleset gets on GitHub. */
export const DEFAULT_BRANCH_RULESET_NAME = "factory: protect the default branch";
/** The name of the push-confinement ruleset (ADR 0052). */
export const FACTORY_BRANCHES_RULESET_NAME = "factory: confine App pushes to factory/*";
/** The App events drift detection needs (also in connector-github's APP_REQUIREMENTS). */
export const PROTECTION_EVENTS = ["repository_ruleset", "branch_protection_rule"] as const;

/** GitHub's RepositoryRole actor ids, as its rulesets UI uses them. */
const REPOSITORY_ROLES: Record<number, string> = { 5: "admins", 4: "writers", 2: "maintainers" };

/** One ruleset in the shape GitHub's "Import a ruleset" (and `POST /repos/:o/:r/rulesets`) takes. */
export interface RulesetImport {
  name: string;
  target: "branch";
  enforcement: "active";
  bypass_actors: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: { type: string; parameters?: Record<string, unknown> }[];
}

export type RulesetKind = "default-branch" | "factory-branches";
export const RULESET_KINDS = ["default-branch", "factory-branches"] as const;

export interface ProtectionTarget {
  /** The factory's GitHub App id: `factory/verify` is pinned to it (ADR 0037). */
  appId: string;
  /** Checks required besides `factory/verify`. Default `ci`. */
  requiredChecks?: readonly string[];
}

/** The default branch's ruleset: what nothing may get past, admins included. */
export function defaultBranchRuleset(target: ProtectionTarget): RulesetImport {
  const checks = target.requiredChecks ?? DEFAULT_REQUIRED_CHECKS;
  const appId = Number(target.appId);
  return {
    name: DEFAULT_BRANCH_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    // Nobody bypasses: the merge gate is the factory's, and it applies to its owner too.
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          // The factory's review packet is the approval (ADR 0041); GitHub needs none of its own.
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["merge", "squash", "rebase"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            ...checks.filter((c) => c !== VERIFY_CHECK_NAME).map((context) => ({ context })),
            {
              context: VERIFY_CHECK_NAME,
              ...(Number.isFinite(appId) ? { integration_id: appId } : {}),
            },
          ],
        },
      },
    ],
  };
}

/** The push-confinement ruleset (ADR 0052 item 1): the App may only move `factory/*`. */
export function factoryBranchesRuleset(): RulesetImport {
  return {
    name: FACTORY_BRANCHES_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    // RepositoryRole 5 = admin: people keep pushing their own branches; the App is no bypass actor.
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    conditions: {
      ref_name: { include: ["~ALL"], exclude: ["refs/heads/factory/**", "~DEFAULT_BRANCH"] },
    },
    rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  };
}

/** The file a person downloads and imports: `<repo>-default-branch.json` and so on. */
export function rulesetFile(
  kind: RulesetKind,
  repoName: string,
  target: ProtectionTarget,
): { filename: string; ruleset: RulesetImport; json: string } {
  const ruleset =
    kind === "default-branch" ? defaultBranchRuleset(target) : factoryBranchesRuleset();
  const safe = repoName.replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    filename: `${safe}-${kind}.json`,
    ruleset,
    json: `${JSON.stringify(ruleset, null, 2)}\n`,
  };
}

/** GitHub's settings page where rulesets are created and imported. */
export function rulesetsUrl(repo: { owner: string; name: string }): string {
  return `https://github.com/${repo.owner}/${repo.name}/settings/rules`;
}

// ---- Verification -------------------------------------------------------------------------------

export interface ProtectionVerdict {
  ok: boolean;
  /** What's missing, precisely ("`factory/verify` not required", "bypass allowed for admins"). */
  problems: string[];
  /** What couldn't be confirmed or is worth knowing; never makes the verdict red. */
  warnings: string[];
  /** Whether the push-confinement ruleset (ADR 0052) is in force. */
  confined: boolean;
}

/** fnmatch as GitHub's ref_name conditions use it: `*` within a segment, `**` across them. */
function globMatches(pattern: string, ref: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(ref);
}

function refMatches(pattern: string, branch: string, isDefault: boolean): boolean {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return isDefault;
  return globMatches(pattern, `refs/heads/${branch}`);
}

/** Whether a ruleset's conditions select this branch (enforcement aside). */
export function rulesetSelects(r: RulesetInfo, branch: string, isDefault = true): boolean {
  if (r.target !== "branch") return false;
  if (!r.include.some((p) => refMatches(p, branch, isDefault))) return false;
  return !r.exclude.some((p) => refMatches(p, branch, isDefault));
}

/**
 * The rules in force on `branch`: GitHub's own answer (`GET /rules/branches/{branch}`, which also
 * covers org rulesets) when there is one, else computed from the repo's active rulesets.
 */
export function rulesInForce(guards: RepoGuards, branch: string): BranchRule[] {
  if (guards.branchRules) return guards.branchRules;
  return guards.rulesets
    .filter((r) => r.enforcement === "active" && rulesetSelects(r, branch))
    .flatMap((r) => r.rules.map((rule) => ({ ...rule, rulesetId: r.id })));
}

function describeActor(a: BypassActor, appId: string): string {
  switch (a.actorType) {
    case "RepositoryRole":
      return REPOSITORY_ROLES[a.actorId ?? -1] ?? `repository role ${a.actorId}`;
    case "OrganizationAdmin":
      return "organization admins";
    case "Integration":
      return String(a.actorId) === appId ? "the factory's App" : `an app (${a.actorId})`;
    case "DeployKey":
      return "deploy keys";
    case "Team":
      return `a team (${a.actorId})`;
    case "User":
      return `a user (${a.actorId})`;
    default:
      return a.actorType;
  }
}

interface StatusCheckParams {
  required_status_checks?: { context: string; integration_id?: number | null }[];
  strict_required_status_checks_policy?: boolean;
}

/**
 * Compares what GitHub reports for the default branch with the generated rulesets. Every missing
 * rule is its own problem, and a rule that only a ruleset with bypass actors provides counts as
 * missing for those actors ("bypass allowed for admins").
 */
export function verifyProtection(
  guards: RepoGuards,
  branch: string,
  target: ProtectionTarget,
): ProtectionVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  const checks = [
    ...(target.requiredChecks ?? DEFAULT_REQUIRED_CHECKS).filter((c) => c !== VERIFY_CHECK_NAME),
  ];
  const byId = new Map(guards.rulesets.map((r) => [r.id, r]));
  const rules = rulesInForce(guards, branch);

  // Each requirement: the rules in force that satisfy it. Bypass is judged per requirement: one
  // clean ruleset providing it is enough, whatever else also does.
  const bypassProblems = new Map<string, string>();
  const bypassUnknown = new Set<string>();
  const met = (providers: BranchRule[]): boolean => {
    if (!providers.length) return false;
    const sets = providers.map((p) => byId.get(p.rulesetId));
    if (sets.some((s) => s?.bypassActors && s.bypassActors.length === 0)) return true;
    const unknown = sets.filter((s) => !s || s.bypassActors === null);
    if (unknown.length) {
      for (const s of unknown) bypassUnknown.add(s ? `\`${s.name}\`` : "an organization ruleset");
      return true;
    }
    for (const s of sets) {
      if (!s?.bypassActors?.length) continue;
      const who = [...new Set(s.bypassActors.map((a) => describeActor(a, target.appId)))];
      bypassProblems.set(s.name, `bypass allowed for ${who.join(", ")} (ruleset \`${s.name}\`)`);
    }
    return true;
  };
  const ofType = (type: string) => rules.filter((r) => r.type === type);
  const statusRules = ofType("required_status_checks");
  const requiring = (context: string) =>
    statusRules.filter((r) =>
      ((r.parameters as StatusCheckParams | undefined)?.required_status_checks ?? []).some(
        (c) => c.context === context,
      ),
    );

  if (!met(ofType("pull_request"))) problems.push("a pull request isn't required before merging");

  const verifyRules = requiring(VERIFY_CHECK_NAME);
  if (!met(verifyRules)) {
    problems.push(`\`${VERIFY_CHECK_NAME}\` not required`);
  } else {
    const pins = verifyRules.flatMap((r) =>
      ((r.parameters as StatusCheckParams).required_status_checks ?? [])
        .filter((c) => c.context === VERIFY_CHECK_NAME)
        .map((c) => (c.integration_id == null ? null : String(c.integration_id))),
    );
    if (!pins.includes(target.appId)) {
      problems.push(
        pins.every((p) => p === null)
          ? `\`${VERIFY_CHECK_NAME}\` isn't pinned to the factory's App: any app could post it`
          : `\`${VERIFY_CHECK_NAME}\` is pinned to another app (${pins.filter(Boolean).join(", ")}), not the factory's (${target.appId})`,
      );
    }
    const strict = verifyRules.some(
      (r) => (r.parameters as StatusCheckParams).strict_required_status_checks_policy === true,
    );
    if (!strict) problems.push("branches needn't be up to date before merging (strict checks off)");
  }
  for (const c of checks) if (!met(requiring(c))) problems.push(`\`${c}\` not required`);
  if (!met(ofType("non_fast_forward"))) problems.push("force pushes are allowed");
  if (!met(ofType("deletion"))) problems.push("the branch can be deleted");
  problems.push(...bypassProblems.values());
  for (const s of bypassUnknown) {
    warnings.push(`couldn't see who may bypass ${s}: check it has no bypass list on GitHub`);
  }

  // Rulesets that look like ours but don't apply: the precise reason beats "not required".
  if (problems.length) {
    for (const r of guards.rulesets) {
      const ours =
        r.name === DEFAULT_BRANCH_RULESET_NAME ||
        r.rules.some(
          (x) =>
            x.type === "required_status_checks" &&
            ((x.parameters as StatusCheckParams | undefined)?.required_status_checks ?? []).some(
              (c) => c.context === VERIFY_CHECK_NAME,
            ),
        );
      if (!ours) continue;
      if (r.target !== "branch") {
        problems.push(`ruleset \`${r.name}\` targets ${r.target}s, not the ${branch} branch`);
      } else if (!rulesetSelects(r, branch)) {
        problems.push(
          `ruleset \`${r.name}\` doesn't apply to ${branch} (targets ${r.include.join(", ") || "nothing"}${r.exclude.length ? `, excluding ${r.exclude.join(", ")}` : ""})`,
        );
      } else if (r.enforcement !== "active") {
        problems.push(`ruleset \`${r.name}\` is ${r.enforcement}, not active`);
      }
    }
  }

  const confined = guards.rulesets.some(
    (r) =>
      r.enforcement === "active" &&
      r.target === "branch" &&
      r.include.includes("~ALL") &&
      r.exclude.includes("refs/heads/factory/**") &&
      ["creation", "update"].every((t) => r.rules.some((x) => x.type === t)),
  );
  if (!confined) problems.push("no active ruleset confines the App's pushes to `factory/*`");

  if (guards.protection) {
    warnings.push(
      `classic branch protection is also on ${branch}: the factory checks rulesets only, so import the ruleset; once it passes you can delete the classic rule (Settings → Branches)`,
    );
  }
  return { ok: problems.length === 0, problems, warnings, confined };
}
