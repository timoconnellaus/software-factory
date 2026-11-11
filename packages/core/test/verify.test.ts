import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  assemblePacket,
  checkOnlyDiff,
  checkRepoGuards,
  FACTORY_RULESET,
  FOREMAN,
  riskFlags,
  summarizeCi,
} from "../src/index.ts";
import { FAKE_APP } from "../src/testing/index.ts";
import { first, newItem, ok, refusal, rows, services, world } from "./helpers.ts";

const github = services.github;
const INTAKE = { type: "intake" as const, id: "github" };

const evidence = {
  summary: "Adds dark mode",
  criteria: [{ criterion: "A toggle switches themes", met: true, evidence: "test: theme.test.ts" }],
  checks: [{ name: "pnpm test", status: "pass" as const }],
  reviewer: { role: "review" as const, verdict: "approve" as const, notes: "Looks right" },
  riskFlags: [],
};

/** A work item at verify, with a pushed head on its branch and a PR, like the Workflow leaves it. */
async function atVerify(files: Parameters<typeof github.push>[3] = ["src/theme.ts"]) {
  const w = await world();
  const item = await newItem(w);
  const head = await github.push(
    w.repo,
    item.branch,
    (await github.state(w.repo)).refs.main,
    files,
  );
  const pr = await github.openPullRequest(w.repo, {
    head: item.branch,
    base: "main",
    title: "x",
    body: "",
  });
  await env.DB.prepare(
    "UPDATE core_work_items SET head_sha = ?, pr_number = ?, pr_url = ?, stage = 'verify' WHERE id = ?",
  )
    .bind(head, pr.number, pr.url, item.workItemId)
    .run();
  return { w, item, head, pr };
}

const record = (workItemId: string, headSha: string, extra: Record<string, unknown> = {}) =>
  ok<{
    verdict: string;
    ciState: string;
    reasons: string[];
    reviewPacketId: string;
    checkRunId: string;
  }>(
    "reviewPacket.record",
    { workItemId, headSha, ...evidence, verdict: "pass", ...extra },
    FOREMAN,
  );

const verifyCheck = async (repo: Parameters<typeof github.state>[0], sha: string) =>
  ((await github.state(repo)).checks?.[sha] ?? []).filter((c) => c.name === "factory/verify");

