// The screenshot harness's fixture door (ADR 0460): typed answers to the reads the view makes, so
// every screen can be shot at 1440×900 without an engine. The work items echo the design files
// (docs/design/factory-ui) so the build and the design can be compared side by side. Never shipped:
// the app's own bridge talks to the main process.
import type { OpInput, OpName, OpOutput } from "@software-factory/client/ops";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const ME = "usr_owner";
const PERSONAL = "org_personal";
const CLIENT = "org_client";
const FACTORY = "prj_factory";
const CRM = "prj_crm";
const RUNNER = "rnr_m5";

type Summary = OpOutput<"workItem.list">["items"][number];

function item(
  n: number,
  title: string,
  stage: Summary["stage"],
  status: Summary["status"],
  extra: Partial<Summary> = {},
): Summary {
  return {
    id: `wi_${n}`,
    projectId: FACTORY,
    orgId: PERSONAL,
    number: n,
    title,
    kind: "change",
    stage,
    status,
    statusReason: null,
    size: "medium",
    requesterUserId: ME,
    source: "app",
    branch: `factory/${n}-${title.toLowerCase().replace(/[^a-z]+/g, "-").slice(0, 24)}`,
    prUrl: null,
    createdAt: ago(60 * 26),
    updatedAt: ago(n),
    ...extra,
  };
}

export const ITEMS: Summary[] = [
  item(13, "Guard the tests in verify", "merge", "waiting", {
    statusReason: "Packet ready",
    prUrl: "https://github.com/example/software-factory/pull/51",
    updatedAt: ago(190),
  }),
  item(9, "Find new lint and type suppressions", "build", "running", {
    statusReason: "Repairing",
    updatedAt: ago(14),
  }),
  item(11, "Confirm the deploy after a merge", "build", "waiting", {
    statusReason: "Question",
    updatedAt: ago(40),
  }),
  item(12, "Take work from GitHub issues", "spec", "waiting", {
    statusReason: "Spec ready",
    updatedAt: ago(60),
  }),
  item(26, "Fix the stale runner count", "verify", "running", {
    statusReason: "pnpm test",
    updatedAt: ago(3),
  }),
  item(8, "Retry a planning session that lost its runner", "done", "done", {
    updatedAt: ago(60 * 20),
  }),
  item(4, "Make the event log useful", "done", "done", { updatedAt: ago(60 * 40) }),
  item(1, "Attachments on work items", "done", "done", { updatedAt: ago(60 * 60) }),
  item(3, "Import contacts from a CSV", "build", "running", {
    projectId: CRM,
    orgId: CLIENT,
    statusReason: "Builder",
    updatedAt: ago(22),
  }),
];

const project = (id: string, orgId: string, name: string, slug: string) => ({
  id,
  orgId,
  factoryId: `fac_${slug}`,
  name,
  slug,
  repo: { owner: "example", name: slug, defaultBranch: "main" },
  policySha: "5da8988",
  configVersion: 3,
  githubInstallationId: null,
  connection: { status: "connected" as const, account: "example", manageUrl: null },
  policy: { state: "valid" as const, error: null, prUrl: null },
});

const PROJECTS = [
  project(FACTORY, PERSONAL, "Factory", "software-factory"),
  project(CRM, CLIENT, "CRM", "crm"),
];

