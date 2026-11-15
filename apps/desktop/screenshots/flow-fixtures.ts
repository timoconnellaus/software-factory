// The new core's fixtures (spec 70) for the screenshot harness, the behaviour tests and the route
// tests: one org's flow projects, agents and workflow, a board with an item in every state the
// board shows (working, needs you, waiting on a decision, stopped, resting), and the timelines the
// item panel draws, written as the kernel writes them (an event, then its effects, then an agent's
// summary) plus `card` entries in the shape plugins will send.
import type {
  FlowActor,
  FlowAgent,
  FlowGithubRepo,
  FlowInboxAllItem,
  FlowItem,
  FlowOpMap,
  FlowProject,
  FlowRun,
  FlowStatus,
  FlowTimelineEntry,
  FlowWorkflow,
} from "@software-factory/client/flow";
import type {
  FlowField,
  FlowGateway,
  FlowMember,
  FlowPluginDetail,
} from "@software-factory/client/flow-edit";
import type { FlowRunEvent, FlowRunView } from "@software-factory/client/flow-run";
import { CHAT_ANSWERS, CHAT_WORKFLOWS } from "./chat-fixtures.ts";
// A refused write carries its problems as the door does (`details`). fixtures.ts imports this file;
// Refusal is only used when an answer runs, after both have loaded.
import { Refusal } from "./fixtures.ts";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const ENOSPC =
  "The run's sandbox ran out of disk while installing dependencies (ENOSPC: no space left on device).";

export const FLOW_ME = "usr_owner";
export const FLOW_ORG = "org_personal";
export const API = "fprj_api";
export const LAUNCH = "fprj_launch";

/** The second org (All orgs, and an agent's work in another org). */
export const CLIENT_ORG = "org_client";
export const SITE = "fprj_site";

const AGENTS: FlowAgent[] = [
  {
    id: "fagt_lead",
    orgId: FLOW_ORG,
    name: "Lead",
    instructions: "Turn each item into a short plan the builders can follow.",
    createdAt: ago(9000),
  },
  {
    id: "fagt_backend",
    orgId: FLOW_ORG,
    name: "Backend",
    instructions:
      "Backend engineer. Take a feature from migration to an open pull request, with tests.",
    mcp: ["factory"],
    createdAt: ago(9000),
  },
  {
    id: "fagt_qa",
    orgId: FLOW_ORG,
    name: "QA",
    instructions: "Check the change does what the item asks. Say what you tried.",
    createdAt: ago(9000),
  },
  {
    // Chat's agent (flow.agent.ensureBuilder): the Plugin editor's "factory" server.
    id: "fagt_chat",
    orgId: FLOW_ORG,
    name: "Builder",
    instructions: "Set up how this org works when a person asks you to.",
    mcp: ["factory"],
    createdAt: ago(9000),
  },
  {
    id: "fagt_builder",
    orgId: CLIENT_ORG,
    name: "Builder",
    instructions: "Build the site's pages.",
    createdAt: ago(9000),
  },
];

export const MEMBERS: Record<string, FlowMember[]> = {
  [FLOW_ORG]: [
    { userId: FLOW_ME, name: "owner", login: "owner" },
    { userId: "usr_mia", name: "Mia Chen", login: "mia" },
  ],
  [CLIENT_ORG]: [
    { userId: FLOW_ME, name: "owner", login: "owner" },
    { userId: "usr_ria", name: "Ria Patel", login: "riap" },
  ],
};

const STATUSES: FlowStatus[] = [
  { id: "spec", name: "Spec", owner: { kind: "agent", agentId: "fagt_lead" } },
  { id: "build", name: "Build", owner: { kind: "agent", agentId: "fagt_backend" } },
  {
    id: "review",
    name: "Review",
    owner: { kind: "agent", agentId: "fagt_qa" },
    needsDecision: true,
  },
  { id: "approve", name: "Approve", owner: { kind: "person", userId: FLOW_ME } },
  { id: "shipped", name: "Shipped", owner: { kind: "none" } },
];

const WORKFLOWS: FlowWorkflow[] = [
  {
    id: "fwf_ship",
    orgId: FLOW_ORG,
    workflow: { id: "fwf_ship", name: "Ship a feature", statuses: STATUSES },
    createdAt: ago(9000),
    updatedAt: ago(9000),
  },
];

const PROJECTS: FlowProject[] = [
  {
    id: API,
    orgId: FLOW_ORG,
    name: "API Platform",
    key: "API",
    workflowId: "fwf_ship",
    nextNumber: 13,
    repo: { owner: "acme", name: "api", defaultBranch: "main" },
    createdAt: ago(9000),
  },
  {
    id: LAUNCH,
    orgId: FLOW_ORG,
    name: "Autopilots launch",
    key: "AL",
    workflowId: "fwf_ship",
    nextNumber: 1,
    createdAt: ago(600),
  },
  {
    id: SITE,
    orgId: CLIENT_ORG,
    name: "Website",
    key: "WEB",
    workflowId: "fwf_ship",
    nextNumber: 32,
    createdAt: ago(9000),
  },
];

