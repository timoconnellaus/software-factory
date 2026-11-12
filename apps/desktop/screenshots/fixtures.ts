// The screenshot harness's fixture door (ADR 0460): typed answers to the reads the view makes, so
// every screen can be shot at 1440×900 without an engine. The work items echo the design files
// (docs/design/factory-ui) so the build and the design can be compared side by side. Never shipped:
// the app's own bridge talks to the main process.
import type { OpInput, OpName, OpOutput } from "@software-factory/client/ops";
import { planBlocks } from "@software-factory/client/planning";

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
  projects: [{ ...(PROJECTS[0] as (typeof PROJECTS)[number]), protection: null }],
  missingEvents: [],
  runners: { total: 1, online: 1 },
};

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
    answeredViaEdit: null,
    artifactId: null,
    optionArtifacts: null,
    optionValues: null,
    control: null,
    unit: null,
    min: null,
    max: null,
    step: null,
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

/** `?fixture=dropped`: an edit the plan no longer keeps (second review of #85 screenshot). */
let seenDropped = false;
const dropped = () => {
  seenDropped ||= (globalThis.location?.hash ?? "").includes("fixture=dropped");
  return seenDropped;
};

/** The blocks an edit wrote, by section, as the server stores them. */
const wrote = (after: string) =>
  planBlocks(PLAN_MD)
    .filter((b) => planBlocks(after).some((a) => a.text === b.text))
    .map(({ section, parent, text }) => ({ section, parent, text }));

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

/** Spec 21: the two mockups question 7 chooses between (design PlanFocusMockup). */
const MOCKUP_STYLE = `<style>
:root { --accent: #2563eb; }
body { margin: 0; font: 15px/1.4 -apple-system, system-ui, sans-serif; color: #1c1c1e; background: #f1f1ef; }
.app { display: grid; grid-template-columns: 220px 1fr; min-height: 800px; }
nav { background: #fff; border-right: 1px solid #e3e3e0; padding: 24px 16px; }
nav div { height: 10px; border-radius: 5px; background: #e3e3e0; margin: 14px 0; width: 70%; }
nav div.on { background: #1c1c1e; width: 50%; }
main { padding: 40px 48px; }
h1 { font-size: 26px; margin: 0 0 20px; }
.row { display: flex; align-items: center; justify-content: space-between; background: #fff; border: 1px solid #e3e3e0; border-radius: 12px; padding: 18px 20px; margin-bottom: 12px; font-size: 17px; }
.row.on { border: 2px solid var(--accent); }
.row small { display: block; color: #6e6e73; font-size: 14px; }
.ok { color: #17603a; } .link { color: var(--accent); }
.switch { width: 52px; height: 30px; border-radius: 15px; background: var(--accent); position: relative; }
.switch::after { content: ""; position: absolute; right: 4px; top: 4px; width: 22px; height: 22px; border-radius: 11px; background: #fff; }
</style>`;
const MOCKUP_A = `<!doctype html><html><head>${MOCKUP_STYLE}</head><body><div class="app">
<nav><div></div><div class="on"></div><div></div><div></div></nav>
<main><h1 data-name="page title">Connections</h1>
<div class="row" data-name="github row">GitHub <span class="ok">Connected</span></div>
<div class="row on" data-name="import setting"><span>Take work from issues<small>Label factory</small></span><span class="switch" data-name="import switch"></span></div>
<div class="row" data-name="open issues">14 open issues <span class="link">Review</span></div>
</main></div></body></html>`;
const MOCKUP_B = `<!doctype html><html><head>${MOCKUP_STYLE}</head><body><div class="app">
<nav><div></div><div></div><div class="on"></div><div></div></nav>
<main><h1 data-name="page title">Factory · project</h1>
<div class="row" data-name="workflow row">Workflow <span>Software</span></div>
<div class="row" data-name="repositories row">Repositories <span>1</span></div>
<div class="row on" data-name="import setting"><span>Take work from issues<small>Its own label and authors</small></span><span class="switch" data-name="import switch"></span></div>
</main></div></body></html>`;