const INBOX: OpOutput<"inbox.list"> = {
  gates: [
    {
      id: "pa_merge_13",
      kind: "merge",
      workItemId: "wi_13",
      projectId: FACTORY,
      title: "Guard the tests in verify",
      operation: "review.merge",
      createdAt: ago(190),
      timeoutAt: null,
      escalated: false,
    },
    {
      id: "pa_spec_12",
      kind: "spec",
      workItemId: "wi_12",
      projectId: FACTORY,
      title: "Take work from GitHub issues",
      operation: "spec.approve",
      createdAt: ago(60),
      timeoutAt: null,
      escalated: false,
    },
  ],
  questions: [
    {
      id: "q_11",
      workItemId: "wi_11",
      projectId: FACTORY,
      title: "Confirm the deploy after a merge",
      domain: "operations",
      prompt: "Which address should the health check call after a deploy?",
      options: ["The worker's /api/health", "The app's home page", "Skip the health check"],
      defaultAnswer: "The worker's /api/health",
      recommendation: "The worker's /api/health",
      irreversible: false,
    },
  ],
  running: ITEMS.filter((i) => ["running", "waiting", "paused"].includes(i.status)),
  runners: [
    {
      id: RUNNER,
      name: "M5",
      state: "online",
      inUse: 1,
      max: 2,
      light: { inUse: 2, max: 6 },
      rateLimitedUntil: null,
      lastSeenAt: ago(0),
      update: null,
    },
  ],
  planning: [],
  wipHolds: [],
  protection: [
    {
      projectId: FACTORY,
      name: "Factory",
      repo: { owner: "example", name: "software-factory" },
      branch: "main",
      problems: ["`factory/verify` is no longer a required check"],
      changedAt: ago(120),
      rulesetsUrl: "https://github.com/example/software-factory/settings/rules",
      files: [{ kind: "default-branch", filename: "software-factory-default-branch.json" }],
    },
  ],
};

const CRITERIA = [
  "A removed or skipped test is flagged",
  "A new suppression is flagged",
  "Findings show in the review packet",
  "A flagged change always goes to a person",
];