const item = (
  id: string,
  number: number,
  title: string,
  statusId: string,
  waiting: FlowItem["waiting"],
  updated: number,
  over: Partial<FlowItem> = {},
): FlowItem => ({
  id,
  orgId: FLOW_ORG,
  projectId: API,
  number,
  title,
  body: "",
  statusId,
  waiting,
  error: null,
  stay: 1,
  createdBy: FLOW_ME,
  createdAt: ago(updated + 120),
  updatedAt: ago(updated),
  ...over,
});

export const FLOW_ITEMS: FlowItem[] = [
  item("fitm_usage", 5, "Per-key usage page", "spec", { on: "run", agentId: "fagt_lead" }, 25),
  item(
    "fitm_webhooks",
    12,
    "Move auth webhooks onto the job queue",
    "build",
    { on: "run", agentId: "fagt_backend" },
    14,
  ),
  item("fitm_postgres", 8, "Upgrade the Postgres driver to v5", "build", { on: "nothing" }, 40, {
    error: ENOSPC,
    body: "pg 4 is out of support. Move to v5 and drop the pool shim we added for 4.x.",
  }),
  item(
    "fitm_flaky",
    11,
    "Fix the flaky checkout test on CI",
    "review",
    { on: "run", agentId: "fagt_qa" },
    0.2,
  ),
  item("fitm_audit", 9, "Paginate the audit log endpoint", "review", { on: "decision" }, 60, {
    body: "The audit log returns every row. Page it by cursor, 100 at a time.",
  }),
  item(
    "fitm_rate",
    10,
    "Add rate limiting to the public API",
    "approve",
    { on: "person", userId: FLOW_ME },
    0.5,
    {
      body: "Public endpoints have no limits, so one noisy key can slow everyone down. Add per-key limits with sane defaults and a clear 429.",
    },
  ),
  item(
    "fitm_enum",
    7,
    "Rename the billing plan enum",
    "approve",
    { on: "person", userId: FLOW_ME },
    180,
  ),
  item("fitm_members", 4, "Lazy-load the members table", "shipped", { on: "nothing" }, 300),
  // The Client org's site: one waits on you, one is being built.
  item(
    "fitm_footer",
    31,
    "Invoice footer shows the old address",
    "approve",
    { on: "person", userId: FLOW_ME },
    65,
    { orgId: CLIENT_ORG, projectId: SITE },
  ),
  item(
    "fitm_booking",
    30,
    "Booking page loads slowly on phones",
    "build",
    { on: "run", agentId: "fagt_builder" },
    11,
    { orgId: CLIENT_ORG, projectId: SITE },
  ),
];

const me: FlowActor = { kind: "person", id: FLOW_ME };
const agent = (id: string): FlowActor => ({ kind: "agent", id });
const system: FlowActor = { kind: "system" };

/** Builds a timeline: each step is an entry; seq and times follow on. */
function timeline(steps: [FlowTimelineEntry["kind"], FlowActor, unknown, number][]) {
  return steps.map(([kind, actor, data, min], i) => ({
    seq: i + 1,
    kind,
    actor,
    data,
    createdAt: ago(min),
  }));
}

/** The item was created and its first status's agent started. */
const created = (min: number): [FlowTimelineEntry["kind"], FlowActor, unknown, number][] => [
  ["event", me, { type: "created" }, min],
  ["effect", me, { type: "entered", from: null, to: "spec", by: system }, min],
  ["effect", me, { type: "run.start", agentId: "fagt_lead", statusId: "spec", stay: 1 }, min],
];

/** An agent's run ended done: the item moves on, the next owner gets it, the summary follows. */
const ended = (
  by: string,
  from: string,
  to: string,
  next: unknown,
  summary: string,
  min: number,
  runId?: string,
): [FlowTimelineEntry["kind"], FlowActor, unknown, number][] => [
  ["event", agent(by), { type: "run.ended", stay: 1, outcome: "done", runId }, min],
  ["effect", agent(by), { type: "entered", from, to, by: agent(by) }, min],
  ["effect", agent(by), next, min],
  // The summary carries its run's id, as the store writes it: its run line opens the run.
  ["comment", agent(by), runId ? { text: summary, runId } : { text: summary }, min],
];

export const PLAN_CARD = {
  kind: "plan",
  title: "Build plan",
  subtitle: "3 steps",
  rows: [
    { label: "1", value: "Token bucket per API key" },
    { label: "2", value: "Shared counters in Redis" },
    { label: "3", value: "429 with a Retry-After header" },
  ],
};

export const PR_CARD = {
  kind: "pull-request",
  title: "#318 Rate limit the public API",
  subtitle: "+184 −12",
  checks: [
    { label: "Build", ok: true },
    { label: "212 tests", ok: true },
    { label: "Lint", ok: true },
  ],
  link: { label: "Open #318", url: "https://github.com/acme/api/pull/318" },
};

export const LOAD_CARD = {
  kind: "chart",
  title: "Requests let through under load",
  subtitle: "per second, per key",
  bars: [
    { label: "Free plan", value: 10, max: 50 },
    { label: "Team plan", value: 30, max: 50 },
    { label: "Enterprise", value: 50, max: 50 },
  ],
};

