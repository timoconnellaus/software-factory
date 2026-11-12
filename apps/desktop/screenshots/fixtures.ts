// The screenshot harness's fixture door (ADR 0460): typed answers to the reads the view makes, so
// every screen can be shot at 1440×900 without an engine. The work items echo the design files
// (docs/design/factory-ui) so the build and the design can be compared side by side. Never shipped:
// the app's own bridge talks to the main process.
import type { OpInput, OpName, OpOutput } from "@software-factory/client/ops";

/**
 * `?fixture=notrun`: the runner could not run the checks (the sandbox could not start), so the item
 * went on to the merge gate with them shown as not run (ADR 0501, third review).
 */
let seenNotRun = false;
const notRunFixture = () => {
  const where = `${globalThis.location?.search ?? ""}${globalThis.location?.hash ?? ""}`;
  seenNotRun ||= where.includes("fixture=notrun");
  return seenNotRun;
};
const NOT_RUN_REASON = "the sandbox could not start: bwrap: setting up uid map: Permission denied";
/** The proof when the checks weren't run: nothing proven, the spec's links left unproven. */
const notProven = <T extends { provenBy: string[]; unproven: string[] }>(proof: T[]): T[] =>
  proof.map((p) => ({
    ...p,
    proven: false,
    provenBy: [],
    unproven: [...p.unproven, ...p.provenBy],
  }));
const NOT_RUN_EXECUTED = {
  declared: ["lint", "tests"],
  results: ["lint", "tests"].map((name) => ({
    name,
    command: `pnpm ${name === "tests" ? "test" : name}`,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    logTail: `not run: ${NOT_RUN_REASON}`,
    round: 0,
    notRun: NOT_RUN_REASON,
    passed: false,
  })),
  extra: [],
  notRun: [
    { name: "lint", reason: NOT_RUN_REASON },
    { name: "tests", reason: NOT_RUN_REASON },
  ],
};

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
    branch: `factory/${n}-${title
      .toLowerCase()
      .replace(/[^a-z]+/g, "-")
      .slice(0, 24)}`,
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

/**
 * The Factory section's items (spec 41, slice 5): incidents are work items of kind incident, one
 * item is in the merge queue and a released one waits for a slot. `workItem.list` serves them with
 * ITEMS; the shell's tests pin ITEMS alone.
 */
export const FACTORY_ITEMS: Summary[] = [
  item(40, "Factory incident: #8 had a run that failed", "merge", "waiting", {
    kind: "incident",
    source: "incident",
    statusReason: "Packet ready",
    prUrl: "https://github.com/example/software-factory/pull/47",
    createdAt: ago(60 * 22),
    updatedAt: ago(50),
  }),
  item(41, "Factory incident: #4 was sent back at review", "done", "done", {
    kind: "incident",
    source: "incident",
    prUrl: "https://github.com/example/software-factory/pull/44",
    createdAt: ago(60 * 50),
    updatedAt: ago(60 * 45),
  }),
  item(42, "Keep the runner count fresh", "merge", "running", {
    statusReason: "Merge queue: CI on the merged head",
    updatedAt: ago(12),
  }),
  item(43, "Show the budget in the status bar", "intake", "queued", {
    releasedAt: ago(25),
    updatedAt: ago(25),
  }),
];

