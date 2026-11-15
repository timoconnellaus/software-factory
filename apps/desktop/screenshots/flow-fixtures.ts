// The new core's fixtures (spec 70) for the screenshot harness, the behaviour tests and the route
// tests: one org's flow projects, agents and workflow, a board with an item in every state the
// board shows (working, needs you, waiting on a decision, stopped, resting), and the timelines the
// item panel draws, written as the kernel writes them (an event, then its effects, then an agent's
// summary) plus `card` entries in the shape plugins will send.
import type {
  FlowActor,
  FlowAgent,
  FlowItem,
  FlowOpMap,
  FlowProject,
  FlowStatus,
  FlowTimelineEntry,
  FlowWorkflow,
} from "@software-factory/client/flow";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

export const FLOW_ME = "usr_owner";
export const FLOW_ORG = "org_personal";
export const API = "fprj_api";
export const LAUNCH = "fprj_launch";

const AGENTS: FlowAgent[] = [
  { id: "fagt_lead", orgId: FLOW_ORG, name: "Lead", instructions: "", createdAt: ago(9000) },
  { id: "fagt_backend", orgId: FLOW_ORG, name: "Backend", instructions: "", createdAt: ago(9000) },
  { id: "fagt_qa", orgId: FLOW_ORG, name: "QA", instructions: "", createdAt: ago(9000) },
];

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
    error:
      "The run's sandbox ran out of disk while installing dependencies (ENOSPC: no space left on device).",
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
): [FlowTimelineEntry["kind"], FlowActor, unknown, number][] => [
  ["event", agent(by), { type: "run.ended", stay: 1, outcome: "done" }, min],
  ["effect", agent(by), { type: "entered", from, to, by: agent(by) }, min],
  ["effect", agent(by), next, min],
  ["comment", agent(by), { text: summary }, min],
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
    ),
    ["card", agent("fagt_lead"), PLAN_CARD, 120],
    ...ended(
      "fagt_backend",
      "build",
      "review",
      { type: "run.start", agentId: "fagt_qa", statusId: "review", stay: 3 },
      "Limiter and tests are in.",
      40,
    ),
    ["card", agent("fagt_backend"), PR_CARD, 40],
    ["event", agent("fagt_qa"), { type: "run.ended", stay: 3, outcome: "done" }, 9],
    ["effect", agent("fagt_qa"), { type: "decision.ask", statusId: "review" }, 9],
    [
      "comment",
      agent("fagt_qa"),
      {
        text: "Reviewed #318. One note, fixed: Retry-After now rounds up, so clients never retry at once.",
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
    WORKFLOWS.find((w) => w.id === input.workflowId) ?? (WORKFLOWS[0] as FlowWorkflow),
  "flow.agent.list": (input) => ({ agents: AGENTS.filter((a) => a.orgId === input.orgId) }),
  "flow.board.get": (input) => ({
    columns: STATUSES.map((status) => ({
      status,
      items: FLOW_ITEMS.filter((i) => i.projectId === input.projectId && i.statusId === status.id),
    })),
    truncated: false,
  }),
  "flow.timeline.get": (input) => ({ entries: TIMELINES[input.itemId] ?? [], truncated: false }),
  "flow.inbox.get": () => ({
    work: FLOW_ITEMS.filter((i) => i.waiting.on === "person" && i.waiting.userId === FLOW_ME),
    decisions: FLOW_ITEMS.filter((i) => i.waiting.on === "decision"),
    truncated: false,
  }),
  "flow.item.get": (input) => find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem),
  "flow.item.create": (input) =>
    item("fitm_new", 13, input.title, "spec", { on: "run", agentId: "fagt_lead" }, 0, {
      projectId: input.projectId,
      body: input.body ?? "",
    }),
  "flow.item.finish": (input) => find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem),
  "flow.item.decide": (input) => find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem),
  "flow.item.retry": (input) => find(input.itemId) ?? (FLOW_ITEMS[0] as FlowItem),
  "flow.item.comment": () => ({ ok: true }),
};