const TIMELINES: Record<string, FlowTimelineEntry[]> = {
  fitm_rate: timeline([
    ...created(130),
    ...ended(
      "fagt_lead",
      "spec",
      "build",
      { type: "run.start", agentId: "fagt_backend", statusId: "build", stay: 2 },
      "Here is the plan.",
      120,
      "frun_rate_spec",
    ),
    ["card", agent("fagt_lead"), PLAN_CARD, 120],
    ...ended(
      "fagt_backend",
      "build",
      "review",
      { type: "run.start", agentId: "fagt_qa", statusId: "review", stay: 3 },
      "Limiter and tests are in.",
      40,
      "frun_fitm_rate",
    ),
    ["card", agent("fagt_backend"), PR_CARD, 40],
    [
      "event",
      agent("fagt_qa"),
      { type: "run.ended", stay: 3, outcome: "done", runId: "frun_rate_review" },
      9,
    ],
    ["effect", agent("fagt_qa"), { type: "decision.ask", statusId: "review" }, 9],
    [
      "comment",
      agent("fagt_qa"),
      {
        text: "Reviewed #318. One note, fixed: Retry-After now rounds up, so clients never retry at once.",
        runId: "frun_rate_review",
      },
      9,
    ],
    ["card", agent("fagt_qa"), LOAD_CARD, 9],
    ["event", me, { type: "decided", by: me, decision: "approve" }, 8],
    ["effect", me, { type: "entered", from: "review", to: "approve", by: me }, 8],
    ["effect", me, { type: "inbox.add", userId: FLOW_ME, statusId: "approve", reason: "work" }, 8],
    ["comment", me, { text: "I'll check the 429 copy before this ships." }, 1],
  ]),
  fitm_postgres: timeline([
    ...created(160),
    ...ended(
      "fagt_lead",
      "spec",
      "build",
      { type: "run.start", agentId: "fagt_backend", statusId: "build", stay: 2 },
      "Plan: bump pg, remove the pool shim, run the integration suite.",
      90,
    ),
    ["event", agent("fagt_backend"), { type: "run.failed", stay: 2, error: "ENOSPC" }, 40],
    ["effect", agent("fagt_backend"), { type: "stopped", statusId: "build", error: "ENOSPC" }, 40],
  ]),
  fitm_audit: timeline([
    ...created(200),
    ...ended(
      "fagt_lead",
      "spec",
      "build",
      { type: "run.start", agentId: "fagt_backend", statusId: "build", stay: 2 },
      "Cursor pagination on created_at, id.",
      150,
    ),
    ...ended(
      "fagt_backend",
      "build",
      "review",
      { type: "run.start", agentId: "fagt_qa", statusId: "review", stay: 3 },
      "Paged, with a test for the cursor's edge.",
      90,
    ),
    ["event", agent("fagt_qa"), { type: "run.ended", stay: 3, outcome: "done" }, 60],
    ["effect", agent("fagt_qa"), { type: "decision.ask", statusId: "review" }, 60],
    ["comment", agent("fagt_qa"), { text: "Looks right. Ready for a decision." }, 60],
  ]),
};

const find = (itemId: string) => FLOW_ITEMS.find((i) => i.id === itemId);

/** An item as `flow.inbox.all` lists it: its project and status named. */
const named = (i: FlowItem): FlowInboxAllItem => {
  const project = PROJECTS.find((p) => p.id === i.projectId);
  return {
    ...i,
    projectName: project?.name ?? "",
    projectKey: project?.key ?? "",
    statusName: STATUSES.find((s) => s.id === i.statusId)?.name ?? i.statusId,
  };
};

/** Backend's runs, newest first: the one going now, then what it finished. */
const run = (
  itemId: string,
  itemTitle: string,
  status: string,
  started: number,
  took: number | null,
  over: Partial<FlowRun> = {},
): FlowRun => ({
  id: `frun_${itemId}`,
  itemId,
  itemTitle,
  agentId: "fagt_backend",
  status,
  claimedAt: ago(started),
  finishedAt: took === null ? null : ago(started - took),
  error: null,
  ...over,
});
const RUNS: FlowRun[] = [
  run("fitm_webhooks", "Move auth webhooks onto the job queue", "claimed", 14, null, {
    steps: 9,
    costUsd: null,
  }),
  // 15m 3s, as the mockup's.
  run("fitm_rate", "Add rate limiting to the public API", "done", 55.05, 15.05, {
    result: { outcome: "done" },
    steps: 13,
    costUsd: null,
  }),
  run("fitm_audit", "Paginate the audit log endpoint", "done", 110, 17, { steps: 8 }),
  run("fitm_postgres", "Upgrade the Postgres driver to v5", "failed", 41.5, 1.5, {
    error: ENOSPC,
    steps: 3,
    costUsd: null,
  }),
  run("fitm_enum", "Rename the billing plan enum", "done", 60 * 26, 10, { steps: 5 }),
];

// ---- Runs (the run view, .kim/mockups/run.html) -------------------------------------------------