const PLAN_MD = `# Take work from GitHub issues

## Goal
A labelled GitHub issue from a trusted author becomes a work item in the backlog, and the issue shows where that work got to. [request]

## Scope
- The GitHub App webhook takes \`issues\` events for connected repositories [repo]
- Only issues with the \`factory\` label come in [Q1]
  - the label name is set on the GitHub connection
  - relabelling an open issue brings it in
- Authors must be org members or collaborators; anything else is ignored and logged [Q2]
- New items land in the Backlog of the project that owns the repository [Q3]
- The issue gets one comment with a link to the item, and is closed when the item merges [Q4]

  The comment is posted by the App, never with a person's token.

## Webhook filter
\`\`\`yaml
on:
  issues:
    types: [opened, labeled]
\`\`\`

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
          shownArtifactId: null,
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
            options: ["The org inbox", "The project's inbox", "Backlog"],
            defaultValues: ["The org inbox"],
            defaultAnswer: "The org inbox",
            recommendation: "The org inbox",
            answer: "Backlog",
            // Spec 27: recorded by the planner from the person's edit of the plan.
            answeredViaEdit: "pe_1",
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
          // Spec 21: a choice between two mockups (design PlanFocusMockup).
          question(7, "Where does the import setting live?", {
            status: "open",
            answer: null,
            answeredBy: null,
            answeredAt: null,
            options: ["GitHub connection", "On each project"],
            defaultValues: ["GitHub connection"],
            defaultAnswer: "GitHub connection",
            recommendation: "GitHub connection",
            recommendationReason:
              "The label and the trusted authors belong to the connection. A project only chooses whether to take issues from its repositories.",
            optionArtifacts: { "GitHub connection": "art_a", "On each project": "art_b" },
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
            anchor: null,
            pin: null,
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
            anchor: null,
            pin: null,
            createdAt: ago(12),
          },
          {
            id: "m4",
            author: "person",
            authorId: ME,
            authorName: "You",
            text: "Show the label name here.",
            questionId: null,
            replyTo: null,
            kind: "chat",
            deliveredAt: ago(6),
            anchor: null,
            // Spec 21: a comment pinned to the switch in mockup A.
            pin: {
              artifactId: "art_a",
              element: "import switch",
              selector: null,
              x: 1040,
              y: 214,
              fx: 0.5,
              fy: 0.5,
              width: 1280,
            },
            createdAt: ago(6),
          },
          {
            id: "m5",
            author: "agent",
            authorId: "planner",
            authorName: "Planner",
            text: "Done: the switch now reads “Take work labelled factory” (revision 2).",
            questionId: null,
            // Spec 21: the planner's reply to the pinned comment.
            replyTo: "m4",
            kind: "chat",
            deliveredAt: ago(5),
            anchor: null,
            pin: null,
            createdAt: ago(5),
          },
          {
            id: "m3",
            author: "person",
            authorId: ME,
            authorName: "You",
            text: "Does a bot account count as a collaborator here?",
            questionId: null,
            replyTo: null,
            kind: "chat",
            deliveredAt: ago(3),
            pin: null,
            // Spec 27: a comment on a line of the plan.
            anchor: {
              specId: "spec_wi_12",
              lineStart: 10,
              lineEnd: 10,
              quote:
                "- Authors must be org members or collaborators; anything else is ignored and logged [Q2]",
            },
            createdAt: ago(3),
          },
          {
            id: "m6",
            author: "person",
            authorId: ME,
            authorName: "You",
            text: "Does this cover a label renamed on GitHub?",
            questionId: null,
            replyTo: null,
            kind: "chat",
            deliveredAt: ago(2),

            pin: null,
            anchor: {
              specId: "spec_wi_12",
              lineStart: 8,
              lineEnd: 8,
              quote: "  - the label name is set on the GitHub connection",
            },
            createdAt: ago(2),
          },
          {
            id: "m7",
            author: "person",
            authorId: ME,
            authorName: "You",
            text: "Add edited too, so a label added later counts.",
            questionId: null,
            replyTo: null,
            kind: "chat",
            deliveredAt: ago(1),

            pin: null,
            anchor: {
              specId: "spec_wi_12",
              lineStart: 17,
              lineEnd: 21,
              quote: "```yaml\non:\n  issues:\n    types: [opened, labeled]\n```",
            },
            createdAt: ago(1),
          },
        ]
      : [],
    artifacts: live
      ? [
          {
            id: "art_a",
            kind: "mockup",
            title: "A: GitHub connection",
            description:
              "One switch for the org. The label and trusted authors are set once, next to the thing they belong to.",
            revision: 2,
            keep: false,
            controls: ["--accent"],
            size: MOCKUP_A.length,
            updatedAt: ago(5),
          },
          {
            id: "art_b",
            kind: "mockup",
            title: "B: On each project",
            description:
              "Each project turns it on and sets its own label. More control, and more places to keep in step.",
            revision: 1,
            keep: false,
            controls: ["--accent"],
            size: MOCKUP_B.length,
            updatedAt: ago(9),
          },
        ]
      : [],
    // Spec 27: the person's edit of the Q3 line, which the planner kept.
    edits: live
      ? [
          {
            id: "pe_1",
            specId: "spec_wi_12",
            lineStart: 11,
            lineEnd: 11,
            before: "- New items land in the inbox of the project that owns the repository [Q3]",
            after: "- New items land in the Backlog of the project that owns the repository [Q3]",
            authorId: ME,
            authorName: "You",
            createdAt: ago(4),
            kept: true,
            whyNotKept: null,
            blocks: wrote(
              "- New items land in the Backlog of the project that owns the repository [Q3]",
            ),
          },
          {
            id: "pe_2",
            specId: "spec_wi_12",
            lineStart: 9,
            lineEnd: 9,
            before: "  - relabelling brings it in",
            after: "  - relabelling an open issue brings it in",
            authorId: ME,
            authorName: "You",
            createdAt: ago(3),
            kept: true,
            whyNotKept: null,
            blocks: wrote("  - relabelling an open issue brings it in"),
          },
          // Second review of #85: an edit the plan no longer keeps holds the gate until released.
          ...(dropped()
            ? [
                {
                  id: "pe_3",
                  specId: "spec_wi_12",
                  lineStart: 12,
                  lineEnd: 12,
                  before: "",
                  after: "- A closed issue is reopened when its item fails",
                  authorId: "u_ana",
                  authorName: "Ana",
                  createdAt: ago(2),
                  kept: false,
                  whyNotKept: "the plan doesn't have its words as written, in their place",
                  blocks: [
                    {
                      section: "Take work from GitHub issues › Scope",
                      parent: "",
                      text: "- A closed issue is reopened when its item fails",
                    },
                  ],
                },
              ]
            : []),
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
    items: ITEMS.filter((i) => !input.orgId || i.orgId === input.orgId),
  }),
  "workItem.get": (input) => detail(input.workItemId),
  "workItem.timeline": () => TIMELINE,
  "workItem.attachment.list": () => ({ attachments: [] }),
  "planning.get": (input) => planning(input.workItemId),
  "artifact.get": (input) => ({
    artifactId: input.artifactId,
    kind: "mockup",
    title: input.artifactId === "art_a" ? "A: GitHub connection" : "B: On each project",
    revision: input.artifactId === "art_a" ? 2 : 1,
    latest: input.artifactId === "art_a" ? 2 : 1,
    content: input.artifactId === "art_a" ? MOCKUP_A : MOCKUP_B,
    controls: ["--accent"],
  }),
  "run.live": () => liveView(),
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
        accounts: null,
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
