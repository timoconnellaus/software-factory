// Test helpers for packages that build on core: a fake GitHub App and fake services.
import { r2AttachmentBlobs } from "../attachments.ts";
import type { FactoryServices, RepoGuards, RulesetInfo } from "../services.ts";
import {
  defaultBranchRuleset,
  factoryBranchesRuleset,
  type RulesetImport,
} from "../verify/protection.ts";
import { FAKE_APP, type FakeGitHub, fakeGitHub } from "./fake-github.ts";

export { HELPER_MAX_SUMMARY, keyHelperRefusal } from "./key-helper.ts";

const FAKE_APP_ID = FAKE_APP.id;

export {
  FAKE_APP,
  type FakeGitHub,
  type FakeInstallation,
  fakeGitHub,
  fakeUserToken,
} from "./fake-github.ts";

/**
 * Services for tests: the D1-backed fake GitHub, a runner key derived without a real secret, and
 * attachment storage on the given (real, workerd) R2 binding when there is one.
 */
export function fakeServices(
  d1: D1Database,
  attachments?: R2Bucket,
): FactoryServices & { github: FakeGitHub } {
  return {
    github: fakeGitHub(d1),
    ...(attachments ? { attachments: r2AttachmentBlobs(attachments) } : {}),
    runnerKey: async (runnerId, version) => `test-key:${runnerId}:v${version}`,
  };
}

/** A ruleset import, as GitHub would report it back once applied. */
export function asRulesetInfo(ruleset: RulesetImport, id: number): RulesetInfo {
  return {
    id,
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    include: [...ruleset.conditions.ref_name.include],
    exclude: [...ruleset.conditions.ref_name.exclude],
    rules: ruleset.rules.map((r) => ({ ...r })),
    bypassActors: ruleset.bypass_actors.map((a) => ({
      actorType: a.actor_type,
      actorId: a.actor_id,
      bypassMode: a.bypass_mode,
    })),
  };
}

/** A repo with both generated rulesets imported as-is: what Check now accepts. */
export function protectedGuards(appId: string = FAKE_APP_ID): RepoGuards {
  return {
    protection: null,
    rulesets: [
      asRulesetInfo(defaultBranchRuleset({ appId }), 1),
      asRulesetInfo(factoryBranchesRuleset(), 2),
    ],
    branchRules: null,
  };
}