/** A run's events, each at `sec` seconds after it was claimed (`claimedMin` minutes ago). */
function events(
  claimedMin: number,
  list: (
    | [number, "note", string]
    | [number, "tool", string, string, Record<string, unknown>, string | null]
    | [number, "result", string, string, boolean?]
  )[],
): FlowRunEvent[] {
  const start = now - claimedMin * 60_000;
  return list.map((e, i) => {
    const at = new Date(start + e[0] * 1000).toISOString();
    const seq = i + 1;
    if (e[1] === "note") return { seq, at, kind: "note", text: e[2] };
    if (e[1] === "tool")
      return {
        seq,
        at,
        kind: "tool",
        name: e[2],
        label: e[3],
        input: JSON.stringify(e[4]),
        toolId: e[5],
      };
    return { seq, at, kind: "result", toolId: e[2], output: e[3], isError: e[4] ?? false };
  });
}

/** A tool call and its result `took` seconds later, with its own id. */
let toolNo = 0;
const call = (
  sec: number,
  took: number,
  name: string,
  label: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
) => {
  const id = `toolu_${++toolNo}`;
  return [
    [sec, "tool", name, label, input, id] as [number, "tool", string, string, typeof input, string],
    [sec + took, "result", id, output, isError] as [number, "result", string, string, boolean],
  ];
};

const TEST_FAIL = `ok    acme/api    1.84s
--- FAIL: TestLimiter_RetryAfter (0.00s)
    limiter_test.go:58: Retry-After = 0, want 1
FAIL  acme/api/ratelimit  0.41s`;

const RATE_EVENTS = events(55.05, [
  [
    33,
    "note",
    "Plan: a per-key token bucket in front of the /v1 router, limits read from the customer's plan, and a 429 with Retry-After when the bucket is empty.",
  ],
  ...call(58, 1.6, "Grep", "api/", { pattern: "func NewRouter", path: "api/" }, "api/router.go:14"),
  ...call(80, 1.6, "Read", "api/router.go", { file_path: "api/router.go" }, "package api\n…"),
  ...call(
    116,
    1.6,
    "Read",
    "billing/plans.go",
    { file_path: "billing/plans.go" },
    "package billing\n…",
  ),
  ...call(
    264,
    1.6,
    "Write",
    "api/ratelimit/limiter.go",
    { file_path: "api/ratelimit/limiter.go", content: "package ratelimit\n…" },
    "File created.",
  ),
  ...call(
    339,
    1.6,
    "Edit",
    "api/router.go",
    {
      file_path: "api/router.go",
      old_string: "r := chi.NewRouter()",
      new_string: "r := chi.NewRouter()\n\tr.Use(ratelimit.Middleware(plans))",
    },
    "The file api/router.go has been updated.",
  ),
  ...call(
    495,
    30,
    "Bash",
    "Run the API tests",
    { command: "go test ./api/...", description: "Run the API tests" },
    TEST_FAIL,
    true,
  ),
  [
    561,
    "note",
    "Retry-After rounds sub-second waits down to 0, which tells clients to retry at once. Rounding up instead.",
  ],
  ...call(
    603,
    1.6,
    "Edit",
    "api/ratelimit/limiter.go",
    {
      file_path: "api/ratelimit/limiter.go",
      old_string: "int(wait.Seconds())",
      new_string: "int(math.Ceil(wait.Seconds()))",
    },
    "The file api/ratelimit/limiter.go has been updated.",
  ),
  ...call(
    627,
    26,
    "Bash",
    "Run the API tests",
    { command: "go test ./api/...", description: "Run the API tests" },
    "ok    acme/api            1.84s\nok    acme/api/ratelimit  0.44s",
  ),
  [693, "note", "Tests pass. Opening the pull request."],
  ...call(
    712,
    4,
    "Bash",
    "Open the pull request",
    {
      command: 'gh pr create --title "Rate limit the public API" --fill',
      description: "Open the pull request",
    },
    "https://github.com/acme/api/pull/318",
  ),
  ...call(
    730,
    1.2,
    "Read",
    "api/ratelimit/limiter_test.go",
    { file_path: "api/ratelimit/limiter_test.go" },
    "package ratelimit\n…",
  ),
  ...call(
    760,
    2.2,
    "Grep",
    "Retry-After",
    { pattern: "Retry-After", path: "docs/" },
    "docs/api/errors.md:41",
  ),
  ...call(
    802,
    1.6,
    "Edit",
    "docs/api/errors.md",
    { file_path: "docs/api/errors.md", old_string: "429", new_string: "429 Too Many Requests" },
    "The file docs/api/errors.md has been updated.",
  ),
  ...call(
    840,
    3.1,
    "Bash",
    "Push the docs fix",
    { command: "git push", description: "Push the docs fix" },
    "To github.com:acme/api.git",
  ),
  [880, "note", "Limiter and tests are in. #318 is open with the docs updated."],
]);