/** The Factory project's config (spec 41, slice 5): a version as `config.get` returns it. */
export const POLICY_DOC = {
  version: 1,
  autonomyPolicy: "balanced",
  spec: { requiredFrom: "medium" },
  wipLimit: 3,
  retryLimit: 2,
  approvers: ["owner"],
  agents: [
    {
      name: "Builder",
      role: "implement",
      tier: "standard",
      instructions:
        "Work one task at a time and commit when its checks pass.\nWrite the failing test before the fix.\nNever edit, skip or delete an existing test to make a check pass.\nIf a criterion cannot be proven by a check, say so in your notes.",
      requires: [],
    },
    {
      name: "Spec critic",
      role: "review",
      tier: "light",
      instructions: "Challenge the spec before a person approves it.\nName what isn't testable.",
      requires: [],
    },
  ],
  workflows: [
    {
      name: "Software",
      description: "Code changes: a spec, a build, verify and review.",
      slots: {
        afterSpec: [{ id: "critic", kind: "work", name: "Spec critic", agent: "Spec critic" }],
        beforeVerify: [],
        afterVerify: [
          {
            id: "ui-check",
            kind: "gate",
            name: "Browser walk-through",
            when: { domain: "ui" },
          },
        ],
      },
      core: { build: "Builder" },
    },
    {
      name: "Docs",
      description: "Writing only: no build, a person reads it.",
      slots: { afterSpec: [], beforeVerify: [], afterVerify: [] },
      core: {},
    },
  ],
  workflow: "Software",
};