function detail(id: string): OpOutput<"workItem.get"> {
  const base = ITEMS.find((i) => i.id === id) ?? (ITEMS[0] as Summary);
  const n = base.number;
  const atMerge = base.stage === "merge";
  const stages: OpOutput<"workItem.get">["stages"] = (
    ["intake", "triage", "spec", "build", "verify", "merge"] as const
  )
    .slice(0, ["intake", "triage", "spec", "build", "verify", "merge", "done"].indexOf(base.stage) + 1)
    .map((stage, i, all) => ({
      stage,
      attempt: 1,
      status: i === all.length - 1 && base.status !== "done" ? "active" : "done",
      reason: null,
      startedAt: ago(60 * 26 - i * 120),
      endedAt: i === all.length - 1 && base.status !== "done" ? null : ago(60 * 26 - i * 120 - 100),
    }));
  return {
    item: {
      ...base,
      body:
        n === 13
          ? "Verify should catch a change that weakens the tests: a removed or skipped test, a new lint or type suppression, or an edit to the check commands. A flagged change must go to a person."
          : `${base.title}.`,
      specRequired: true,
      specDecisionReason: "Medium: touches verify and the review packet",
      domains: ["verify"],
      headSha: atMerge ? "3f2a91c8d0e1b2a3c4d5e6f708192a3b4c5d6e7f" : null,
      prNumber: atMerge ? 51 : null,
      policySha: "5da8988",
      workflow: "software",
      workflowReason: "the project's default",
    },
    workflows: [{ name: "software", description: "Plan, build, verify, review" }],
    stages,
    spec: {
      id: `spec_${n}`,
      version: 2,
      status: n === 12 ? "proposed" : "approved",
      bodyMd: "## Goal\nVerify flags a change that weakens the tests.\n",
      acceptanceCriteria: n === 13 || n === 12 ? CRITERIA : CRITERIA.slice(0, 2),
      assumptions: [],
      path: `docs/specs/wi-${n}.md`,
      commitSha: "a1b2c3d",
    },
    questions:
      n === 11
        ? [
            {
              id: "q_11",
              domain: "operations",
              prompt: "Which address should the health check call after a deploy?",
              options: ["The worker's /api/health", "The app's home page", "Skip the health check"],
              defaultAnswer: "The worker's /api/health",
              recommendation: "The worker's /api/health",
              blocking: true,
              irreversible: false,
              status: "open",
              answer: null,
              acceptedDefault: false,
              assigneeUserId: ME,
            },
          ]
        : [],
    gates: [
      ...(atMerge
        ? [
            {
              id: "pa_merge_13",
              kind: "merge",
              operation: "review.merge",
              status: "pending",
              decision: null,
              assigneeUserId: ME,
              createdAt: ago(190),
              decidedAt: null,
              decidedBy: null,
              note: null,
            },
          ]
        : []),
      ...(n === 12
        ? [
            {
              id: "pa_spec_12",
              kind: "spec",
              operation: "spec.approve",
              status: "pending",
              decision: null,
              assigneeUserId: ME,
              createdAt: ago(60),
              decidedAt: null,
              decidedBy: null,
              note: null,
            },
          ]
        : []),
    ],
    runs: [
      run(1, "triage", 60 * 26, 60 * 26 - 3, "succeeded", "Sized medium; spec required"),
      run(2, "spec", 60 * 25, 60 * 23, "succeeded", "Spec approved after one round"),
      ...(base.stage === "build" || base.stage === "verify" || atMerge
        ? [run(3, "build", 60 * 20, atMerge ? 60 * 6 : null, atMerge ? "succeeded" : null, null, base.status === "running")]
        : []),
      ...(atMerge ? [run(4, "verify", 60 * 6, 60 * 3.5, "succeeded", "Packet ready")] : []),
    ],
    reviewPacket: atMerge
      ? {
          id: "pkt_13",
          headSha: "3f2a91c8d0e1b2a3c4d5e6f708192a3b4c5d6e7f",
          verdict: "pass",
          summary:
            "Adds a **test guard** to verify: removed or skipped tests and new `biome-ignore` / `ts-expect-error` suppressions are flagged in the packet.",
          criteria: [
            { criterion: CRITERIA[0], met: true, evidence: "guard.test.ts › flags removed and skipped tests" },
            { criterion: CRITERIA[1], met: true, evidence: "guard.test.ts › flags biome-ignore and ts-expect-error" },
            { criterion: CRITERIA[2], met: true, evidence: "packet.test.ts › includes guard findings" },
            { criterion: CRITERIA[3], met: false, evidence: "No check that ran covers this. The reviewer read the gate code and agrees." },
          ],
          checks: [
            { name: "pnpm lint", status: "pass", detail: "Runner M5 · 11s" },
            { name: "pnpm typecheck", status: "pass", detail: "Runner M5 · 38s" },
            { name: "pnpm test", status: "pass", detail: "Runner M5 · 2m 04s" },
            { name: "ci", status: "pass", detail: "GitHub · 4m 51s" },
          ],
          reviewer: {
            role: "review",
            verdict: "approve",
            notes: "The guard is small and well tested. The last criterion is enforced by the gate code, which I read; no test covers it.",
            sameModelAsImplementer: false,
          },
          riskFlags: [],
          sections: {
            ci: {
              state: "success",
              checks: [{ name: "ci", status: "completed", conclusion: "success", url: null }],
            },
            verdict: { reasons: [], warnings: ["1 criterion has no check covering it"] },
            changed: {
              files: 4,
              paths: [
                { path: "packages/verify/src/guard.ts", status: "added" },
                { path: "packages/verify/test/guard.test.ts", status: "added" },
                { path: "packages/verify/src/packet.ts", status: "modified" },
                { path: "packages/verify/test/packet.test.ts", status: "modified" },
              ],
            },
          },
          createdAt: ago(200),
        }
      : null,
    mergeQueue: null,
    policy: { autonomyPolicy: "balanced", specRequiredFrom: "medium", reviewPacketSections: null },
    approvers: { rule: "project approver", users: [{ id: ME, name: "Owner", githubLogin: "owner" }] },
    viewer: { isApprover: true, isRequester: true },
  };
}

function run(
  runNo: number,
  stage: string,
  startedMin: number,
  endedMin: number | null,
  outcome: string | null,
  summary: string | null,
  takeover = false,
): OpOutput<"workItem.get">["runs"][number] {
  return {
    id: `run_${runNo}`,
    jobId: `job_${runNo}`,
    runNo,
    stage,
    runnerId: RUNNER,
    branch: "factory/13-guard-the-tests",
    status: endedMin === null ? "running" : "finished",
    outcome,
    summary,
    headSha: null,
    takeover: takeover
      ? { label: "Attach to the session on M5", hint: "tmux -L software-factory attach -t sf-job_3" }
      : null,
    startedAt: ago(startedMin),
    endedAt: endedMin === null ? null : ago(endedMin),
  };
}