/** In flight: claimed 14 minutes ago; its last call has no result yet. */
const WEBHOOK_EVENTS = events(14, [
  [
    21,
    "note",
    "The auth webhooks run inline in the request. I'll move them onto the job queue and keep the 200 fast.",
  ],
  ...call(
    40,
    1.4,
    "Grep",
    "webhook",
    { pattern: "webhook", path: "auth/" },
    "auth/hooks.go:22\nauth/hooks.go:61",
  ),
  ...call(66, 1.6, "Read", "auth/hooks.go", { file_path: "auth/hooks.go" }, "package auth\n…"),
  ...call(98, 1.5, "Read", "jobs/queue.go", { file_path: "jobs/queue.go" }, "package jobs\n…"),
  ...call(
    250,
    1.6,
    "Write",
    "auth/hook_job.go",
    { file_path: "auth/hook_job.go", content: "package auth\n…" },
    "File created.",
  ),
  ...call(
    330,
    1.6,
    "Edit",
    "auth/hooks.go",
    {
      file_path: "auth/hooks.go",
      old_string: "deliver(ev)",
      new_string: "jobs.Enqueue(HookJob{ev})",
    },
    "The file auth/hooks.go has been updated.",
  ),
  ...call(
    410,
    41,
    "Bash",
    "Run the auth tests",
    { command: "go test ./auth/...", description: "Run the auth tests" },
    "ok    acme/auth  2.31s",
  ),
  [520, "note", "Tests pass. Checking that a failed delivery is retried with backoff."],
  ...call(560, 1.6, "Read", "jobs/retry.go", { file_path: "jobs/retry.go" }, "package jobs\n…"),
  [
    800,
    "tool",
    "Bash",
    "Run the job queue tests",
    { command: "go test ./jobs/... -run Retry", description: "Run the job queue tests" },
    "toolu_live",
  ],
]);

const POSTGRES_EVENTS = events(41.5, [
  [12, "note", "Bumping pg to v5 and removing the pool shim."],
  ...call(
    30,
    1.6,
    "Edit",
    "package.json",
    { file_path: "package.json", old_string: '"pg": "^4.9.0"', new_string: '"pg": "^5.0.0"' },
    "The file package.json has been updated.",
  ),
  ...call(
    48,
    38,
    "Bash",
    "Install dependencies",
    { command: "pnpm install", description: "Install dependencies" },
    "ERR_PNPM_ENOSPC  ENOSPC: no space left on device, write\n\nThis error happened while installing the dependencies of pg@5.0.0",
    true,
  ),
  ...call(
    87,
    0.4,
    "Bash",
    "Check the free disk",
    { command: "df -h .", description: "Check the free disk" },
    "Filesystem  Size  Used Avail Use%\n/dev/disk3  20G   20G    0  100%",
  ),
]);

/** The summary runs of the Lead and QA on API-10, so their run lines open too. */
const SPEC_EVENTS = events(130, [
  [15, "note", "Reading the item and the API's router to write the plan."],
  ...call(30, 1.2, "Read", "api/router.go", { file_path: "api/router.go" }, "package api\n…"),
  ...call(70, 1.5, "Grep", "plan", { pattern: "Plan", path: "billing/" }, "billing/plans.go:8"),
  [400, "note", "Here is the plan."],
]);
const REVIEW_EVENTS = events(15.7, [
  [20, "note", "Reviewing #318."],
  ...call(
    40,
    2.1,
    "Bash",
    "Check out the pull request",
    { command: "gh pr checkout 318", description: "Check out the pull request" },
    "Switched to branch 'rate-limit'",
  ),
  ...call(
    120,
    27,
    "Bash",
    "Run the tests",
    { command: "go test ./...", description: "Run the tests" },
    "ok    acme/api  1.84s",
  ),
  [380, "note", "Retry-After now rounds up; looks right."],
]);

const runView = (
  id: string,
  over: Partial<FlowRunView> & Pick<FlowRunView, "agentId" | "status" | "claimedAt">,
): FlowRunView => {
  const finished = over.finishedAt ?? null;
  return {
    id,
    orgId: FLOW_ORG,
    itemId: "fitm_rate",
    statusId: "build",
    stay: 2,
    brief: "",
    runnerId: "rnr_m5",
    result: null,
    error: null,
    createdAt: over.claimedAt ?? ago(0),
    finishedAt: null,
    itemTitle: "Add rate limiting to the public API",
    itemNumber: 10,
    projectId: API,
    projectKey: "API",
    agentName: AGENTS.find((a) => a.id === over.agentId)?.name ?? null,
    statusName: "Build",
    startedBy: "entering Build",
    durationMs:
      finished && over.claimedAt ? Date.parse(finished) - Date.parse(over.claimedAt) : null,
    steps: 0,
    costUsd: null,
    tokens: null,
    runnerName: "M5",
    eventsTruncated: false,
    eventsRemoved: false,
    ...over,
  };
};

const toolCount = (list: FlowRunEvent[]) => list.filter((e) => e.kind === "tool").length;