describe("CI and the packet (pure)", () => {
  it("summarises CI without counting the factory's own checks", () => {
    const run = (
      name: string,
      status: string,
      conclusion: string | null,
      appSlug = "github-actions",
    ) => ({ id: name, name, status, conclusion, appSlug, url: null }) as never;
    expect(summarizeCi([], "me").state).toBe("missing");
    expect(summarizeCi([run("factory/verify", "completed", "success", "me")], "me").state).toBe(
      "missing",
    );
    expect(summarizeCi([run("ci", "completed", "success")], "me").state).toBe("success");
    expect(
      summarizeCi([run("ci", "completed", "skipped"), run("e2e", "in_progress", null)], "me"),
    ).toMatchObject({
      state: "pending",
      pending: ["e2e"],
    });
    expect(
      summarizeCi([run("ci", "completed", "failure"), run("e2e", "queued", null)], "me"),
    ).toMatchObject({
      state: "failure",
      failing: ["ci"],
    });
  });

  it("flags auth, migrations, deps, .factory/ and permissions from the diff", () => {
    const flags = riskFlags([
      { path: "apps/app/src/auth/session.ts", status: "modified" },
      { path: "packages/db/migrations/0040_x.sql", status: "added" },
      { path: "pnpm-lock.yaml", status: "modified" },
      { path: ".factory/policy.json", status: "modified" },
      { path: ".github/workflows/ci.yml", status: "modified" },
      { path: "src/plain.ts", status: "modified" },
    ]);
    expect(flags.map((f) => f.kind)).toEqual([
      "factory-config",
      "permissions",
      "auth",
      "migrations",
      "deps",
    ]);
    expect(flags[0]?.message).toMatch(/self-modify.*\.factory\/policy\.json/);
    expect(riskFlags([{ path: "src/plain.ts", status: "modified" }])).toEqual([]);
  });

  it("passes only with green CI and a complete packet", () => {
    const green = summarizeCi(
      [
        {
          id: "1",
          name: "ci",
          status: "completed",
          conclusion: "success",
          appSlug: "x",
          url: null,
        },
      ],
      "me",
    );
    const base = {
      headSha: "a".repeat(40),
      evidence,
      ci: green,
      files: [],
      sameModelAsImplementer: false,
    };
    expect(assemblePacket(base).verdict).toBe("pass");
    const noReviewer = assemblePacket({ ...base, evidence: { ...evidence, reviewer: null } });
    expect(noReviewer.verdict).toBe("fail");
    expect(noReviewer.missing).toEqual(["no independent reviewer verdict"]);
    const noEvidence = assemblePacket({
      ...base,
      evidence: { ...evidence, criteria: [{ criterion: "c", met: true, evidence: " " }] },
    });
    expect(noEvidence.evidenceReasons).toEqual(['incomplete: no evidence for "c"']);
    const unmet = assemblePacket({
      ...base,
      evidence: { ...evidence, criteria: [{ criterion: "c", met: false, evidence: "no" }] },
    });
    expect(unmet.reasons).toContain("unmet: c");
    const same = assemblePacket({ ...base, sameModelAsImplementer: true });
    expect(same.verdict).toBe("pass");
    expect(same.warnings[0]).toMatch(/same model/);
    const noDiff = assemblePacket({ ...base, files: null });
    expect(noDiff.verdict).toBe("fail");
  });
});

