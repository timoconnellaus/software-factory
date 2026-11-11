// Protect `main` (ADR 0280): the generated ruleset files, the verifier against fixture rulesets,
// Check now, drift from a webhook (red + inbox card), and Setup's view.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_BRANCH_RULESET_NAME,
  defaultBranchRuleset,
  factoryBranchesRuleset,
  type RepoGuards,
  rulesetFile,
  verifyProtection,
} from "../src/index.ts";
import { asRulesetInfo, FAKE_APP, protectedGuards } from "../src/testing/index.ts";
import { first, ok, services, world } from "./helpers.ts";

const github = services.github;
const INTAKE = { type: "intake", id: "github" } as const;
const target = { appId: FAKE_APP.id };

/**
 * The ruleset schema GitHub's import and `POST /repos/{o}/{r}/rulesets` take (REST "Repository
 * rules"), strict so a typo'd or invented field fails.
 */
const pullRequestParams = z
  .object({
    required_approving_review_count: z.number().int().min(0).max(10),
    dismiss_stale_reviews_on_push: z.boolean(),
    require_code_owner_review: z.boolean(),
    require_last_push_approval: z.boolean(),
    required_review_thread_resolution: z.boolean(),
    allowed_merge_methods: z.array(z.enum(["merge", "squash", "rebase"])).min(1).optional(),
  })
  .strict();
const statusCheckParams = z
  .object({
    required_status_checks: z
      .array(z.object({ context: z.string(), integration_id: z.number().int().optional() }).strict())
      .min(1),
    strict_required_status_checks_policy: z.boolean(),
    do_not_enforce_on_create: z.boolean().optional(),
  })
  .strict();
const rule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pull_request"), parameters: pullRequestParams }).strict(),
  z.object({ type: z.literal("required_status_checks"), parameters: statusCheckParams }).strict(),
  z.object({ type: z.literal("non_fast_forward") }).strict(),
  z.object({ type: z.literal("deletion") }).strict(),
  z.object({ type: z.literal("creation") }).strict(),
  z.object({ type: z.literal("update") }).strict(),
]);
const rulesetSchema = z
  .object({
    name: z.string().min(1),
    target: z.enum(["branch", "tag", "push"]),
    enforcement: z.enum(["disabled", "active", "evaluate"]),
    bypass_actors: z.array(
      z
        .object({
          actor_id: z.number().int().nullable(),
          actor_type: z.enum([
            "Integration",
            "OrganizationAdmin",
            "RepositoryRole",
            "Team",
            "DeployKey",
            "User",
          ]),
          bypass_mode: z.enum(["always", "pull_request", "exempt"]),
        })
        .strict(),
    ),
    conditions: z
      .object({
        ref_name: z.object({ include: z.array(z.string()), exclude: z.array(z.string()) }).strict(),
      })
      .strict(),
    rules: z.array(rule),
  })
  .strict();

describe("the ruleset generator", () => {
  it("writes <repo>-default-branch.json in GitHub's ruleset schema", () => {
    const file = rulesetFile("default-branch", "software-factory", target);
    expect(file.filename).toBe("software-factory-default-branch.json");
    const parsed = rulesetSchema.parse(JSON.parse(file.json));
    expect(parsed).toMatchObject({
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    });
    expect(parsed.rules.map((r) => r.type).sort()).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]);
    const pr = parsed.rules.find((r) => r.type === "pull_request");
    expect(pr?.type === "pull_request" && pr.parameters.required_approving_review_count).toBe(0);
    const checks = parsed.rules.find((r) => r.type === "required_status_checks");
    expect(checks?.type === "required_status_checks" && checks.parameters).toEqual({
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: "ci" },
        { context: "factory/verify", integration_id: Number(FAKE_APP.id) },
      ],
    });
  });

  it("takes the policy's CI checks, and keeps the factory/* confinement as its own ruleset", () => {
    const custom = defaultBranchRuleset({ appId: "7", requiredChecks: ["build", "lint"] });
    const checks = custom.rules.find((r) => r.type === "required_status_checks");
    expect(
      (checks?.parameters as { required_status_checks: { context: string }[] })
        .required_status_checks,
    ).toEqual([
      { context: "build" },
      { context: "lint" },
      { context: "factory/verify", integration_id: 7 },
    ]);
    const confine = rulesetFile("factory-branches", "crm", target);
    expect(confine.filename).toBe("crm-factory-branches.json");
    expect(rulesetSchema.parse(JSON.parse(confine.json))).toEqual(factoryBranchesRuleset());
  });
});

