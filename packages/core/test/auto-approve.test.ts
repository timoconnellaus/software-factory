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

const ON = autoApproveSettings.parse({ enabled: true });
const good = (): AutoApproveFacts => ({
  headSha: "a".repeat(40),
  packet: {
    verdict: "pass",
    ci: "success",
    criteriaProven: true,
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
    expect(failing(unread)).toEqual(["limits", "risk"]);
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
    expect(Object.keys(ON).sort()).toEqual(
      ["enabled", "forbiddenPaths", "maxChangedLines", "maxFiles", "maxPerDay", "riskPaths"].sort(),
    );
    expect(SELF_MODIFY_PATHS).toContain(".factory/**");
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
    expect(cls(AUTO_APPROVE_OFF, ON)).toEqual(["loosens"]);
    expect(cls(ON, AUTO_APPROVE_OFF)).toEqual(["tightens"]);
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
      ? { ...s, settings: { ...(s.settings as object), autoApprove: { enabled: true } } }
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
  } = {},
) {
  const item = await newItem(w, uid("dark "));
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
    for (let i = 0; i < 5; i++) expect((await atMergeGate(w)).pa.status).toBe("approved");
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

  it("a revert of an auto-approved merge on the default branch holds the project", async () => {
    const w = await world();
    await dark(w);
    const { item } = await atMergeGate(w);
    await rows("UPDATE core_work_items SET pr_number = 77 WHERE id = ?", item.workItemId);
    await ok(
      "push.observe",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        ref: "refs/heads/main",
        before: "b".repeat(40),
        after: "f".repeat(40),
        pusher: "tim",
        pusherIsApp: false,
        reverts: [{ sha: null, pr: 77 }],
      },
      { type: "intake", id: "github" },
    );
    const raw = await first<{ raw: string }>(
      "SELECT pp.raw FROM core_project_policies pp JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha WHERE p.id = ?",
      w.projectId,
    );
    expect(JSON.parse(raw.raw).autoApproveHold.reason).toMatch(/reverted/);
  });

  it("red CI on the default branch after an auto-approved merge holds the project; green ends the window", async () => {
    const w = await world();
    await dark(w);
    expect((await atMergeGate(w)).pa.status).toBe("approved");
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
    const raw = await first<{ raw: string }>(
      "SELECT pp.raw FROM core_project_policies pp JOIN core_projects p ON p.id = pp.project_id AND pp.sha = p.policy_sha WHERE p.id = ?",
      w.projectId,
    );
    expect(JSON.parse(raw.raw).autoApproveHold.reason).toMatch(/went red/);
    expect(
      await rows("SELECT key FROM core_meta WHERE key = ?", `auto_approved:${w.projectId}`),
    ).toEqual([]);
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
    for (let i = 0; i < 4; i++) await atMergeGate(w);
    await rows(
      "UPDATE core_pending_actions SET assignee_user_id = NULL WHERE project_id = ? AND kind = 'merge' AND status = 'pending'",
      w.projectId,
    );
    await atMergeGate(w);
    const review = await first<{ assignee_user_id: string | null }>(
      "SELECT assignee_user_id FROM core_pending_actions WHERE project_id = ? AND operation = 'autoApprove.review'",
      w.projectId,
    );
    expect(review.assignee_user_id).toBe(w.userId);
  });
});

const orgVersionOf = async (w: W) =>
  (
    await first<{ config_version: number | null }>(
      "SELECT config_version FROM core_organization WHERE id = ?",
      w.orgId,
    )
  ).config_version ?? 0;