export const RUN_VIEWS: Record<string, { run: FlowRunView; events: FlowRunEvent[] }> = {
  frun_fitm_rate: {
    run: runView("frun_fitm_rate", {
      agentId: "fagt_backend",
      status: "done",
      claimedAt: ago(55.05),
      finishedAt: ago(40),
      result: { outcome: "done", summary: "Limiter and tests are in." },
      steps: toolCount(RATE_EVENTS),
      tokens: 1_240_000,
    }),
    events: RATE_EVENTS,
  },
  frun_fitm_webhooks: {
    run: runView("frun_fitm_webhooks", {
      agentId: "fagt_backend",
      status: "claimed",
      claimedAt: ago(14),
      itemId: "fitm_webhooks",
      itemTitle: "Move auth webhooks onto the job queue",
      itemNumber: 12,
      steps: toolCount(WEBHOOK_EVENTS),
    }),
    events: WEBHOOK_EVENTS,
  },
  frun_fitm_postgres: {
    run: runView("frun_fitm_postgres", {
      agentId: "fagt_backend",
      status: "failed",
      claimedAt: ago(41.5),
      finishedAt: ago(40),
      error: ENOSPC,
      itemId: "fitm_postgres",
      itemTitle: "Upgrade the Postgres driver to v5",
      itemNumber: 8,
      steps: toolCount(POSTGRES_EVENTS),
    }),
    events: POSTGRES_EVENTS,
  },
  frun_rate_spec: {
    run: runView("frun_rate_spec", {
      agentId: "fagt_lead",
      status: "done",
      claimedAt: ago(127),
      finishedAt: ago(120),
      statusId: "spec",
      stay: 1,
      statusName: "Spec",
      startedBy: "entering Spec",
      steps: toolCount(SPEC_EVENTS),
    }),
    events: SPEC_EVENTS,
  },
  frun_rate_review: {
    run: runView("frun_rate_review", {
      agentId: "fagt_qa",
      status: "done",
      claimedAt: ago(15.7),
      finishedAt: ago(9),
      statusId: "review",
      stay: 3,
      statusName: "Review",
      startedBy: "entering Review",
      steps: toolCount(REVIEW_EVENTS),
    }),
    events: REVIEW_EVENTS,
  },
};

/** An item's runs as `flow.run.list { itemId }` lists them, by stay. */
const itemRunsOf = (itemId: string): FlowRun[] =>
  Object.values(RUN_VIEWS)
    .filter((v) => v.run.itemId === itemId)
    .sort((a, b) => a.run.stay - b.run.stay || a.run.createdAt.localeCompare(b.run.createdAt))
    .map(({ run: r }) => ({
      id: r.id,
      itemId,
      itemTitle: r.itemTitle ?? undefined,
      agentId: r.agentId,
      status: r.status,
      createdAt: r.createdAt,
      claimedAt: r.claimedAt,
      finishedAt: r.finishedAt,
      result: r.result,
      error: r.error,
      steps: r.steps,
      costUsd: r.costUsd,
      tokens: r.tokens,
    }));

// ---- The inbox, workflow editor, plugins and gateways (flow-edit.ts) ----------------------------

/** The fields a plugin added (Customer feedback's "Customer"), and two items that carry them. */
const FIELDS: FlowField[] = [
  { id: "customer", label: "Customer", type: "text" },
  { id: "priority", label: "Priority", type: "text" },
];
for (const [id, fields] of [
  ["fitm_audit", { customer: "Northwind", priority: "High" }],
  ["fitm_usage", { customer: "Acme" }],
] as const) {
  const it = find(id);
  if (it) it.fields = fields;
}

const PLUGINS: FlowPluginDetail[] = [
  {
    id: "fplg_blog",
    name: "Publish to the blog",
    request: "When an item reaches Shipped, post it to our blog and put the link on the item.",
    enabled: true,
    lastError: null,
    updatedAt: ago(2 * 24 * 60),
    code: `export default definePlugin({\n  name: "Publish to the blog",\n  on: { entered: "shipped" },\n  async run({ item, gateways, card }) {\n    const post = await gateways.blog.post("/posts", { title: item.title, body: item.body });\n    await card({ kind: "link", title: "Published", link: { label: "Read it", url: post.url } });\n  },\n});\n`,
  },
  {
    id: "fplg_customer",
    name: "Customers on feedback",
    request:
      "Items in Customer feedback need a Customer field shown on the board, and a new support email should create an item.",
    enabled: true,
    lastError: null,
    updatedAt: ago(7 * 24 * 60),
    hooks: ["trigger"],
    triggerPath: "/flow/triggers/fplg_customer/<name>?key=5f1c9a0e7b2d4c68a3e1f09b7d6c2a4e8b3f5d1c",
    code: `export default definePlugin({\n  name: "Customers on feedback",\n  fields: [{ id: "customer", label: "Customer", type: "text" }],\n});\n`,
  },
  {
    id: "fplg_slack",
    name: "Slack updates",
    request: "Tell #launch in Slack whenever a launch item changes status.",
    enabled: false,
    lastError:
      "Failed 20 minutes ago on AL-3: Slack said the channel #launch wasn't found. The item is stopped.",
    updatedAt: ago(3 * 24 * 60),
    code: `export default definePlugin({\n  name: "Slack updates",\n  on: { moved: "*" },\n  async run({ item, gateways }) {\n    await gateways.slack.post("/chat.postMessage", { channel: "#launch", text: item.title });\n  },\n});\n`,
  },
];

