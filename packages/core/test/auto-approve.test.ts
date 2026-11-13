// Dark factory mode (ADR 0515, spec 52 build step (e)): the five conditions in code, the built-in
// self-modify exclusion, the setting's impact, and the path through the adjudicator to an approval
// no person made, which only the conditions allow.
import { describe, expect, it } from "vitest";
import {
  type Actor,
  AUTO_APPROVE_OFF,
  type AutoApproveFacts,
  autoApproveImpact,
  autoApproveSettings,
  autoApproveVerdict,
  BABYSITTER,
  globMatch,
  lockWithoutManifest,
  SELF_MODIFY_PATHS,
} from "../src/index.ts";
import { SOFTWARE, type WorkflowDefinition } from "../src/stages/index.ts";
import {
  call,
  FOREMAN,
  first,
  newItem,
  ok,
  POLICY,
  refusal,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

const ALLOW = [
  "src/**",
  "docs/**",
  "assets/**",
  "apps/**",
  "packages/**",
  "vendor/**",
  "evals/**",
  "infra/**",
  "*.*",
  ".*",
  ".*/**",
];
const ON = autoApproveSettings.parse({ enabled: true, allowPaths: ALLOW });
const good = (): AutoApproveFacts => ({
  headSha: "a".repeat(40),
  packet: {
    verdict: "pass",
    ci: "success",
    criteriaProven: true,
    specByPerson: true,
    weakened: false,
    testsIntact: true,
  },
  adjudicator: { active: true, eligible: true, approved: true },
  changes: [
    { path: "src/theme.ts", changes: 20 },
    { path: "src/theme.test.ts", changes: 30 },
  ],
  hold: null,
  touchesFactoryConfig: false,
  versionSupports: true,
});
const failing = (f: AutoApproveFacts, s = ON) =>
  autoApproveVerdict(f, s)
    .conditions.filter((c) => !c.ok)
    .map((c) => c.id);

describe("autoApproveVerdict: every condition, in code", () => {
  it("approves only when the setting is on and all five conditions hold", () => {
    const v = autoApproveVerdict(good(), ON);
    expect(v.approve).toBe(true);
    expect(v.reason).toBe("auto-approved: every condition held");
    expect(autoApproveVerdict(good(), AUTO_APPROVE_OFF).approve).toBe(false);
  });

  it("each condition alone sends the merge to a person", () => {
    const cases: [string, (f: AutoApproveFacts) => void][] = [
      ["hold", (f) => (f.hold = "an incident")],
      [
        "checks",
        (f) => (f.packet = { ...(f.packet as NonNullable<typeof f.packet>), verdict: "fail" }),
      ],
      [
        "checks",
        (f) => (f.packet = { ...(f.packet as NonNullable<typeof f.packet>), ci: "pending" }),
      ],
      [
        "checks",
        (f) =>
          (f.packet = {
            ...(f.packet as NonNullable<typeof f.packet>),
            criteriaProven: false,
          }),
      ],
      [
        "checks",
        (f) =>
          (f.packet = {
            ...(f.packet as NonNullable<typeof f.packet>),
            weakened: true,
          }),
      ],
      ["limits", (f) => (f.today = 10)],
      ["version", (f) => (f.versionSupports = false)],
      [
        "checks",
        (f) => (f.packet = { ...(f.packet as NonNullable<typeof f.packet>), specByPerson: false }),
      ],
      ["risk", (f) => (f.changes = [{ path: "vendor/lib", changes: 1, submodule: true }])],
      ["risk", (f) => (f.changes = [{ path: "packages/core/package.json", changes: 1 }])],
      ["risk", (f) => (f.changes = [{ path: "apps/engine/tsconfig.json", changes: 1 }])],
      ["risk", (f) => (f.changes = [{ path: "apps/desktop/electrobun.config.ts", changes: 1 }])],
      ["risk", (f) => (f.changes = [{ path: "apps/desktop/native/sf-keys.swift", changes: 1 }])],
      ["risk", (f) => (f.changes = [{ path: "apps/desktop/scripts/release.sh", changes: 1 }])],
      [
        "risk",
        (f) => {
          f.factorySource = true;
          f.changes = [{ path: "docs/specs/x.md", changes: 1 }];
        },
      ],
      ["risk", (f) => (f.changes = [{ path: "assets/logo.png", changes: 0, unreadable: true }])],
      ["risk", (f) => (f.changes = [{ path: "apps/app/src/routeTree.gen.ts", changes: 3 }])],
      ["risk", (f) => (f.changes = [{ path: ".gitmodules", changes: 3 }])],
      ["risk", (f) => (f.changes = [{ path: "src/StripeWebhook.ts", changes: 3 }])],
      ["risk", (f) => (f.changes = [{ path: "evals/regressions/x.json", changes: 3 }])],
      ["risk", (f) => (f.changes = [{ path: "infra/main.tf", changes: 3 }])],
      ["checks", (f) => (f.packet = null)],
      [
        "tests",
        (f) => (f.packet = { ...(f.packet as NonNullable<typeof f.packet>), testsIntact: false }),
      ],
      ["adjudicator", (f) => (f.adjudicator = { active: false, eligible: true, approved: true })],
      ["adjudicator", (f) => (f.adjudicator = { active: true, eligible: false, approved: true })],
      ["adjudicator", (f) => (f.adjudicator = { active: true, eligible: true, approved: false })],
      [
        "limits",
        (f) =>
          (f.changes = Array.from({ length: 11 }, (_, i) => ({
            path: `src/f${i}.ts`,
            changes: 1,
          }))),
      ],
      ["limits", (f) => (f.changes = [{ path: "src/big.ts", changes: 201 }])],
      ["limits", (f) => (f.changes = [{ path: "src/x.ts", changes: null }])],
      ["risk", (f) => (f.changes = [{ path: "packages/db/migrations/0400_x.sql", changes: 5 }])],
      ["risk", (f) => (f.changes = [{ path: "src/auth/session.ts", changes: 5 }])],
      ["risk", (f) => (f.changes = [{ path: ".github/workflows/ci.yml", changes: 5 }])],
      ["risk", (f) => (f.changes = [{ path: "pnpm-lock.yaml", changes: 5 }])],
      ["risk", (f) => (f.touchesFactoryConfig = true)],
    ];
    for (const [id, change] of cases) {
      const f = good();
      change(f);
      expect(failing(f), id).toContain(id);
      expect(autoApproveVerdict(f, ON).approve, id).toBe(false);
    }
    // Unreadable changes fail both size and risk: nothing is assumed.
    const unread = good();
    unread.changes = null;
    expect(failing(unread)).toEqual(["risk", "limits"]);
  });

  it("a change to the factory itself is never auto-approved, whatever the workflow's lists say", () => {
    for (const path of [
      ".factory/policy.json",
      "packages/core/src/policy/gate.ts",
      "packages/core/src/registry.ts",
      "packages/core/src/operations/gates.ts",
      "packages/core/src/stages/types/publish.ts",
      "apps/engine/src/workflow/work-item.ts",
      "AGENTS.md",
      "docs/adr/0515-x.md",
    ]) {
      const f = { ...good(), changes: [{ path, changes: 1 }] };
      const v = autoApproveVerdict(f, { ...ON, riskPaths: [], forbiddenPaths: [] });
      expect(v.approve, path).toBe(false);
      expect(v.reason, path).toMatch(/factory itself|risk path/);
    }
    // The setting has no field that could take a path off the built-in list.
    expect(Object.keys(autoApproveSettings.parse({})).sort()).toEqual(
      [
        "allowPaths",
        "enabled",
        "forbiddenPaths",
        "maxChangedLines",
        "maxFiles",
        "maxPerDay",
        "riskPaths",
      ].sort(),
    );
    expect(SELF_MODIFY_PATHS).toContain(".factory/**");
  });

  it("on the factory's own repository only the allow-list is auto-approved", () => {
    const f = {
      ...good(),
      factorySource: true,
      changes: [{ path: "docs/design/x.html", changes: 3 }],
    };
    expect(autoApproveVerdict(f, ON).approve).toBe(true);
    const off = { ...f, changes: [{ path: "docs/architecture.md", changes: 3 }] };
    expect(autoApproveVerdict(off, ON).reason).toMatch(/factory's own repository/);
  });

  it("every path must be inside allowPaths; none set, nothing qualifies; it can't be turned on without them", () => {
    const f = { ...good(), changes: [{ path: "lib/x.ts", changes: 3 }] };
    expect(autoApproveVerdict(f, ON).reason).toMatch(/outside allowPaths: lib\/x.ts/);
    expect(autoApproveVerdict(good(), { ...ON, allowPaths: [] }).approve).toBe(false);
    expect(autoApproveSettings.safeParse({ enabled: true }).success).toBe(false);
    // A rename touches where it came from too: the compare's previousPath is checked (operations).
  });

  it("manifests, build scripts, CI, deploy, hooks and agent files in any ecosystem are refused twice", () => {
    for (const path of [
      "requirements.txt",
      "pyproject.toml",
      "go.mod",
      "Cargo.toml",
      "Gemfile",
      "build.gradle",
      "esbuild.mjs",
      "build.mjs",
      "Jenkinsfile",
      "azure-pipelines.yml",
      ".buildkite/pipeline.yml",
      "bitbucket-pipelines.yml",
      "vercel.json",
      "netlify.toml",
      "fly.toml",
      "Procfile",
      ".husky/pre-commit",
      ".cursorrules",
      "GEMINI.md",
      ".windsurfrules",
    ]) {
      const f = { ...good(), changes: [{ path, changes: 1 }] };
      // By the floor, even where allowPaths would allow it.
      expect(failing(f, { ...ON, allowPaths: ["**"] }), path).toContain("risk");
      // And by allowPaths, which names only the places a change may touch.
      expect(failing(f, { ...ON, allowPaths: ["src/**"] }), path).toContain("limits");
    }
  });

  it("widening allowPaths loosens; narrowing tightens", () => {
    const a = { ...ON, allowPaths: ["src/**"] };
    const b = { ...ON, allowPaths: ["src/**", "lib/**"] };
    expect(autoApproveImpact(a, b, "m").map((c) => c.class)).toEqual(["loosens"]);
    expect(autoApproveImpact(b, a, "m").map((c) => c.class)).toEqual(["tightens"]);
  });

  it("the workflow's own lists add to the floor", () => {
    const f = { ...good(), changes: [{ path: "src/payments-ui/x.ts", changes: 1 }] };
    expect(autoApproveVerdict(f, ON).approve).toBe(true);
    expect(autoApproveVerdict(f, { ...ON, riskPaths: ["src/payments-ui/**"] }).approve).toBe(false);
    expect(autoApproveVerdict(f, { ...ON, forbiddenPaths: ["src/**"] }).reason).toMatch(
      /forbidden/,
    );
  });

  it("globs and lock files", () => {
    expect(globMatch("**/migrations/**", "packages/db/migrations/0001.sql")).toBe(true);
    expect(globMatch("**/*.sql", "x.sql")).toBe(true);
    expect(globMatch(".github/**", ".GitHub/workflows/ci.yml")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(lockWithoutManifest(["pnpm-lock.yaml"])).toEqual(["pnpm-lock.yaml"]);
    expect(lockWithoutManifest(["pnpm-lock.yaml", "package.json"])).toEqual([]);
    expect(lockWithoutManifest(["apps/x/package-lock.json", "apps/x/package.json"])).toEqual([]);
  });

  it("turning it on, raising a limit or dropping a path loosens; the reverse tightens", () => {
    const cls = (a: typeof ON, b: typeof ON) =>
      autoApproveImpact(a, b, "merge.autoApprove").map((c) => c.class);
    expect(cls(AUTO_APPROVE_OFF, ON)).toEqual(["loosens", "loosens"]);
    expect(cls(ON, AUTO_APPROVE_OFF)).toEqual(["tightens", "tightens"]);
    expect(cls(ON, { ...ON, maxFiles: 20 })).toEqual(["loosens"]);
    expect(cls(ON, { ...ON, maxChangedLines: 100 })).toEqual(["tightens"]);
    expect(cls({ ...ON, riskPaths: ["a/**"] }, ON)).toEqual(["loosens"]);
    expect(cls(ON, { ...ON, forbiddenPaths: ["b/**"] })).toEqual(["tightens"]);
  });
});

// ---- Through the operations ----

type W = Awaited<ReturnType<typeof world>>;
const IMPROVER: Actor = { type: "self-improve", id: "improver" };
const github = services.github;

const DARK: WorkflowDefinition = {
  ...SOFTWARE,
  id: "wf_dark",
  name: "Dark",
  template: { id: SOFTWARE.id, version: 1 },
  stages: SOFTWARE.stages.map((s) =>
    s.id === "merge"
      ? {
          ...s,
          settings: {
            ...(s.settings as object),
            autoApprove: { enabled: true, allowPaths: ["src/**", "docs/**"] },
          },
        }
      : s,
  ),
};

async function approveIfPending(w: W, r: Awaited<ReturnType<typeof call>>) {
  if (r.status === "pending")
    await ok(
      "approval.decide",
      { pendingActionId: r.pendingActionId, decision: "approved" },
      w.human,
    );
}

async function saveConfig(w: W, policy: Record<string, unknown>) {
  const got = await ok<{ current: { version: number } | null }>(
    "config.get",
    { projectId: w.projectId },
    w.human,
  );
  return call(
    "config.save",
    { projectId: w.projectId, baseVersion: got.current?.version ?? 0, policy },
    w.human,
  );
}

/** The adjudicator's record on this project's merge gates: 20 approvals a person agreed with. */
async function earned(w: W) {
  const now = new Date().toISOString();
  for (let i = 0; i < 20; i++) {
    const pa = uid("pa_");
    await rows(
      `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, kind, operation, risk, actor_type, actor_id, input, status, decision, decided_by, created_at, decided_at)
       VALUES (?, ?, ?, 'wi_x', 'merge', 'pr.merge', 'merge', 'agent', 'foreman', '{}', 'approved', 'approved', ?, ?, ?)`,
      pa,
      w.orgId,
      w.projectId,
      w.userId,
      now,
      now,
    );
    await rows(
      `INSERT INTO core_adjudications (id, pending_action_id, project_id, work_item_id, kind, mode, job_id, verdict, reason, acted, created_at, decided_at)
       VALUES (?, ?, ?, 'wi_x', 'merge', 'shadow', ?, 'approve', 'fine', 0, ?, ?)`,
      uid("adj_"),
      pa,
      w.projectId,
      uid("job_"),
      now,
      now,
    );
  }
}

/** A project on the Dark workflow, the adjudicator active for merges. */
async function dark(w: W, extra: Record<string, unknown> = {}) {
  await approveIfPending(
    w,
    await call("workflow.save", { orgId: w.orgId, baseVersion: 0, workflow: DARK }, w.human),
  );
  await earned(w);
  await approveIfPending(
    w,
    await saveConfig(w, {
      ...POLICY,
      workflow: DARK.id,
      adjudicator: { merge: "active" },
      ...extra,
    }),
  );
}

/** An item at its merge gate on a pushed head, with a packet; the adjudicator approves it. */
async function atMergeGate(
  w: W,
  opts: {
    files?: { path: string; status: "modified"; patch: string; changes: number }[];
    packet?: Record<string, unknown>;
    verdict?: "approve" | "defer";
    /** Runs once the item has pinned its org version, before the gate is decided. */
    meanwhile?: () => Promise<void>;
    /** Who approved the item's spec: a person (default) or the adjudicator. */
    specBy?: "person" | "adjudicator";
    /** The item's Workflow version (default: one with dark factory mode). */
    workflowVersion?: number;
    noAssignee?: boolean;
  } = {},
) {
  const item = await newItem(w, uid("dark "));
  await rows(
    "UPDATE core_work_items SET workflow_version = ? WHERE id = ?",
    opts.workflowVersion ?? 14,
    item.workItemId,
  );
  const at = new Date().toISOString();
  await rows(
    `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, kind, operation, risk, actor_type, actor_id, input, status, decision, decided_by, created_at, decided_at)
     VALUES (?, ?, ?, ?, 'spec', 'spec.accept', 'write', 'agent', 'foreman', '{}', 'approved', 'approved', ?, ?, ?)`,
    uid("pa_spec"),
    w.orgId,
    w.projectId,
    item.workItemId,
    opts.specBy === "adjudicator" ? "improver" : w.userId,
    at,
    at,
  );
  await opts.meanwhile?.();
  const base = (await github.getBranchSha(w.repo, "main")) ?? undefined;
  const head = await github.push(
    w.repo,
    item.branch,
    base,
    opts.files ?? [
      { path: "src/theme.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 40 },
    ],
  );
  await rows(
    "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, sections, created_at) VALUES (?, ?, ?, 'pass', ?, ?)",
    uid("rp_"),
    item.workItemId,
    head,
    JSON.stringify(
      opts.packet ?? {
        ci: { state: "success" },
        proof: [
          { criterion: "a", proven: true, linkedBy: "spec", provenBy: ["t"] },
          { criterion: "b", proven: true, linkedBy: "spec", provenBy: ["t"] },
        ],
        proven: { proven: 2, total: 2 },
        testsIntact: { intact: true },
      },
    ),
    new Date().toISOString(),
  );
  const gate = await call(
    "pr.merge",
    { workItemId: item.workItemId, headSha: head, touchesFactoryConfig: false },
    FOREMAN,
  );
  if (gate.status !== "pending") throw new Error("expected the merge gate to wait");
  if (opts.noAssignee)
    await rows(
      "UPDATE core_pending_actions SET assignee_user_id = NULL WHERE id = ?",
      gate.pendingActionId,
    );
  await ok("adjudicator.request", { pendingActionId: gate.pendingActionId }, IMPROVER);
  const a = await first<{ job_id: string }>(
    "SELECT job_id FROM core_adjudications WHERE pending_action_id = ?",
    gate.pendingActionId,
  );
  await rows(
    `INSERT INTO core_runs (id, job_id, work_item_id, run_no, stage, runner_id, branch, base_branch,
       fencing_token, status, result, started_at)
     VALUES (?, ?, ?, 99, 'verify', 'rnr_x', 'b', 'main', 1, 'handed_back', ?, ?)`,
    uid("run_"),
    a.job_id,
    item.workItemId,
    JSON.stringify({ verdict: opts.verdict ?? "approve", reason: "Fine" }),
    new Date().toISOString(),
  );
  const recorded = await ok<{ status: string }>(
    "adjudicator.record",
    { pendingActionId: gate.pendingActionId },
    IMPROVER,
  );
  const pa = await first<{ status: string; decided_by: string | null; reason: string | null }>(
    "SELECT status, decided_by, reason FROM core_pending_actions WHERE id = ?",
    gate.pendingActionId,
  );
  return { item, head, gate: gate.pendingActionId, recorded, pa };
}

/** Lands an approved merge as the babysitter would (`pr.merge` with the approval): its merge commit. */
async function land(_w: W, at: Awaited<ReturnType<typeof atMergeGate>>): Promise<string> {
  await rows("UPDATE core_work_items SET head_sha = ? WHERE id = ?", at.head, at.item.workItemId);
  await ok("pr.open", { workItemId: at.item.workItemId }, FOREMAN);
  const merged = await ok<{ sha: string }>(
    "pr.merge",
    { workItemId: at.item.workItemId, headSha: at.head, touchesFactoryConfig: false },
    FOREMAN,
    { approvalId: at.gate },
  );
  return merged.sha;
}

const holdOf = async (w: W) =>
  (JSON.parse(
    (
      await first<{ raw: string }>(
        "SELECT pp.raw FROM core_project_policies pp JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha WHERE p.id = ?",
        w.projectId,
      )
    ).raw,
  ).autoApproveHold ?? null) as { reason: string } | null;

describe("dark factory mode through the operations", () => {
  it("an agent can't turn it on; an org admin's save loosens and waits for an org admin", async () => {
    const w = await world();
    const refused = await refusal(
      call("workflow.save", { orgId: w.orgId, baseVersion: 0, workflow: DARK }, FOREMAN),
    );
    expect(refused.code).toBe("forbidden");
    const saved = await call(
      "workflow.save",
      { orgId: w.orgId, baseVersion: 0, workflow: DARK },
      w.human,
    );
    expect(saved.status).toBe("pending");
  });

  it("the adjudicator's approval with every condition holding approves the gate, as auto-approve", async () => {
    const w = await world();
    await dark(w);
    const { pa, recorded } = await atMergeGate(w);
    expect(recorded.status).toBe("approved");
    expect(pa).toMatchObject({ status: "approved", decided_by: "auto-approve" });
    // The journal keeps every condition's result.
    const journal = await rows<{ diff: string }>(
      "SELECT diff FROM core_audit WHERE operation = 'adjudicator.record' AND diff LIKE '%autoApprove%' ORDER BY at DESC LIMIT 1",
    );
    expect(journal[0]?.diff).toMatch(/"conditions"/);
  });

  it("a failed condition leaves the gate to its person, saying which", async () => {
    const w = await world();
    await dark(w);
    const big = await atMergeGate(w, {
      files: [
        { path: "src/big.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", changes: 500 },
      ],
    });
    expect(big.pa.status).toBe("pending");
    expect(big.pa.reason).toMatch(/Not auto-approved: 500 lines changed/);
    const risky = await atMergeGate(w, {
      files: [
        {
          path: "packages/core/src/policy/gate.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-a\n+b",
          changes: 2,
        },
      ],
    });
    expect(risky.pa.status).toBe("pending");
    expect(risky.pa.reason).toMatch(/factory itself/);
    const unproven = await atMergeGate(w, {
      packet: {
        ci: { state: "success" },
        proof: [
          { criterion: "a", proven: true, linkedBy: "spec", provenBy: ["t"] },
          { criterion: "b", proven: true, linkedBy: "reviewer", provenBy: ["t"] },
        ],
        testsIntact: { intact: true },
      },
    });
    expect(unproven.pa.status).toBe("pending");
    const deferred = await atMergeGate(w, { verdict: "defer" });
    expect(deferred.pa.status).toBe("pending");
  });

  it("is off by default: the adjudicator's approval alone never decides a merge", async () => {
    const w = await world();
    await earned(w);
    await approveIfPending(w, await saveConfig(w, { ...POLICY, adjudicator: { merge: "active" } }));
    const { pa, recorded } = await atMergeGate(w);
    expect(recorded.status).toBe("recorded");
    expect(pa.status).toBe("pending");
    expect(pa.decided_by).toBeNull();
  });

  it("an incident holds it on the project; lifting the hold is an org admin's loosening", async () => {
    const w = await world();
    await dark(w);
    const item = await newItem(w, uid("broken "));
    await ok(
      "incident.open",
      { workItemId: item.workItemId, kind: "manual", reason: "it broke" },
      w.human,
    );
    const scope = await first<{ raw: string; source: string }>(
      "SELECT pp.raw, pp.source FROM core_project_policies pp JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha WHERE p.id = ?",
      w.projectId,
    );
    expect(scope.source).toBe("auto-approve");
    expect(JSON.parse(scope.raw).autoApproveHold.reason).toMatch(/incident/);
    // Held: every condition otherwise holds, and still a person decides.
    const held = await atMergeGate(w);
    expect(held.pa.status).toBe("pending");
    expect(held.pa.reason).toMatch(/held/);
    // Lifting it waits for an org admin.
    const doc = JSON.parse(scope.raw) as Record<string, unknown>;
    doc.autoApproveHold = null;
    const lift = await saveConfig(w, doc);
    expect(lift.status).toBe("pending");
    const pending = await first<{ decider: string | null }>(
      "SELECT decider FROM core_pending_actions WHERE id = ?",
      lift.status === "pending" ? lift.pendingActionId : "",
    );
    expect(pending.decider).toBe("org-admin");
  });

  it("every fifth auto-approval also goes to a person after it merges; their 'no' holds the project", async () => {
    const w = await world();
    await dark(w);
    for (let i = 0; i < 4; i++) await land(w, await atMergeGate(w));
    // Sampled when the merge lands, not at approval: an approval alone opens no review.
    const fifth = await atMergeGate(w);
    expect(fifth.pa.status).toBe("approved");
    expect(
      await rows(
        "SELECT id FROM core_pending_actions WHERE project_id = ? AND operation = 'autoApprove.review'",
        w.projectId,
      ),
    ).toEqual([]);
    await land(w, fifth);
    const review = await first<{ id: string; status: string }>(
      "SELECT id, status FROM core_pending_actions WHERE project_id = ? AND operation = 'autoApprove.review'",
      w.projectId,
    );
    expect(review.status).toBe("pending");
    const generic = await refusal(
      call("approval.decide", { pendingActionId: review.id, decision: "rejected" }, w.human),
    );
    expect(generic.code).toBe("forbidden");
    const out = await ok<{ held: boolean }>(
      "autoApprove.review",
      { pendingActionId: review.id, verdict: "shouldNotHaveMerged", note: "Broke the build" },
      w.human,
    );
    expect(out.held).toBe(true);
    expect((await atMergeGate(w)).pa.status).toBe("pending");
  });

  it("a revert of an auto-approved merge holds the project: GitHub's Revert button names the merge commit", async () => {
    const w = await world();
    await dark(w);
    const mergeSha = await land(w, await atMergeGate(w));
    const push = (reverts: { sha: string | null; pr: number | null }[]) =>
      ok(
        "push.observe",
        {
          repo: { owner: w.repo.owner, name: w.repo.repo },
          ref: "refs/heads/main",
          before: "b".repeat(40),
          after: "f".repeat(40),
          pusher: "tim",
          pusherIsApp: false,
          reverts,
        },
        { type: "intake", id: "github" },
      );
    // Another commit's revert holds nothing.
    await push([{ sha: "abcdef1", pr: null }]);
    expect(await holdOf(w)).toBeNull();
    await push([{ sha: mergeSha, pr: null }]);
    expect((await holdOf(w))?.reason).toMatch(/reverted/);
  });

  it("the red-main window opens when an auto-approved merge lands and closes on green at or after it", async () => {
    const w = await world();
    await dark(w);
    const red = async () => {
      const main = (await github.getBranchSha(w.repo, "main")) as string;
      await github.setChecks(w.repo, main, [
        {
          name: "ci",
          status: "completed",
          conclusion: "failure",
          appSlug: "github-actions",
          url: null,
        },
      ]);
      await ok(
        "main.observe",
        { repo: { owner: w.repo.owner, name: w.repo.repo }, headSha: null, trigger: "recheck" },
        FOREMAN,
      );
    };
    // Approved but not merged: red main holds nothing.
    const approved = await atMergeGate(w);
    expect(approved.pa.status).toBe("approved");
    await red();
    expect(await holdOf(w)).toBeNull();
    // Main goes green again, then the merge lands: the window opens at its commit.
    const main = (await github.getBranchSha(w.repo, "main")) as string;
    await github.setChecks(w.repo, main, [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        appSlug: "github-actions",
        url: null,
      },
    ]);
    await ok(
      "main.observe",
      { repo: { owner: w.repo.owner, name: w.repo.repo }, headSha: null, trigger: "recheck" },
      FOREMAN,
    );
    const mergeSha = await land(w, approved);
    expect(
      (
        await first<{ value: string }>(
          "SELECT value FROM core_meta WHERE key = ?",
          `auto_approved:${w.projectId}`,
        )
      ).value,
    ).toContain(mergeSha);
    await red();
    expect((await holdOf(w))?.reason).toMatch(/went red/);
  });

  it("a spec the adjudicator approved, or a Workflow version without the babysitter's re-check, goes to a person", async () => {
    const w = await world();
    await dark(w);
    const byAdjudicator = await atMergeGate(w, { specBy: "adjudicator" });
    expect(byAdjudicator.pa.status).toBe("pending");
    expect(byAdjudicator.pa.reason).toMatch(/wasn't approved by a person/);
    const old = await atMergeGate(w, { workflowVersion: 10 });
    expect(old.pa.status).toBe("pending");
    expect(old.pa.reason).toMatch(/no dark factory mode/);
  });

  it("auto detection says 'not the factory' only when every marker reads cleanly as absent", async () => {
    const w = await world();
    await dark(w);
    // The engine package moved, but core is there: still the factory.
    await github.setFile(w.repo, "main", "packages/core/package.json", '{"name":"x"}');
    const moved = await atMergeGate(w);
    expect(moved.pa.status).toBe("pending");
    expect(moved.pa.reason).toMatch(/factory's own repository/);
    // A read that fails: any doubt is yes.
    const w2 = await world();
    await dark(w2);
    const read = github.readFile;
    github.readFile = async () => {
      throw new Error("GitHub is down");
    };
    try {
      const failed = await atMergeGate(w2);
      expect(failed.pa.status).toBe("pending");
    } finally {
      github.readFile = read;
    }
  });

  it("turning auto-approval on with no allowPaths is refused", async () => {
    const w = await world();
    const refused = await refusal(
      call(
        "workflow.save",
        {
          orgId: w.orgId,
          baseVersion: 0,
          workflow: {
            ...DARK,
            stages: SOFTWARE.stages.map((x) =>
              x.id === "merge" ? { ...x, settings: { autoApprove: { enabled: true } } } : x,
            ),
          },
        },
        w.human,
      ),
    );
    expect(refused.message).toMatch(/needs allowPaths/);
  });

  it("on a project marked as the factory's own source, only the allow-list is auto-approved", async () => {
    const w = await world();
    await dark(w, { factorySource: "yes" });
    const code = await atMergeGate(w);
    expect(code.pa.status).toBe("pending");
    expect(code.pa.reason).toMatch(/factory's own repository/);
    const design = await atMergeGate(w, {
      files: [
        {
          path: "docs/design/x.html",
          status: "modified",
          patch: "@@ -1 +1 @@\n-a\n+b",
          changes: 4,
        },
      ],
    });
    expect(design.pa.status).toBe("approved");
  });

  it("counts only while on in both the pinned and the current org version", async () => {
    const w = await world();
    await dark(w);
    // The item pins the version with it on; then an org admin switches it off.
    const { item, pa } = await atMergeGate(w, {
      meanwhile: async () =>
        approveIfPending(
          w,
          await call(
            "workflow.save",
            {
              orgId: w.orgId,
              baseVersion: await orgVersionOf(w),
              workflow: { ...DARK, stages: SOFTWARE.stages },
            },
            w.human,
          ),
        ),
    });
    const pinned = await first<{ org_config_version: number }>(
      "SELECT org_config_version FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(pinned.org_config_version).toBeLessThan(await orgVersionOf(w));
    expect(pa.status).toBe("pending");
    expect(pa.reason).toMatch(/autoApprove is off/);
  });

  it("a hold is written even where the workflow doesn't auto-approve", async () => {
    const w = await world();
    const item = await newItem(w, uid("plain "));
    await ok(
      "incident.open",
      { workItemId: item.workItemId, kind: "manual", reason: "it broke" },
      w.human,
    );
    const raw = await first<{ raw: string }>(
      "SELECT pp.raw FROM core_project_policies pp JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha WHERE p.id = ?",
      w.projectId,
    );
    expect(JSON.parse(raw.raw).autoApproveHold.reason).toMatch(/incident/);
  });

  it("the babysitter checks again before merging: a hold since withdraws the auto-approval", async () => {
    const w = await world();
    await dark(w);
    const { item, head, gate, pa } = await atMergeGate(w);
    expect(pa.status).toBe("approved");
    await rows("UPDATE core_work_items SET head_sha = ? WHERE id = ?", head, item.workItemId);
    await ok("pr.open", { workItemId: item.workItemId }, FOREMAN);
    await ok(
      "mergeQueue.enter",
      { workItemId: item.workItemId, headSha: head, pendingActionId: gate, driver: "babysitter" },
      FOREMAN,
    );
    // Before it merges, an incident holds the project.
    const other = await newItem(w, uid("broken "));
    await ok(
      "incident.open",
      { workItemId: other.workItemId, kind: "manual", reason: "x" },
      w.human,
    );
    const marked = await ok<{ merging: boolean; withdrawn?: string }>(
      "mergeQueue.merging",
      { workItemId: item.workItemId, merging: true },
      BABYSITTER,
    );
    expect(marked.merging).toBe(false);
    expect(marked.withdrawn).toMatch(/held/);
    const after = await first<{ status: string; decision: string }>(
      "SELECT status, decision FROM core_pending_actions WHERE id = ?",
      gate,
    );
    expect(after).toEqual({ status: "rejected", decision: "withdrawn" });
  });

  it("the review after a sampled merge goes to the first approver when the gate had no assignee", async () => {
    const w = await world();
    await dark(w);
    for (let i = 0; i < 5; i++) await land(w, await atMergeGate(w, { noAssignee: true }));
    const review = await first<{ assignee_user_id: string | null }>(
      "SELECT assignee_user_id FROM core_pending_actions WHERE project_id = ? AND operation = 'autoApprove.review'",
      w.projectId,
    );
    expect(review.assignee_user_id).toBe(w.userId);
  });

  it("the babysitter's re-check refuses an auto-approval for another head", async () => {
    const w = await world();
    await dark(w);
    const { item, head, gate } = await atMergeGate(w);
    await rows("UPDATE core_work_items SET head_sha = ? WHERE id = ?", head, item.workItemId);
    await ok("pr.open", { workItemId: item.workItemId }, FOREMAN);
    await ok(
      "mergeQueue.enter",
      { workItemId: item.workItemId, headSha: head, pendingActionId: gate, driver: "babysitter" },
      FOREMAN,
    );
    await rows(
      "UPDATE core_merge_queue SET head_sha = ? WHERE work_item_id = ?",
      "e".repeat(40),
      item.workItemId,
    );
    const marked = await ok<{ merging: boolean; withdrawn?: string }>(
      "mergeQueue.merging",
      { workItemId: item.workItemId, merging: true },
      BABYSITTER,
    );
    expect(marked.withdrawn).toMatch(/another commit/);
  });
});

const orgVersionOf = async (w: W) =>
  (
    await first<{ config_version: number | null }>(
      "SELECT config_version FROM core_organization WHERE id = ?",
      w.orgId,
    )
  ).config_version ?? 0;