describe("factory/verify check runs", () => {
  it("records a passing packet from green CI and posts a passing factory/verify for the head SHA", async () => {
    const { w, item, head } = await atVerify();
    const out = await record(item.workItemId, head);
    expect(out).toMatchObject({ verdict: "pass", ciState: "success", reasons: [] });
    const [check] = await verifyCheck(w.repo, head);
    expect(check).toMatchObject({
      status: "completed",
      conclusion: "success",
      appSlug: FAKE_APP.slug,
    });
    const row = await first<{ conclusion: string; review_packet_id: string; work_item_id: string }>(
      "SELECT conclusion, review_packet_id, work_item_id FROM core_verify_checks WHERE head_sha = ?",
      head,
    );
    expect(row).toMatchObject({
      conclusion: "success",
      review_packet_id: out.reviewPacketId,
      work_item_id: item.workItemId,
    });
  });

  it("fails the verdict when the runner reports green but CI is red (criterion 9)", async () => {
    const { w, item, head } = await atVerify();
    await github.setChecks(w.repo, head, [
      {
        name: "ci",
        status: "completed",
        conclusion: "failure",
        appSlug: "github-actions",
        url: null,
      },
    ]);
    const out = await record(item.workItemId, head);
    expect(out.verdict).toBe("fail");
    expect(out.reasons[0]).toMatch(/CI failing.*ci/);
    const packet = await first<{ verdict: string; sections: string }>(
      "SELECT verdict, sections FROM core_review_packets WHERE id = ?",
      out.reviewPacketId,
    );
    expect(packet.verdict).toBe("fail");
    expect(JSON.parse(packet.sections).verdict.warnings[0]).toMatch(/runner reported green/);
    expect((await verifyCheck(w.repo, head))[0]).toMatchObject({ conclusion: "failure" });
  });

  it("keeps the check pending while CI runs, and passes it when the check suite completes", async () => {
    const { w, item, head } = await atVerify();
    await github.setChecks(w.repo, head, [
      { name: "ci", status: "in_progress", conclusion: null, appSlug: "github-actions", url: null },
    ]);
    const out = await record(item.workItemId, head);
    expect(out).toMatchObject({ verdict: "fail", ciState: "pending" });
    expect((await verifyCheck(w.repo, head))[0]).toMatchObject({ status: "in_progress" });

    await github.setChecks(w.repo, head, [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        appSlug: "github-actions",
        url: null,
      },
    ]);
    const refreshed = await ok<{ outcome: string; conclusion: string }>(
      "verify.refresh",
      { repo: { owner: w.repo.owner, name: w.repo.repo }, headSha: head, trigger: "ci" },
      INTAKE,
    );
    expect(refreshed).toMatchObject({ outcome: "posted", conclusion: "success" });
    const checks = await verifyCheck(w.repo, head);
    expect(checks).toHaveLength(1); // updated in place, not posted twice
    expect(checks[0]).toMatchObject({ status: "completed", conclusion: "success" });
    // The Workflow waiting on CI for this SHA is woken.
    const events = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'workflow.event' AND instr(payload, ?) > 0",
      `ci-${item.workItemId}-${head}`,
    );
    expect(events).toHaveLength(1);
  });

  it("leaves a new push to the PR without a passing check until verify runs again (criterion 2)", async () => {
    const { w, item, head, pr } = await atVerify();
    await record(item.workItemId, head);
    const next = await github.push(w.repo, item.branch);
    const out = await ok<{ outcome: string; status: string; conclusion: string | null }>(
      "verify.refresh",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        headSha: next,
        prNumber: pr.number,
        trigger: "pull_request",
      },
      INTAKE,
    );
    expect(out).toMatchObject({ outcome: "posted", status: "completed", conclusion: "failure" });
    expect((await verifyCheck(w.repo, next))[0]).toMatchObject({ conclusion: "failure" });
    // The old SHA's check is untouched; it no longer describes the PR's head.
    expect((await verifyCheck(w.repo, head))[0]).toMatchObject({ conclusion: "success" });
  });

  it("fails factory/verify on a PR the factory didn't open (criterion 3)", async () => {
    const w = await world();
    const sha = await github.push(w.repo, "tim/local-change");
    const out = await ok<{ outcome: string; conclusion: string }>(
      "verify.refresh",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        headSha: sha,
        prNumber: 99,
        trigger: "pull_request",
      },
      INTAKE,
    );
    expect(out).toMatchObject({ outcome: "unattached", conclusion: "failure" });
    expect((await verifyCheck(w.repo, sha))[0]).toMatchObject({ conclusion: "failure" });
    // CI on an unknown commit with no PR is ignored.
    const other = await github.push(w.repo, "tim/other");
    const ignored = await ok<{ outcome: string }>(
      "verify.refresh",
      { repo: { owner: w.repo.owner, name: w.repo.repo }, headSha: other, trigger: "ci" },
      INTAKE,
    );
    expect(ignored.outcome).toBe("ignored");
  });

  it("flags a .factory/ diff and warns when review and implement resolve to the same model (criteria 5, 10)", async () => {
    const w = await world({
      version: 1,
      autonomyPolicy: "balanced",
      modelRoles: { review: "same-model", implement: "same-model" },
    });
    const item = await newItem(w);
    const head = await github.push(w.repo, item.branch, (await github.state(w.repo)).refs.main, [
      ".factory/policy.json",
    ]);
    await env.DB.prepare("UPDATE core_work_items SET head_sha = ? WHERE id = ?")
      .bind(head, item.workItemId)
      .run();
    const out = await record(item.workItemId, head);
    const packet = await first<{ risk_flags: string; reviewer: string; sections: string }>(
      "SELECT risk_flags, reviewer, sections FROM core_review_packets WHERE id = ?",
      out.reviewPacketId,
    );
    expect(JSON.parse(packet.risk_flags)[0]).toMatch(/self-modify/);
    expect(JSON.parse(packet.reviewer).sameModelAsImplementer).toBe(true);
    expect(JSON.parse(packet.sections).warnings[0]).toMatch(/same model/);
  });

  it("reads CI for the Workflow", async () => {
    const { w, item, head } = await atVerify();
    await github.setChecks(w.repo, head, [
      { name: "ci", status: "queued", conclusion: null, appSlug: "github-actions", url: null },
    ]);
    const ci = await ok<{ state: string }>(
      "ci.read",
      { workItemId: item.workItemId, headSha: head },
      FOREMAN,
    );
    expect(ci.state).toBe("pending");
  });
});