/** What the personal org's GitHub connection reaches; the client org has none. */
const GITHUB_REPOS: FlowGithubRepo[] = [
  { owner: "acme", name: "api", defaultBranch: "main", installationId: "4100" },
  { owner: "acme", name: "launch-site", defaultBranch: "main", installationId: "4100" },
  { owner: "acme", name: "mobile", defaultBranch: "develop", installationId: "4100" },
];

/** The built-in `github` gateway an org with a GitHub connection has: listed, never edited. */
const BUILTIN_GITHUB: FlowGateway = {
  id: "builtin:github",
  name: "github",
  baseUrl: "https://api.github.com/repos/{owner}/{name}",
  auth: { kind: "bearer" },
  hasSecret: true,
  builtIn: true,
  description: "GitHub, connected as acme",
};

const GATEWAYS: FlowGateway[] = [
  {
    id: "fgw_github",
    name: "GitHub",
    baseUrl: "https://api.github.com",
    auth: { kind: "bearer" },
    hasSecret: true,
  },
  {
    id: "fgw_blog",
    name: "Blog",
    baseUrl: "https://acme.example/blog/api",
    auth: { kind: "header", header: "X-Api-Key" },
    hasSecret: true,
  },
  {
    id: "fgw_status",
    name: "Status page",
    baseUrl: "https://status.acme.example",
    auth: { kind: "none" },
    hasSecret: false,
  },
  {
    id: "fgw_stripe",
    name: "Stripe",
    baseUrl: "https://api.stripe.com",
    auth: { kind: "bearer" },
    hasSecret: false,
  },
];

/** The kernel's checks (packages/flow checkWorkflow), and a name every status needs. */
function checked(statuses: FlowStatus[]): FlowStatus[] {
  const problems: { statusId: string | null; message: string }[] = [];
  const ids = new Set(statuses.map((s) => s.id));
  for (const s of statuses) {
    if (!s.name.trim()) problems.push({ statusId: s.id, message: "A status needs a name." });
    for (const [field, label] of [
      ["onDone", "When done, move to"],
      ["onReject", "If rejected, send back to"],
    ] as const) {
      const target = s[field];
      if (target !== undefined && !ids.has(target))
        problems.push({
          statusId: s.id,
          message: `"${label}" on ${s.name} names "${target}", which isn't a status in this workflow.`,
        });
    }
  }
  if (problems.length)
    throw new Refusal("invalid_input", problems.map((p) => p.message).join(" "), problems);
  return statuses;
}

type FlowAnswers = {
  [N in keyof FlowOpMap]?: (input: FlowOpMap[N]["input"]) => FlowOpMap[N]["output"];
};