describe("verifying protection", () => {
  const guards = (mutate: (g: RepoGuards) => void = () => {}) => {
    const g = protectedGuards();
    mutate(g);
    return g;
  };
  const verdict = (g: RepoGuards) => verifyProtection(g, "main", target);
  const mainRuleset = (g: RepoGuards) => {
    const r = g.rulesets[0];
    if (!r) throw new Error("no ruleset");
    return r;
  };
  const statusRule = (g: RepoGuards) => {
    const r = mainRuleset(g).rules.find((x) => x.type === "required_status_checks");
    return r?.parameters as {
      required_status_checks: { context: string; integration_id?: number }[];
      strict_required_status_checks_policy: boolean;
    };
  };

  it("passes the generated rulesets as imported", () => {
    expect(verdict(guards())).toEqual({ ok: true, problems: [], warnings: [], confined: true });
  });

  it("names a missing check", () => {
    const v = verdict(
      guards((g) => {
        const p = statusRule(g);
        p.required_status_checks = p.required_status_checks.filter((c) => c.context === "ci");
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(["`factory/verify` not required"]);
  });

  it("names factory/verify not pinned to the factory's App, and strict off", () => {
    const v = verdict(
      guards((g) => {
        const p = statusRule(g);
        p.required_status_checks = [{ context: "ci" }, { context: "factory/verify" }];
        p.strict_required_status_checks_policy = false;
      }),
    );
    expect(v.problems).toEqual([
      "`factory/verify` isn't pinned to the factory's App: any app could post it",
      "branches needn't be up to date before merging (strict checks off)",
    ]);
  });

  it("says bypass allowed for admins", () => {
    const v = verdict(
      guards((g) => {
        mainRuleset(g).bypassActors = [
          { actorType: "RepositoryRole", actorId: 5, bypassMode: "always" },
          { actorType: "OrganizationAdmin", actorId: null, bypassMode: "always" },
        ];
      }),
    );
    expect(v.problems).toEqual([
      `bypass allowed for admins, organization admins (ruleset \`${DEFAULT_BRANCH_RULESET_NAME}\`)`,
    ]);
  });

  it("warns, but passes, when GitHub doesn't show the bypass list", () => {
    const v = verdict(
      guards((g) => {
        mainRuleset(g).bypassActors = null;
      }),
    );
    expect(v.ok).toBe(true);
    expect(v.warnings[0]).toMatch(/couldn't see who may bypass/);
  });

  it("names a wrong target", () => {
    const v = verdict(
      guards((g) => {
        mainRuleset(g).include = ["refs/heads/release/**"];
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("`factory/verify` not required");
    expect(v.problems).toContain(
      `ruleset \`${DEFAULT_BRANCH_RULESET_NAME}\` doesn't apply to main (targets refs/heads/release/**)`,
    );
    const tags = verdict(
      guards((g) => {
        mainRuleset(g).target = "tag";
      }),
    );
    expect(tags.problems).toContain(
      `ruleset \`${DEFAULT_BRANCH_RULESET_NAME}\` targets tags, not the main branch`,
    );
  });

  it("names a ruleset in evaluate mode, force pushes and deletion", () => {
    const v = verdict(
      guards((g) => {
        mainRuleset(g).enforcement = "evaluate";
      }),
    );
    expect(v.problems).toEqual([
      "a pull request isn't required before merging",
      "`factory/verify` not required",
      "`ci` not required",
      "force pushes are allowed",
      "the branch can be deleted",
      `ruleset \`${DEFAULT_BRANCH_RULESET_NAME}\` is evaluate, not active`,
    ]);
  });

  it("asks for the confinement ruleset when it's missing", () => {
    const v = verdict(
      guards((g) => {
        g.rulesets = g.rulesets.slice(0, 1);
      }),
    );
    expect(v).toMatchObject({
      ok: false,
      confined: false,
      problems: ["no active ruleset confines the App's pushes to `factory/*`"],
    });
  });

  it("goes by GitHub's own rules in force when it has them (org rulesets included)", () => {
    const org = asRulesetInfo(defaultBranchRuleset(target), 99);
    const g: RepoGuards = {
      protection: { requiredChecks: [{ context: "ci", appId: 15368 }], enforceAdmins: true },
      rulesets: [asRulesetInfo(factoryBranchesRuleset(), 2), org],
      branchRules: org.rules.map((r) => ({ ...r, rulesetId: 99 })),
    };
    const v = verdict(g);
    expect(v.ok).toBe(true);
    // Classic protection still on: harmless, but worth saying.
    expect(v.warnings[0]).toMatch(/classic branch protection/);
    expect(verdict({ ...g, branchRules: [] }).ok).toBe(false);
  });
});

type Check = {
  state: string;
  previous: string | null;
  drifted: boolean;
  problems: string[];
};
type Inbox = {
  protection: { projectId: string; problems: string[]; files: { filename: string }[] }[];
};

describe("Check now and drift", () => {
  it("records ok, then a ruleset webhook that removes factory/verify turns it red with an inbox card", async () => {
    const w = await world();
    await github.setGuards(w.repo, protectedGuards());
    const first_ = await ok<Check>("protection.check", { projectId: w.projectId }, w.human);
    expect(first_).toMatchObject({ state: "ok", previous: null, drifted: false, problems: [] });
    let inbox = await ok<Inbox>("inbox.list", { orgId: w.orgId }, w.human);
    expect(inbox.protection).toEqual([]);

    // Someone edits the ruleset on GitHub: factory/verify is no longer required.
    const edited = protectedGuards();
    const rule = edited.rulesets[0]?.rules.find((r) => r.type === "required_status_checks");
    (rule?.parameters as { required_status_checks: { context: string }[] }).required_status_checks =
      [{ context: "ci" }];
    await github.setGuards(w.repo, edited);
    const observed = await ok<Check>(
      "protection.observe",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        event: "repository_ruleset",
        action: "edited",
      },
      INTAKE,
    );
    expect(observed).toMatchObject({
      state: "red",
      previous: "ok",
      drifted: true,
      problems: ["`factory/verify` not required"],
    });
    const row = await first<{ state: string; trigger: string }>(
      "SELECT state, trigger FROM core_project_protection WHERE project_id = ?",
      w.projectId,
    );
    expect(row).toEqual({ state: "red", trigger: "webhook" });
    const notified = await first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM core_outbox WHERE kind = 'notify' AND payload LIKE '%protection.changed%' AND payload LIKE ?",
      `%${w.userId}%`,
    );
    expect(notified.n).toBe(1);
    inbox = await ok<Inbox>("inbox.list", { orgId: w.orgId }, w.human);
    expect(inbox.protection).toEqual([
      expect.objectContaining({
        projectId: w.projectId,
        problems: ["`factory/verify` not required"],
        files: [{ kind: "default-branch", filename: `${w.repo.repo}-default-branch.json` }],
      }),
    ]);

    // Re-imported: green again, and the card goes away.
    await github.setGuards(w.repo, protectedGuards());
    expect(
      (await ok<Check>("protection.check", { projectId: w.projectId }, w.human)).state,
    ).toBe("ok");
    inbox = await ok<Inbox>("inbox.list", { orgId: w.orgId }, w.human);
    expect(inbox.protection).toEqual([]);
  });

  it("a project that was never green is red in Setup but raises no drift card", async () => {
    const w = await world();
    const r = await ok<Check>("protection.check", { projectId: w.projectId }, w.human);
    expect(r).toMatchObject({ state: "red", drifted: false });
    const inbox = await ok<Inbox>("inbox.list", { orgId: w.orgId }, w.human);
    expect(inbox.protection).toEqual([]);
  });

  it("serves the ruleset file and changes nothing on GitHub", async () => {
    const w = await world();
    const before = JSON.stringify(await github.repoGuards(w.repo, "main"));
    const file = await ok<{ filename: string; json: string }>(
      "protection.ruleset",
      { projectId: w.projectId, kind: "default-branch" },
      w.human,
    );
    expect(file.filename).toBe(`${w.repo.repo}-default-branch.json`);
    expect(rulesetSchema.safeParse(JSON.parse(file.json)).success).toBe(true);
    expect(JSON.stringify(await github.repoGuards(w.repo, "main"))).toBe(before);
  });
});

describe("Setup's Protect main step", () => {
  type Status = {
    steps: { key: string; done: boolean }[];
    missingEvents: string[];
    projects: {
      protection: {
        state: string;
        files: { kind: string; filename: string }[];
        rulesetsUrl: string;
        viewerIsRepoAdmin: boolean | null;
        adminMessage: string;
      } | null;
    }[];
  };

  it("offers the files, the deep link, and a message for the repo admin", async () => {
    const w = await world();
    let s = await ok<Status>("setup.status", { orgId: w.orgId }, w.human);
    const p = s.projects[0]?.protection;
    expect(p).toMatchObject({
      state: "red",
      rulesetsUrl: `https://github.com/${w.repo.owner}/${w.repo.repo}/settings/rules`,
      files: [
        { kind: "default-branch", filename: `${w.repo.repo}-default-branch.json` },
        { kind: "factory-branches", filename: `${w.repo.repo}-factory-branches.json` },
      ],
      // The world's person isn't a collaborator on the fake repo.
      viewerIsRepoAdmin: false,
    });
    expect(p?.adminMessage).toMatch(/Import a ruleset/);
    expect(p?.adminMessage).toMatch(/`factory\/verify`/);
    expect(s.missingEvents).toEqual([]);

    const login = (
      await first<{ github_login: string }>(
        "SELECT github_login FROM core_user WHERE id = ?",
        w.userId,
      )
    ).github_login;
    await github.setPermission(w.repo, login, "admin");
    github.setAppSettings({ events: ["push", "pull_request"], permissions: {} });
    try {
      s = await ok<Status>("setup.status", { orgId: w.orgId }, w.human);
    } finally {
      github.setAppSettings({
        events: ["push", "pull_request", "repository_ruleset", "branch_protection_rule"],
        permissions: {},
      });
    }
    expect(s.projects[0]?.protection?.viewerIsRepoAdmin).toBe(true);
    expect(s.missingEvents).toEqual(["repository_ruleset", "branch_protection_rule"]);
  });
});