describe("the check-only auto-merge (ADR 0230)", () => {
  const OPT_IN = {
    version: 1,
    autonomyPolicy: "balanced",
    overrides: { agent: { "check-merge": "allow" } },
  };

  it("the rule: only added files under .factory/checks/ and evals/regressions/, with a regression case", () => {
    const add = (path: string) => ({ path, status: "added" as const });
    expect(
      checkOnlyDiff([add(".factory/checks/no-x.json"), add("evals/regressions/inc_1.json")]),
    ).toEqual({
      ok: true,
    });
    expect(checkOnlyDiff([add("evals/regressions/inc_1.json")]).ok).toBe(true);
    expect(checkOnlyDiff([add(".factory/checks/no-x.json")])).toMatchObject({
      ok: false,
      reason: /regression/,
    });
    expect(
      checkOnlyDiff([
        add("evals/regressions/a.json"),
        { path: ".factory/checks/old.json", status: "modified" },
      ]),
    ).toMatchObject({ ok: false, reason: /modified/ });
    expect(
      checkOnlyDiff([add("evals/regressions/a.json"), add(".factory/policy.json")]),
    ).toMatchObject({
      ok: false,
      reason: /outside/,
    });
    expect(checkOnlyDiff([add("evals/regressions/../../src/x.ts")]).ok).toBe(false);
    expect(checkOnlyDiff([add("evals/src/index.test.ts")]).ok).toBe(false);
    expect(checkOnlyDiff([]).ok).toBe(false);
  });

  async function incidentAtMerge(policy: unknown, files: Parameters<typeof github.push>[3]) {
    const w = await world(policy);
    const item = await newItem(w, "Factory incident: #1 was sent back");
    await env.DB.prepare("UPDATE core_work_items SET kind = 'incident' WHERE id = ?")
      .bind(item.workItemId)
      .run();
    const head = await github.push(
      w.repo,
      item.branch,
      (await github.state(w.repo)).refs.main,
      files,
    );
    const pr = await github.openPullRequest(w.repo, {
      head: item.branch,
      base: "main",
      title: "x",
      body: "",
    });
    await env.DB.prepare(
      "UPDATE core_work_items SET head_sha = ?, pr_number = ?, stage = 'merge' WHERE id = ?",
    )
      .bind(head, pr.number, item.workItemId)
      .run();
    return { w, item, head };
  }
  const CHECK_ONLY = [
    { path: ".factory/checks/no-console.json", status: "added" as const },
    { path: "evals/regressions/inc_1.json", status: "added" as const },
  ];

  it("merges an opted-in incident's check-only fix with green CI and a passing packet", async () => {
    const { w, item, head } = await incidentAtMerge(OPT_IN, CHECK_ONLY);
    await record(item.workItemId, head);
    const out = await ok<{ merged: boolean }>(
      "pr.autoMerge",
      { workItemId: item.workItemId, headSha: head },
      FOREMAN,
    );
    expect(out.merged).toBe(true);
    expect((await github.state(w.repo)).pulls[0]?.state).toBe("merged");
  });

  it("is denied without the project's opt-in (every autonomy policy denies check-merge)", async () => {
    const { item, head } = await incidentAtMerge(
      { version: 1, autonomyPolicy: "autonomous" },
      CHECK_ONLY,
    );
    await record(item.workItemId, head);
    const e = await refusal(
      ok("pr.autoMerge", { workItemId: item.workItemId, headSha: head }, FOREMAN),
    );
    expect(e.code).toBe("denied");
  });

  it("refuses a diff that touches policy, a non-incident item, red CI or a failed packet", async () => {
    const touchesPolicy = await incidentAtMerge(OPT_IN, [
      ...CHECK_ONLY,
      { path: ".factory/policy.json", status: "modified" },
    ]);
    await record(touchesPolicy.item.workItemId, touchesPolicy.head);
    const a = await refusal(
      ok(
        "pr.autoMerge",
        { workItemId: touchesPolicy.item.workItemId, headSha: touchesPolicy.head },
        FOREMAN,
      ),
    );
    expect(a.message).toMatch(/policy\.json/);

    const red = await incidentAtMerge(OPT_IN, CHECK_ONLY);
    await record(red.item.workItemId, red.head);
    await github.setChecks(red.w.repo, red.head, [
      {
        name: "ci",
        status: "completed",
        conclusion: "failure",
        appSlug: "github-actions",
        url: null,
      },
    ]);
    const b = await refusal(
      ok("pr.autoMerge", { workItemId: red.item.workItemId, headSha: red.head }, FOREMAN),
    );
    expect(b.message).toMatch(/CI is failure/);

    const noPacket = await incidentAtMerge(OPT_IN, CHECK_ONLY);
    const c = await refusal(
      ok("pr.autoMerge", { workItemId: noPacket.item.workItemId, headSha: noPacket.head }, FOREMAN),
    );
    expect(c.message).toMatch(/review packet/);

    const change = await incidentAtMerge(OPT_IN, CHECK_ONLY);
    await env.DB.prepare("UPDATE core_work_items SET kind = 'change' WHERE id = ?")
      .bind(change.item.workItemId)
      .run();
    const d = await refusal(
      ok("pr.autoMerge", { workItemId: change.item.workItemId, headSha: change.head }, FOREMAN),
    );
    expect(d.message).toMatch(/incident/);
    // None merged, and every refusal is in the journal.
    const audit = await rows<{ outcome: string }>(
      "SELECT outcome FROM core_audit WHERE operation = 'pr.autoMerge' AND work_item_id IN (?, ?, ?, ?)",
      touchesPolicy.item.workItemId,
      red.item.workItemId,
      noPacket.item.workItemId,
      change.item.workItemId,
    );
    expect(audit.map((r) => r.outcome)).toEqual(["failed", "failed", "failed", "failed"]);
  });
});