export const FLOW_ANSWERS: FlowAnswers = {
  "flow.project.list": (input) => ({ projects: PROJECTS.filter((p) => p.orgId === input.orgId) }),
  "flow.project.create": (input) => ({
    id: "fprj_new",
    orgId: input.orgId,
    name: input.name,
    key: input.key,
    workflowId: input.workflowId,
    nextNumber: 1,
    createdAt: ago(0),
  }),
  "flow.workflow.list": (input) => ({
    workflows: WORKFLOWS.filter((w) => w.orgId === input.orgId),
  }),
  "flow.workflow.get": (input) =>
    [...WORKFLOWS, ...CHAT_WORKFLOWS].find((w) => w.id === input.workflowId) ??
    (WORKFLOWS[0] as FlowWorkflow),
  "flow.agent.list": (input) => ({ agents: AGENTS.filter((a) => a.orgId === input.orgId) }),
  "flow.board.get": (input) => ({
    columns: STATUSES.map((status) => ({
      status,
      items: FLOW_ITEMS.filter((i) => i.projectId === input.projectId && i.statusId === status.id),
    })),
    truncated: false,
    declaredFields: FIELDS,
  }),
  "flow.timeline.get": (input) => ({ entries: TIMELINES[input.itemId] ?? [], truncated: false }),
  "flow.inbox.get": (input) => {
    const inOrg = FLOW_ITEMS.filter((i) => i.orgId === input.orgId);
    return {
      work: inOrg.filter((i) => i.waiting.on === "person" && i.waiting.userId === FLOW_ME),
      decisions: inOrg.filter((i) => i.waiting.on === "decision"),
      // What you finished or decided last: the shipped item, then the one you approved.
      done: [
        { ...named(find("fitm_members") as FlowItem), doneAt: ago(300) },
        { ...named(find("fitm_enum") as FlowItem), doneAt: ago(60 * 26) },
      ].filter((i) => i.orgId === input.orgId),
      truncated: false,
    };
  },
  "flow.inbox.all": () => ({
    orgs: [
      { orgId: FLOW_ORG, name: "Personal" },
      { orgId: CLIENT_ORG, name: "Client" },
    ].map((o) => {
      const items = FLOW_ITEMS.filter((i) => i.orgId === o.orgId).map(named);
      return {
        ...o,
        work: items.filter((i) => i.waiting.on === "person" && i.waiting.userId === FLOW_ME),
        decisions: items.filter((i) => i.waiting.on === "decision"),
        working: items.filter((i) => i.waiting.on === "run"),
      };
    }),
  }),
  "flow.member.list": (input) => ({ members: MEMBERS[input.orgId] ?? [] }),
  "flow.agent.create": (input) => ({
    id: "fagt_new",
    orgId: input.orgId,
    name: input.name,
    instructions: input.instructions,
    mcp: input.mcp ?? [],
    createdAt: ago(0),
  }),
  "flow.agent.update": (input) => ({
    ...(AGENTS.find((a) => a.id === input.agentId) as FlowAgent),
    name: input.name,
    instructions: input.instructions,
    mcp: input.mcp ?? [],
  }),
  "flow.run.list": (input) => ({
    runs: input.itemId
      ? itemRunsOf(input.itemId)
      : RUNS.filter((r) => r.agentId === input.agentId).slice(0, input.limit ?? 20),
  }),
  "flow.run.get": (input) => {
    const found = RUN_VIEWS[input.runId];
    if (!found) throw new Refusal("not_found", `No run ${input.runId} in this org.`);
    return { run: found.run };
  },
  "flow.run.events": (input) => {
    const found = RUN_VIEWS[input.runId];
    if (!found) throw new Refusal("not_found", `No run ${input.runId} in this org.`);
    return {
      events: found.events.filter((e) => input.after === undefined || e.seq > input.after),
      truncated: found.run.eventsTruncated,
      done: found.run.status !== "queued" && found.run.status !== "claimed",
    };
  },
  "flow.item.get": (input) => ({
    ...(find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem)),
    declaredFields: FIELDS,
  }),
  "flow.item.create": (input) =>
    item("fitm_new", 13, input.title, "spec", { on: "run", agentId: "fagt_lead" }, 0, {
      projectId: input.projectId,
      body: input.body ?? "",
    }),
  "flow.item.finish": (input) => find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem),
  "flow.item.decide": (input) => find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem),
  "flow.item.retry": (input) => find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem),
  "flow.item.comment": () => ({ ok: true }),
  "flow.workflow.update": (input) => {
    const found =
      WORKFLOWS.find((w) => w.id === input.workflowId) ?? (WORKFLOWS[0] as FlowWorkflow);
    found.workflow = { id: found.id, name: input.name, statuses: checked(input.statuses) };
    found.updatedAt = ago(0);
    return found;
  },
  "flow.workflow.create": (input) => {
    const made: FlowWorkflow = {
      id: `fwf_${WORKFLOWS.length + 1}`,
      orgId: input.orgId,
      workflow: {
        id: `fwf_${WORKFLOWS.length + 1}`,
        name: input.name,
        statuses: checked(input.statuses),
      },
      createdAt: ago(0),
      updatedAt: ago(0),
    };
    WORKFLOWS.push(made);
    return made;
  },
  "flow.project.setWorkflow": (input) => {
    const project = PROJECTS.find((p) => p.id === input.projectId) ?? (PROJECTS[0] as FlowProject);
    project.workflowId = input.workflowId;
    return project;
  },
  "flow.plugin.list": () => ({ plugins: PLUGINS.map(({ code: _code, ...p }) => p) }),
  "flow.plugin.get": (input) =>
    PLUGINS.find((p) => p.name === input.name) ?? (PLUGINS[0] as FlowPluginDetail),
  "flow.plugin.setEnabled": (input) => {
    const { code: _code, ...found } =
      PLUGINS.find((p) => p.name === input.name) ?? (PLUGINS[0] as FlowPluginDetail);
    return { ...found, enabled: input.enabled };
  },
  "flow.plugin.delete": () => ({ ok: true }),
  "flow.gateway.list": (input) => ({
    gateways: input.orgId === FLOW_ORG ? [...GATEWAYS, BUILTIN_GITHUB] : GATEWAYS,
  }),
  "flow.github.repos": (input) =>
    input.orgId === FLOW_ORG
      ? { connected: true, account: "acme", repos: GITHUB_REPOS }
      : { connected: false, account: null, repos: [] },
  "flow.project.get": (input) =>
    PROJECTS.find((p) => p.id === input.projectId) ?? (PROJECTS[0] as FlowProject),
  // Not kept: the screens re-read the fixture's projects as they were.
  "flow.project.setRepository": (input) => {
    const project = PROJECTS.find((p) => p.id === input.projectId) ?? (PROJECTS[0] as FlowProject);
    if ("clear" in input) return { ...project, repo: null };
    const found = GITHUB_REPOS.find((r) => r.owner === input.owner && r.name === input.name);
    if (!found)
      throw new Refusal(
        "not_found",
        `The org's GitHub connection doesn't reach ${input.owner}/${input.name}.`,
      );
    return {
      ...project,
      repo: { owner: found.owner, name: found.name, defaultBranch: found.defaultBranch },
    };
  },
  "flow.gateway.save": (input) => ({
    id: GATEWAYS.find((g) => g.name === input.name)?.id ?? "fgw_new",
    name: input.name,
    baseUrl: input.baseUrl,
    auth: input.auth,
    hasSecret: input.secret != null || !!GATEWAYS.find((g) => g.name === input.name)?.hasSecret,
  }),
  "flow.gateway.delete": () => ({ ok: true }),
  // Chat (chat-fixtures.ts).
  ...CHAT_ANSWERS,
};