const TIMELINE: OpOutput<"workItem.timeline"> = {
  entries: [
    ["workItem.create", "human", ME, 60 * 26],
    ["triage.record", "agent", "foreman", 60 * 26 - 3],
    ["spec.approve", "human", ME, 60 * 23],
    ["run.start", "agent", "foreman", 60 * 20],
    ["reviewPacket.record", "agent", "foreman", 200],
  ].map(([operation, actorType, actorId, min], i) => ({
    id: `aud_${i}`,
    at: ago(min as number),
    operation: operation as string,
    actorType: actorType as string,
    actorId: actorId as string,
    decision: "n/a",
    outcome: "ok",
    reason: null,
    pendingActionId: null,
    result: null,
  })),
};

const SETUP: OpOutput<"setup.status"> = {
  complete: false,
  steps: [
    { key: "github", done: true, detail: "The software-factory app is installed on example and can reach 3 repositories." },
    { key: "project", done: true, detail: "software-factory, on the main branch." },
    { key: "policy", done: true, detail: "The policy is valid." },
    { key: "runner", done: true, detail: "M5 is online." },
    { key: "protect", done: false, detail: "The ruleset has not been imported, so a pull request could merge without the factory check." },
  ],
  installations: [
    {
      id: "ins_1",
      account: "example",
      accountType: "User",
      repositorySelection: "selected",
      status: "active",
      manageUrl: "https://github.com/settings/installations",
    },
  ],
  projects: [{ ...(PROJECTS[0] as (typeof PROJECTS)[number]), protection: null }],
  missingEvents: [],
  runners: { total: 1, online: 1 },
};

type Answers = { [N in OpName]?: (input: OpInput<N>) => OpOutput<N> };

export const ANSWERS: Answers = {
  "org.list": () => ({
    userId: ME,
    orgs: [
      { id: PERSONAL, name: "Personal", kind: "personal", role: "owner" },
      { id: CLIENT, name: "Client", kind: "team", role: "admin" },
    ],
  }),
  "project.list": (input) => ({ projects: PROJECTS.filter((p) => p.orgId === input.orgId) }),
  "inbox.list": () => INBOX,
  "workItem.list": (input) => ({
    items: ITEMS.filter((i) => !input.orgId || i.orgId === input.orgId),
  }),
  "workItem.get": (input) => detail(input.workItemId),
  "workItem.timeline": () => TIMELINE,
  "workItem.attachment.list": () => ({ attachments: [] }),
  "planning.get": (input) => ({
    cursor: 1,
    session: null,
    questions: [],
    spec: {
      id: `spec_${input.workItemId}`,
      version: 2,
      bodyMd: "## Goal\nVerify flags a change that weakens the tests.\n\n## Acceptance criteria\n- A removed or skipped test is flagged\n- A new suppression is flagged\n",
      acceptanceCriteria: CRITERIA,
      assumptions: [],
      coverage: [],
      clarifications: [],
      summary: null,
      status: "approved",
      createdAt: ago(60 * 23),
      createdBy: "agent",
    },
    previousSpec: null,
    messages: [],
    present: [],
  }),
  "runner.list": () => ({
    runners: [
      {
        id: RUNNER,
        name: "M5",
        ownerUserId: ME,
        keyVersion: 1,
        manifest: null,
        capacityMax: 2,
        light: { max: 6, inUse: 2 },
        accepting: true,
        rateLimitedUntil: null,
        lastSeenAt: ago(0),
        version: "5da8988",
        desiredVersion: "5da8988",
        autoUpdate: true,
        update: null,
      },
    ],
  }),
  "setup.status": () => SETUP,
  "workItem.previewRouting": () => ({
    runner: { id: RUNNER, name: "M5", ownerUserId: ME, freeSlots: 1, max: 2 },
    candidates: [{ id: RUNNER, name: "M5", refusal: null }],
    harness: "claude-code",
    models: { implement: "implement", review: "review", sameModel: false },
    gates: ["spec", "merge"],
    waitReason: null,
  }),
  "github.openPullRequests": () => ({ pulls: [] }),
};