describe("project onboarding", () => {
  it("needs factory/verify pinned to the App, enforce_admins and the confining ruleset", async () => {
    const w = await world();
    const bad = await ok<{ ok: boolean; problems: string[] }>(
      "project.checkGitHub",
      { projectId: w.projectId },
      w.human,
    );
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual([
      "the default branch has no branch protection",
      "no active ruleset confines App pushes to factory/*",
    ]);
    const ruleset = {
      name: FACTORY_RULESET.name,
      enforcement: "active",
      include: [...FACTORY_RULESET.conditions.ref_name.include],
      exclude: [...FACTORY_RULESET.conditions.ref_name.exclude],
      rules: FACTORY_RULESET.rules.map((r) => r.type),
    };
    await github.setGuards(w.repo, {
      protection: {
        requiredChecks: [
          { context: "ci", appId: 15368 },
          { context: "factory/verify", appId: Number(FAKE_APP.id) },
        ],
        enforceAdmins: true,
      },
      rulesets: [ruleset],
    });
    const good = await ok<{ ok: boolean }>(
      "project.checkGitHub",
      { projectId: w.projectId },
      w.human,
    );
    expect(good).toEqual({ ok: true, problems: [] });
    expect(
      checkRepoGuards(
        {
          protection: {
            requiredChecks: [{ context: "factory/verify", appId: null }],
            enforceAdmins: false,
          },
          rulesets: [ruleset],
        },
        FAKE_APP.id,
      ).problems,
    ).toEqual([
      "factory/verify isn't pinned to the factory's App (1000); it is any source",
      "branch protection doesn't enforce admins",
    ]);
  });
});