const project = (id: string, orgId: string, name: string, slug: string) => ({
  id,
  orgId,
  factoryId: `fac_${slug}`,
  name,
  slug,
  repo: { owner: "example", name: slug, defaultBranch: "main" },
  // One repository per project, as projects have today (ADR 0490).
  repositories: [
    {
      id: `repo_${slug}`,
      projectId: id,
      owner: "example",
      name: slug,
      defaultBranch: "main",
      githubInstallationId: null,
      connection: { status: "connected" as const, account: "example", manageUrl: null },
    },
  ],
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
  running: [...ITEMS, ...FACTORY_ITEMS].filter((i) =>
    ["running", "waiting", "paused"].includes(i.status),
  ),
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
      paused: null,
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

// As main's verify run reports its checks (verifyResultSchema): the agent's own words in `detail`.
// CI comes from GitHub, in the packet's sections.ci. Checks the factory runs itself are spec 51 PR B.
const PACKET_CHECKS = [
  { name: "pnpm lint", status: "pass", detail: "0 errors" },
  { name: "pnpm typecheck", status: "pass", detail: "18 of 18 projects" },
  { name: "pnpm test", status: "pass", detail: "214 passed" },
];

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
    .slice(
      0,
      ["intake", "triage", "spec", "build", "verify", "merge", "done"].indexOf(base.stage) + 1,
    )
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
      ...(n === 12 && !alone()
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
      // A live planning session has a live spec run (its terminal is what Open terminal opens).
      base.stage === "spec"
        ? run(2, "spec", 60 * 25, null, null, null, true)
        : run(2, "spec", 60 * 25, 60 * 23, "succeeded", "Spec approved after one round"),
      ...(base.stage === "build" || base.stage === "verify" || atMerge
        ? [
            run(
              3,
              "build",
              60 * 20,
              atMerge ? 60 * 6 : null,
              atMerge ? "succeeded" : null,
              null,
              base.status === "running",
            ),
          ]
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
            {
              criterion: CRITERIA[0],
              met: true,
              evidence: "guard.test.ts › flags removed and skipped tests",
            },
            {
              criterion: CRITERIA[1],
              met: true,
              evidence: "guard.test.ts › flags biome-ignore and ts-expect-error",
            },
            {
              criterion: CRITERIA[2],
              met: true,
              evidence: "packet.test.ts › includes guard findings",
            },
            {
              criterion: CRITERIA[3],
              met: true,
              evidence: "review.ts › the merge gate reads the guard's findings (read, no test)",
            },
          ],
          checks: PACKET_CHECKS,
          reviewer: {
            role: "review",
            verdict: "approve",
            notes:
              "The guard is small and well tested. The last criterion is enforced by the gate code, which I read; no test covers it.",
            sameModelAsImplementer: false,
          },
          riskFlags: [],
          sections: {
            ci: {
              state: "success",
              checks: [{ name: "ci", status: "completed", conclusion: "success", url: null }],
            },
            verdict: { verdict: "pass", reasons: [], warnings: [] },
            changed: {
              files: 4,
              paths: [
                { path: "packages/verify/src/guard.ts", status: "added" },
                { path: "packages/verify/test/guard.test.ts", status: "added" },
                { path: "packages/verify/src/packet.ts", status: "modified" },
                { path: "packages/verify/test/packet.test.ts", status: "modified" },
              ],
            },
            risk: [],
            // The tests-intact guard (ADR 0500): this PR only adds tests, so nothing to flag.
            testsIntact: {
              headSha: "3f2a91c8d0e1b2a3c4d5e6f708192a3b4c5d6e7f",
              intact: true,
              findings: [],
              total: 0,
            },
            runner: { verdict: "pass", checks: PACKET_CHECKS },
            // Spec 51 PR B (Workflow v8, ADR 0501): the checks the runner host ran itself on the
            // head, and each criterion's proof. Only the approved spec's links prove a criterion.
            executed: notRunFixture()
              ? NOT_RUN_EXECUTED
              : {
                  declared: ["lint", "tests"],
                  results: [
                    {
                      name: "lint",
                      command: "pnpm lint",
                      exitCode: 0,
                      timedOut: false,
                      durationMs: 14_000,
                      logTail: "",
                      round: 0,
                      passed: true,
                    },
                    {
                      name: "tests",
                      command: "pnpm test",
                      exitCode: 0,
                      timedOut: false,
                      durationMs: 52_000,
                      logTail: "",
                      round: 1,
                      passed: true,
                    },
                  ],
                  extra: [],
                },
            proof: (notRunFixture() ? notProven : <T>(p: T) => p)([
              {
                criterion: CRITERIA[0],
                proven: true,
                provenBy: ["tests"],
                unproven: [],
                notCounted: [],
                linkedBy: "spec",
                weakened: false,
                reviewerMet: true,
                opinion: "guard.test.ts › flags removed and skipped tests",
              },
              {
                criterion: CRITERIA[1],
                proven: true,
                provenBy: ["tests"],
                unproven: [],
                notCounted: [],
                linkedBy: "spec",
                weakened: false,
                reviewerMet: true,
                opinion: "guard.test.ts › flags biome-ignore and ts-expect-error",
              },
              {
                criterion: CRITERIA[2],
                proven: false,
                provenBy: [],
                unproven: [],
                notCounted: ["tests"],
                linkedBy: "reviewer",
                weakened: false,
                reviewerMet: true,
                opinion: "packet.test.ts › includes guard findings",
              },
              {
                criterion: CRITERIA[3],
                proven: false,
                provenBy: [],
                unproven: [],
                notCounted: [],
                linkedBy: "reviewer",
                weakened: false,
                reviewerMet: true,
                opinion: "review.ts › the merge gate reads the guard's findings (read, no test)",
              },
            ]),
            evidencePass: true,
            evidenceReasons: [],
          },
          createdAt: ago(200),
        }
      : null,
    mergeQueue: null,
    policy: { autonomyPolicy: "balanced", specRequiredFrom: "medium", reviewPacketSections: null },
    approvers: {
      rule: "project approver",
      users: [{ id: ME, name: "Owner", githubLogin: "owner" }],
    },
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
      ? {
          label: "Attach to the session on M5",
          hint: "tmux -L software-factory attach -t sf-job_3",
        }
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
    {
      key: "github",
      done: true,
      detail: "The software-factory app is installed on example and can reach 3 repositories.",
    },
    { key: "project", done: true, detail: "software-factory, on the main branch." },
    { key: "policy", done: true, detail: "The policy is valid." },
    { key: "runner", done: true, detail: "M5 is online." },
    {
      key: "protect",
      done: false,
      detail:
        "The ruleset has not been imported, so a pull request could merge without the factory check.",
    },
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
  // The check's real result while the ruleset isn't imported (the protect step above).
  projects: [
    {
      ...(PROJECTS[0] as (typeof PROJECTS)[number]),
      protection: {
        state: "red",
        branch: "main",
        problems: ["`factory/verify` is not a required check on main"],
        warnings: [],
        files: [],
        rulesetsUrl: "https://github.com/example/software-factory/settings/rules",
        viewerIsRepoAdmin: true,
        adminMessage: "",
      },
    },
  ],
  missingEvents: [],
  runners: { total: 1, online: 1 },
};

/**
 * Rows of core_cli_tokens as the engine has them: each desktop app's token (kind "desktop", made by
 * `desktop.authExchange`) beside a CLI token. `cliToken.list` answers only the CLI ones.
 */
export const TOKENS: (OpOutput<"cliToken.list">["tokens"][number] & { kind: "cli" | "desktop" })[] =
  [
    {
      id: "clt_desktop_m5",
      name: "M5",
      kind: "desktop",
      scope: "write",
      createdAt: ago(60 * 24 * 9),
      expiresAt: new Date(now + 21 * 24 * 60 * 60_000).toISOString(),
      revokedAt: null,
    },
    {
      id: "clt_desktop_mini",
      name: "Mac mini",
      kind: "desktop",
      scope: "write",
      createdAt: ago(60 * 24 * 20),
      expiresAt: new Date(now + 10 * 24 * 60 * 60_000).toISOString(),
      revokedAt: null,
    },
    {
      id: "clt_1",
      name: "M5 terminal",
      kind: "cli",
      scope: "write",
      createdAt: ago(60 * 24 * 4),
      expiresAt: new Date(now + 26 * 24 * 60 * 60_000).toISOString(),
      revokedAt: null,
    },
  ];

type PlanningQ = OpOutput<"planning.get">["questions"][number];

function question(n: number, prompt: string, extra: Partial<PlanningQ>): PlanningQ {
  return {
    id: `pq_${n}`,
    number: n,
    kind: "single-choice",
    prompt,
    context: null,
    options: [],
    defaultValues: null,
    defaultAnswer: null,
    recommendation: null,
    recommendationReason: null,
    domain: "product",
    blocking: true,
    irreversible: false,
    status: "answered",
    answer: null,
    note: null,
    acceptedDefault: false,
    acceptedAlone: false,
    skipped: false,
    answerDeliveredAt: ago(29),
    answeredBy: ME,
    answeredAt: ago(30),
    answerRevision: 1,
    revision: 1,
    position: n,
    assignee: ME,
    escalated: false,
    planning: true,
    ...extra,
  };
}

/** A question answered with its default, written the way `planning.ask` stores one. */
/** `?fixture=alone`: the planner finishing alone, before the spec gate (spec 26 screenshot). */
let seenAlone = false;
const alone = () => {
  // Routes are in the hash; remember it once seen, as the router may rewrite the hash afterwards.
  seenAlone ||= (globalThis.location?.hash ?? "").includes("fixture=alone");
  return seenAlone;
};

function kept(n: number, prompt: string, answer: string, options: string[]): PlanningQ {
  return question(n, prompt, {
    options,
    defaultValues: [answer],
    defaultAnswer: answer,
    recommendation: answer,
    answer,
    acceptedDefault: true,
    // With finish alone on, the later ones were accepted under it (spec 26 screenshot).
    acceptedAlone: alone() && n >= 4,
  });
}

const PLAN_MD = `# Take work from GitHub issues

## Goal
A labelled GitHub issue from a trusted author becomes a work item in the backlog, and the issue shows where that work got to. [request]

## Scope
- The GitHub App webhook takes \`issues\` events for connected repositories [repo]
- Only issues with the \`factory\` label come in [Q1]
- Authors must be org members or collaborators; anything else is ignored and logged [Q2]
- New items land in the inbox of the project that owns the repository [Q3]
- The issue gets one comment with a link to the item, and is closed when the item merges [Q4]

## Out of scope
- Issues from repositories that are not connected, pull request comments [request]

## Acceptance criteria
- A labelled issue from a member becomes a work item within a minute [Q1] [Q3]
- An issue from an outside author creates nothing and writes one audit entry [Q2]
- Editing an issue after release changes nothing on the item [assumption]
`;

function planning(workItemId: string): OpOutput<"planning.get"> {
  const live = workItemId === "wi_12";
  return {
    cursor: 42,
    session: live
      ? {
          id: "ps_12",
          status: "working",
          activity: "Revising the acceptance criteria",
          idleSince: null,
          agentSeenAt: ago(0),
          atGate: false,
          ready: true,
          yieldRequested: false,
          paused: false,
          pausedBy: null,
          canInterrupt: true,
          finishAlone: alone() ? { by: ME, byName: "You", at: ago(6) } : null,
          focusedQuestionId: "pq_6",
          runner: { id: RUNNER, name: "M5", online: true, lastSeenAt: ago(0) },
          waitingForRunner: false,
          createdAt: ago(80),
        }
      : null,
    questions: live
      ? [
          kept(1, "Which issues come in?", "Only issues labelled factory", [
            "Only issues labelled factory",
            "Every issue",
          ]),
          kept(2, "Who can file them?", "Org members and collaborators", [
            "Org members and collaborators",
            "Anyone",
          ]),
          question(3, "Where do they land?", {
            options: ["The org inbox", "The project's inbox"],
            defaultValues: ["The org inbox"],
            defaultAnswer: "The org inbox",
            recommendation: "The org inbox",
            answer: "The project's inbox",
          }),
          kept(4, "What goes back to the issue?", "A link, then closed on merge", [
            "A link, then closed on merge",
            "Nothing",
          ]),
          kept(5, "One item per issue?", "Yes, edits update it", [
            "Yes, edits update it",
            "No, a new item per edit",
          ]),
          question(6, "An issue is edited after its item was released. What happens?", {
            status: "open",
            answer: null,
            answeredBy: null,
            answeredAt: null,
            options: [
              "Show a notice on the item, change nothing",
              "Send the item back to planning",
              "Update the plan without asking",
            ],
            defaultValues: ["Show a notice on the item, change nothing"],
            defaultAnswer: "Show a notice on the item, change nothing",
            recommendation: "Show a notice on the item, change nothing",
            recommendationReason:
              "A released item has an approved plan. Changing it silently would break what you approved, and sending it back would stall a build for a typo fix.",
          }),
        ]
      : [],
    spec: {
      id: `spec_${workItemId}`,
      version: 6,
      bodyMd: live ? PLAN_MD : "## Goal\nVerify flags a change that weakens the tests.\n",
      acceptanceCriteria: live ? [] : CRITERIA,
      assumptions: live ? ["Edits after release are ignored"] : [],
      coverage: [],
      clarifications: [],
      summary: null,
      status: live ? "draft" : "approved",
      createdAt: ago(1),
      createdBy: "agent",
    },
    previousSpec: null,
    messages: live
      ? [
          {
            id: "m1",
            author: "agent",
            authorId: "planner",
            authorName: "Planner",
            text: "I read the webhook handler. It already checks GitHub's signature, so issue events can go through `webhooks.ts` with no new endpoint.",
            questionId: null,
            replyTo: null,
            kind: "chat",
            deliveredAt: ago(20),
            createdAt: ago(20),
          },
          {
            id: "m2",
            author: "person",
            authorId: ME,
            authorName: "You",
            text: "Don't release new issues straight away. I want to look at them first.",
            questionId: null,
            replyTo: null,
            kind: "chat",
            deliveredAt: ago(12),
            createdAt: ago(12),
          },
        ]
      : [],
    present: live ? [{ userId: ME, name: "You" }] : [],
  };
}

/**
 * Whether the viewer may open a run's terminal (spec 42): `?terminal=watch` or `?terminal=none`
 * before the hash shows a watcher or a runner that can't share its terminal; the owner otherwise.
 */
function liveView(): OpOutput<"run.live"> {
  const mode = new URLSearchParams(globalThis.location?.search ?? "").get("terminal") ?? "type";
  return {
    run: null,
    events: [],
    lastSeq: 0,
    truncated: false,
    steers: [],
    steer: { allowed: false, reason: null, max: 2_000 },
    takeover: { allowed: false, reason: null, requested: false },
    terminal:
      mode === "none"
        ? {
            allowed: false,
            mode: null,
            reason: "This runner can't share its terminal: update it to use the web terminal.",
          }
        : mode === "watch"
          ? {
              allowed: true,
              mode: "watch",
              reason: "Only the runner's owner can type: it runs on their machine.",
            }
          : { allowed: true, mode: "type", reason: null },
  };
}

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
    items: [...ITEMS, ...FACTORY_ITEMS].filter((i) => !input.orgId || i.orgId === input.orgId),
  }),
  "workItem.get": (input) => detail(input.workItemId),
  "workItem.timeline": () => TIMELINE,
  "workItem.attachment.list": () => ({ attachments: [] }),
  "planning.get": (input) => planning(input.workItemId),
  "run.live": () => liveView(),
  "runner.list": () => ({
    runners: [
      {
        id: RUNNER,
        name: "M5",
        ownerUserId: ME,
        keyVersion: 1,
        manifest: {
          contractVersion: "1",
          runnerKind: "local",
          harnesses: ["claude-code"],
          capabilities: [],
        },
        capacityMax: 2,
        light: { max: 6, inUse: 2 },
        accepting: true,
        rateLimitedUntil: null,
        lastSeenAt: ago(0),
        version: "5da8988",
        desiredVersion: "5da8988",
        autoUpdate: true,
        update: null,
        accounts: { names: ["work", "personal"], active: "work", requested: null, limits: [] },
      },
    ],
  }),
  "config.get": (input) => ({
    projectId: input.projectId,
    current: {
      version: 12,
      sha: "5da8988",
      source: "app",
      note: "Two agents and the Software workflow",
      createdBy: "owner",
      createdAt: ago(60 * 24 * 3),
      valid: true,
      impact: "neutral",
      policy: POLICY_DOC,
    },
    error: null,
    history: [],
    pending:
      input.projectId === FACTORY
        ? [
            {
              pendingActionId: "pa_cfg_1",
              operation: "config.save",
              note: "Retries per item, 2 to 3",
              by: "owner",
              createdAt: ago(30),
              baseVersion: 12,
            },
          ]
        : [],
  }),
  "desktopDevice.list": () => ({
    devices: [
      {
        id: "dev_m5",
        name: "M5",
        platform: "macos",
        decides: true,
        attestation: null,
        current: true,
        keyStorage: "secure-enclave",
        createdAt: ago(60 * 24 * 9),
        lastSeenAt: ago(0),
        revokedAt: null,
      },
      {
        id: "dsk_mini",
        name: "Mac mini",
        platform: "macos",
        decides: true,
        attestation: null,
        current: false,
        keyStorage: "secure-enclave",
        createdAt: ago(60 * 24 * 20),
        lastSeenAt: ago(60 * 24 * 2),
        revokedAt: null,
      },
      {
        id: "dsk_old",
        name: "Old laptop",
        platform: "macos",
        decides: true,
        attestation: null,
        current: false,
        keyStorage: "software",
        createdAt: ago(60 * 24 * 60),
        lastSeenAt: ago(60 * 24 * 40),
        revokedAt: ago(60 * 24 * 30),
      },
    ],
  }),
  // The door lists only kind "cli" (a desktop's token is its device's), as the engine does.
  "cliToken.list": () => ({
    tokens: TOKENS.filter((t) => t.kind === "cli").map(({ kind: _, ...t }) => t),
  }),
  "mergeQueue.list": (input) => ({
    entries:
      input.projectId === FACTORY
        ? [
            {
              workItemId: "wi_42",
              number: 42,
              title: "Keep the runner count fresh",
              headSha: "9c41e07d2b",
              enqueuedAt: ago(12),
              repositoryId: "repo_software-factory",
            },
          ]
        : [],
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
