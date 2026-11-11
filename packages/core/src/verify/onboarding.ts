// The project onboarding check (spec 04, ADR 0037, ADR 0052): before a repo joins the factory, its
// default branch must require `factory/verify` from the org's App with `enforce_admins` on, and an
// active ruleset must stop the App (any non-bypass actor) creating or updating branches outside
// `factory/*`. A repo that can't have these is refused.
import type { RepoGuards } from "../services.ts";
import { VERIFY_CHECK_NAME } from "./ci.ts";

/**
 * The repository ruleset that confines App pushes to `factory/*` (ADR 0052 item 1). Branches other
 * than `factory/**` and the default branch can't be created, updated or deleted except by repo
 * admins (people's own sessions); the default branch is guarded by branch protection instead, which
 * the App can only satisfy through a PR with `factory/verify`. Body for `POST /repos/:o/:r/rulesets`.
 */
export const FACTORY_RULESET = {
  name: "factory: confine App pushes to factory/*",
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: { include: ["~ALL"], exclude: ["refs/heads/factory/**", "~DEFAULT_BRANCH"] },
  },
  rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
  // RepositoryRole 5 = admin: people keep pushing their own branches; the App is not a bypass actor.
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
} as const;

export interface GuardProblems {
  ok: boolean;
  problems: string[];
}

export function checkRepoGuards(guards: RepoGuards, appId: string): GuardProblems {
  const problems: string[] = [];
  const p = guards.protection;
  if (!p) {
    problems.push("the default branch has no branch protection");
  } else {
    const verify = p.requiredChecks.find((c) => c.context === VERIFY_CHECK_NAME);
    if (!verify) problems.push(`branch protection doesn't require ${VERIFY_CHECK_NAME}`);
    else if (String(verify.appId) !== appId) {
      problems.push(
        `${VERIFY_CHECK_NAME} isn't pinned to the factory's App (${appId}); it is ${verify.appId ?? "any source"}`,
      );
    }
    if (!p.enforceAdmins) problems.push("branch protection doesn't enforce admins");
  }
  const confining = guards.rulesets.some(
    (r) =>
      r.enforcement === "active" &&
      r.include.includes("~ALL") &&
      r.exclude.includes("refs/heads/factory/**") &&
      ["creation", "update"].every((rule) => r.rules.includes(rule)),
  );
  if (!confining) problems.push("no active ruleset confines App pushes to factory/*");
  return { ok: problems.length === 0, problems };
}
