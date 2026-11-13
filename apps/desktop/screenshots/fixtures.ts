// The screenshot harness's fixture door (ADR 0460): typed answers to the reads the view makes, so
// every screen can be shot at 1440×900 without an engine. The work items echo the design files
// (docs/design/factory-ui) so the build and the design can be compared side by side. Never shipped:
// the app's own bridge talks to the main process.
import type { OpInput, OpName, OpOutput } from "@software-factory/client/ops";
import { type DesignPreview, planBlocks } from "@software-factory/client/planning";
// Spec 22 part B: two designs as the runner's checks drew them (packages/planning-designs), a
// pulled data model with its base, and an architecture the planner made.
import DESIGNS from "./design-fixtures.json" with { type: "json" };

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
const NOT_RUN_REASON = "this Mac runner has no container runtime";

/**
 * `?fixture=red`: the factory's repository has a red main (spec 53): #8's landing is the proven
 * culprit, the incident fix #40 is a repair merging, and #42 is held behind it.
 */
let seenRed = false;
const redFixture = () => {
  const where = `${globalThis.location?.search ?? ""}${globalThis.location?.hash ?? ""}`;
  seenRed ||= where.includes("fixture=red");
  return seenRed;
};
const RED_SINCE_MIN = 18;
/** `?fixture=red`'s approved item, held behind the red main. */
const HELD_44 = () =>
  item(44, "Cache the runner list", "merge", "waiting", {
    statusReason: "Approved: waiting to merge",
    priority: "high",
    updatedAt: ago(15),
  });
const RED_MAIN = () => ({
  projectId: FACTORY,
  name: "Factory",
  repositoryId: "repo_software-factory",
  repo: { owner: "example", name: "software-factory" },
  branch: "main",
  headSha: "4d1c9e2a7b",
  failing: ["ci", "typecheck"],
  redSince: ago(RED_SINCE_MIN),
  lastGreenSha: "b7e0f31c55",
});
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

/**
 * `?fixture=nochecks`: the project declares no checks and no required CI reported, so nothing can
 * be proven (the gate says so, no count). `?fixture=allproven`: every criterion tied to a check
 * that passed. Neither: checks set up, some criteria tied to none.
 */
let seenProof: "nochecks" | "allproven" | "triage" | null = null;
const proofFixture = () => {
  const where = `${globalThis.location?.search ?? ""}${globalThis.location?.hash ?? ""}`;
  if (where.includes("fixture=nochecks")) seenProof = "nochecks";
  else if (where.includes("fixture=allproven")) seenProof = "allproven";
  else if (where.includes("fixture=triage")) seenProof = "triage";
  return seenProof;
};
type ProofRow = {
  criterion: string | undefined;
  proven: boolean;
  provenBy: string[];
  unproven: string[];
  notCounted: string[];
  linkedBy: "spec" | "triage" | "reviewer";
  uncovered?: boolean;
  passedTriageCheck?: string[];
  fromTriage?: boolean;
  weakened: boolean;
  reviewerMet: boolean;
  opinion: string;
};
/** The proof as each fixture has it, and the count the packet stores beside it. */
function shapedProof(rows: ProofRow[]): { proof: ProofRow[]; proven: Record<string, unknown> } {
  const which = proofFixture();
  const proof =
    which === "nochecks"
      ? rows.map((r) => ({
          ...r,
          proven: false,
          provenBy: [],
          unproven: [],
          notCounted: [],
          uncovered: false,
        }))
      : which === "allproven"
        ? rows.map((r) => ({
            ...r,
            proven: true,
            provenBy: ["tests"],
            unproven: [],
            notCounted: [],
            linkedBy: "spec" as const,
            uncovered: false,
          }))
        : which === "triage"
          ? // Both kinds of tie: the first criterion in a person-approved spec, the rest from
            // triage's list (an agent's ties: passed, never Proven).
            rows.map((r, i) =>
              i === 0
                ? { ...r, proven: true, provenBy: ["tests"], linkedBy: "spec" as const }
                : i === 3
                  ? {
                      ...r,
                      proven: false,
                      provenBy: [],
                      unproven: [],
                      notCounted: [],
                      linkedBy: "triage" as const,
                      uncovered: true,
                      fromTriage: true,
                    }
                  : {
                      ...r,
                      proven: false,
                      provenBy: [],
                      unproven: [],
                      notCounted: [],
                      linkedBy: "triage" as const,
                      uncovered: false,
                      passedTriageCheck: ["tests"],
                      fromTriage: true,
                    },
            )
          : notRunFixture()
            ? notProven(rows)
            : rows;
  const person = proof.filter((r) => !r.fromTriage);
  const triage = proof.filter((r) => r.fromTriage);
  return {
    proof,
    proven: {
      proven: person.filter((r) => r.proven).length,
      total: person.length,
      ...(triage.length
        ? {
            triage: {
              passed: triage.filter((r) => r.passedTriageCheck?.length).length,
              total: triage.length,
            },
          }
        : {}),
      weakened: false,
      checksSetUp: which !== "nochecks",
    },
  };
}

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const ME = "usr_owner";
const PERSONAL = "org_personal";
const CLIENT = "org_client";
const FACTORY = "prj_factory";
const CRM = "prj_crm";
const SITE = "prj_site";
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
    priority: "normal",
    repositoryId: "repo_software-factory",
    releasedAt: ago(60 * 26),
    ...extra,
  };
}

/** Work before release (spec 50): captured in the backlog, shaped to ready, or queued. */
function pre(
  n: number,
  title: string,
  status: "backlog" | "ready" | "queued" | "shaping",
  extra: Partial<Summary> = {},
): Summary {
  return item(n, title, "intake", status, {
    size: null,
    releasedAt: status === "queued" ? ago(50) : null,
    ...extra,
  });
}

/** #16 was shaped, and its workflow's shaping stages changed before release (spec 52, Q4). */
const RELEASE_FLAG_16 = {
  reason:
    "#16 was shaped under org config v3; its workflow's shaping stages changed in v5. Shape it again under the current workflow, or accept the shaping already done and deliver it under the current workflow.",
  shapedUnder: 3,
  current: 5,
};

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
  item(7, "Rename the runner pairing command", "build", "cancelled", {
    statusReason: "by you, from the app",
    updatedAt: ago(60 * 70),
  }),
  item(6, "Retry verify when CI is late", "verify", "failed", {
    statusReason: "verify failed three times",
    updatedAt: ago(60 * 90),
  }),
  item(3, "Import contacts from a CSV", "build", "running", {
    projectId: CRM,
    orgId: CLIENT,
    repositoryId: "repo_crm",
    statusReason: "Builder",
    updatedAt: ago(22),
  }),
  // The backlog and ready (spec 50, design WorkBacklog/WorkReady), in pull order per state.
  pre(22, "Test the comment parser against every comment form", "backlog", {
    priority: "high",
    size: "small",
    createdAt: ago(120),
  }),
  pre(21, "Show cost per work item on the Done list", "backlog", {
    priority: "high",
    size: "medium",
    createdAt: ago(60 * 24),
  }),
  // No repository chosen: releasing it is refused (the behaviour tests' refused release).
  pre(20, "Runner offline alert has no link to the runner", "backlog", {
    createdAt: ago(60 * 48),
    repositoryId: null,
  }),
  pre(17, "Dark mode for the review packet", "backlog", {
    priority: "low",
    size: "small",
    createdAt: ago(60 * 120),
  }),
  pre(15, "Let a question be assigned to another member", "backlog", {
    priority: "low",
    size: "large",
    createdAt: ago(60 * 144),
  }),
  pre(16, "Record usage for every run", "ready", {
    priority: "high",
    size: "medium",
    createdAt: ago(60 * 72),
  }),
  pre(14, "Weekly regression run", "ready", {
    priority: "high",
    size: "small",
    createdAt: ago(60 * 96),
  }),
  pre(28, "Show the plan's age at release", "queued", { size: "small", createdAt: ago(60 * 30) }),
  pre(2, "Rewrite the pricing page intro", "ready", {
    id: "wi_site_2",
    projectId: SITE,
    repositoryId: null,
    size: "small",
    createdAt: ago(60 * 50),
  }),
  pre(5, "Import contacts from a vCard", "backlog", {
    id: "wi_crm_5",
    projectId: CRM,
    orgId: CLIENT,
    repositoryId: "repo_crm",
    size: "large",
    createdAt: ago(60 * 70),
  }),
];

/** "Waits for" links (spec 50): #21 waits for #16; #14 for #26, still in verify. */
const LINKS: [string, string][] = [
  ["wi_21", "wi_16"],
  ["wi_14", "wi_26"],
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
// (CONFIG_HISTORY, below the document, is its versions newest first.)
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

/** A project on the org's Software workflow, with one override of the org's value (spec 52). */
export const ON_ORG_WORKFLOW = {
  ...POLICY_DOC,
  workflow: "wf_software",
  workflowOverrides: { build: { retryLimit: 3 } },
};

/** The Factory project's config versions, newest first, as `config.get` lists them. */
export const CONFIG_HISTORY = [
  {
    version: 12,
    sha: "5da8988",
    source: "app",
    note: "Two agents and the Software workflow",
    createdBy: "owner",
    createdAt: ago(60 * 24 * 3),
    valid: true,
    impact: "neutral" as const,
    policy: POLICY_DOC,
  },
  {
    version: 11,
    sha: "a41c9e2",
    source: "improve",
    note: "The builder writes the failing test first",
    createdBy: null,
    createdAt: ago(60 * 24 * 4),
    valid: true,
    impact: "neutral" as const,
    policy: { ...POLICY_DOC, wipLimit: 5 },
  },
  {
    version: 10,
    sha: "77b0c1d",
    source: "app",
    note: "Waiting on you: 5 to 3",
    createdBy: "owner",
    createdAt: ago(60 * 24 * 9),
    valid: true,
    impact: "tightens" as const,
    policy: { ...POLICY_DOC, wipLimit: 5 },
  },
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
  // A project with no repository yet (ADR 0490): its work can be captured, not released.
  {
    ...project(SITE, PERSONAL, "Website", "website"),
    repo: null,
    repositories: [],
    connection: { status: "missing" as const, account: null, manageUrl: null },
  },
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
  releaseFlags: [
    {
      workItemId: "wi_16",
      projectId: FACTORY,
      number: 16,
      title: "Record usage for every run",
      ...RELEASE_FLAG_16,
      choices: ["reshape", "accept"],
    },
  ],
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
  // The "main is red" card (spec 53): only with `?fixture=red`.
  get mainRed() {
    return redFixture() ? [RED_MAIN()] : [];
  },
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

const PRE = ["backlog", "shaping", "ready", "queued"];
const ACTIVE_STATES = ["running", "waiting", "paused"];
const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];

function link(id: string) {
  const w = ITEMS.find((i) => i.id === id) as Summary;
  return { id: w.id, number: w.number, title: w.title, status: w.status, projectId: w.projectId };
}

/** `workItem.board` over the fixtures: the states asked for, in pull order, and counts per state. */
function board(input: OpInput<"workItem.board">): OpOutput<"workItem.board"> {
  const states = input.states ?? [...PRE, ...ACTIVE_STATES];
  const inOrg = [...ITEMS, ...(redFixture() ? [HELD_44()] : [])].filter(
    (i) => i.orgId === input.orgId && (!input.projectId || i.projectId === input.projectId),
  );
  const items = inOrg
    .filter((i) => (states as string[]).includes(i.status))
    .sort(
      (a, b) =>
        PRIORITY_ORDER.indexOf(a.priority ?? "normal") -
          PRIORITY_ORDER.indexOf(b.priority ?? "normal") ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt),
    )
    .map((i) => {
      const waitsFor = LINKS.filter(([from]) => from === i.id).map(([, to]) => link(to));
      return {
        id: i.id,
        projectId: i.projectId,
        number: i.number,
        title: i.title,
        kind: i.kind,
        status: i.status,
        statusReason: i.statusReason,
        stage: i.stage,
        // The item's phase (core's itemPhase): shaping before release, delivery from release on.
        phase: (["backlog", "shaping", "ready"].includes(i.status) ? "shaping" : "delivery") as
          | "shaping"
          | "delivery",
        priority: i.priority ?? "normal",
        rank: Date.parse(i.createdAt) / 1000,
        size: i.size,
        repositoryId: i.repositoryId ?? null,
        requesterUserId: i.requesterUserId,
        releasedAt: i.releasedAt ?? null,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        // Spec 24: #13 was split off #9's plan, so lists show it under #9.
        parentWorkItemId: i.id === "wi_13" ? "wi_9" : null,
        waitsFor,
        ...(i.id === "wi_16" ? { releaseFlag: RELEASE_FLAG_16 } : {}),
        blockedBy: waitsFor.filter((w) => w.status !== "done"),
      };
    });
  const counts = new Map<string, { projectId: string; status: string; n: number }>();
  for (const i of inOrg) {
    const key = `${i.projectId}:${i.status}`;
    const c = counts.get(key) ?? { projectId: i.projectId, status: i.status, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  return { items, counts: [...counts.values()] };
}

const STAGES_IN_ORDER = [
  ["triage", "Triage", "shaping"],
  ["spec", "Spec", "shaping"],
  ["build", "Build", "delivery"],
  ["verify", "Verify", "delivery"],
  ["merge", "Merge", "delivery"],
] as const;

/**
 * `project.workflow`: Factory runs an org workflow, Website runs the built-in one, CRM defines
 * workflows and names none (it fails closed: work is captured, never released).
 */
function workflowOf(projectId: string): OpOutput<"project.workflow"> {
  const stages = STAGES_IN_ORDER.map(([stage, label, phase]) => ({ stage, label, phase }));
  if (projectId === CRM) {
    return {
      projectId,
      workflow: null,
      unavailable: "the project defines workflows but names none for its items",
      stages,
    };
  }
  const workflow =
    projectId === FACTORY
      ? // On an org workflow (spec 52 PR (d)): named by its id, read by its name.
        { name: "wf_ship_it", label: "Ship it", description: "", builtIn: false }
      : {
          name: "software",
          label: "Software (built in)",
          description: "Triage, spec, build, verify and merge",
          builtIn: true,
        };
  return { projectId, workflow, unavailable: null, stages };
}

/** A work item: before release it has no stages, runs, spec or gates yet (spec 50). */
function detail(id: string): OpOutput<"workItem.get"> {
  const d = pipelineDetail(id);
  const links = {
    releasedBy: d.item.releasedAt ? ME : null,
    shaping: null,
    waitsFor: LINKS.filter(([from]) => from === id).map(([, to]) => link(to)),
    waitedOnBy: LINKS.filter(([, to]) => to === id).map(([from]) => link(from)),
    // Spec 24: #9's plan split into two work items; #13 is the first of them.
    split:
      id === "wi_9"
        ? {
            parent: null,
            children: [
              {
                id: "wi_13",
                number: 13,
                title: "Issue intake and the trusted-author filter",
                status: "waiting",
                stage: "merge",
                size: "small",
              },
              {
                id: "wi_split_2",
                number: 14,
                title: "Report back to the issue",
                status: "queued",
                stage: "intake",
                size: "small",
              },
            ],
            held: false,
          }
        : id === "wi_13"
          ? {
              parent: {
                id: "wi_9",
                number: 9,
                title: "Take work from GitHub issues",
                status: "running",
              },
              children: [],
              held: false,
            }
          : { parent: null, children: [], held: false },
  };
  if (!PRE.includes(d.item.status)) return { ...d, ...links };
  return {
    ...d,
    ...links,
    item: {
      ...d.item,
      body:
        id === "wi_21"
          ? "The Done list shows tokens. I want to see what each item cost in dollars too, so I can tell which kinds of work are expensive."
          : d.item.body,
      specRequired: null,
      specDecisionReason: null,
      readinessHint: null,
      needsInfo: null,
      domains: [],
      workflow: null,
      workflowReason: null,
    },
    stages: [],
    spec: null,
    questions: [],
    gates: [],
    runs: [],
    reviewPacket: null,
  };
}

function pipelineDetail(id: string): OpOutput<"workItem.get"> {
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
      readinessHint: null,
      needsInfo: null,
      domains: ["verify"],
      headSha: atMerge ? "3f2a91c8d0e1b2a3c4d5e6f708192a3b4c5d6e7f" : null,
      prNumber: atMerge ? 51 : null,
      policySha: "5da8988",
      workflow: "wf_ship_it",
      workflowReason: "the project's default",
    },
    workflows: [{ name: "wf_ship_it", description: "Ship it" }],
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
      // Spec 24: #12's plan splits into two work items (its card opens the plan to approve).
      splitInto: id === "wi_12" ? 2 : 0,
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
              : proofFixture() === "nochecks"
                ? { declared: [], results: [], extra: [] }
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
            ...shapedProof([
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
                // The spec says no declared check can prove it: honest, "not covered by a check".
                linkedBy: "spec",
                uncovered: true,
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
    log: "kept",
    archiveIncident: null,
  };
}

/** #13's activity: routine entries older than 90 days are in the audit archive (ADR 0591). */
const timeline = (archived: boolean): OpOutput<"workItem.timeline"> => ({
  ...TIMELINE,
  entries: archived
    ? [
        ...[
          ["lease.claim", "agent", "foreman", 60 * 25],
          ["job.claim", "runner", RUNNER, 60 * 25 - 1],
          ["run.handBack", "runner", RUNNER, 60 * 24],
        ].map(([operation, actorType, actorId, min], i) => ({
          id: `aud_old_${i}`,
          at: ago(min as number),
          operation: operation as string,
          actorType: actorType as string,
          actorId: actorId as string,
          decision: "allow",
          outcome: "ok",
          reason: null,
          pendingActionId: null,
          result: null,
          archived: true,
        })),
        ...TIMELINE.entries,
      ].sort((a, b) => (a.at < b.at ? -1 : 1))
    : TIMELINE.entries,
  archive: { rows: 3, chunks: 1, state: archived ? "read" : "available", more: false, next: null },
});

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
  archive: { rows: 0, chunks: 0, state: "none", more: false, next: null },
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
      childrenUnreadable: false,
      splitDigest: live ? "0".repeat(64) : null,
      // Spec 24, as in PlanFocus: the plan splits into two work items, approved together.
      children: live
        ? [
            {
              key: "intake",
              title: "Issue intake and the trusted-author filter",
              size: "small" as const,
              goal: "A labelled issue from a trusted author becomes a work item [parent]",
              scope: ["The issues webhook [parent]", "The trusted-author filter [Q2]"],
              acceptanceCriteria: ["A labelled issue appears in the Backlog [parent]"],
            },
            {
              key: "report",
              title: "Report back to the issue",
              size: "small" as const,
              goal: "The issue shows where its work got to [parent]",
              scope: ["One comment with a link, closed on merge [Q4]"],
              acceptanceCriteria: ["The issue is closed when its item merges [Q4]"],
              after: "intake",
            },
          ]
        : [],
      coverage: [],
      clarifications: [],
      summary: null,
      status: live ? "draft" : "approved",
      createdAt: ago(1),
      createdBy: "agent",
      // Spec 23 part C: the critic's notes on the plan going to the gate.
      critique: live
        ? {
            status: "done",
            notes: [
              "The plan doesn't say what happens to an issue whose label is removed after it became an item.",
              '"Within a minute" has no test: add one that measures the webhook to item time.',
            ],
            summary: "Two gaps; otherwise consistent with webhooks.ts.",
            at: ago(1),
          }
        : null,
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
          // Spec 22 part B: a comment pinned on a table of the pulled data model.
          {
            id: "m8",
            author: "person",
            authorId: ME,
            authorName: "You",
            text: "Keep the issue's node id too: numbers change when a repo is transferred.",
            questionId: null,
            replyTo: null,
            kind: "chat",
            deliveredAt: null,
            pin: {
              artifactId: "art_schema",
              element: "table github_issues",
              selector: null,
              x: 0,
              y: 0,
              fx: 0.85,
              fy: 0.2,
              width: 700,
            },
            anchor: null,
            createdAt: ago(0),
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
            designType: null,
            pulledPath: null,
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
            designType: null,
            pulledPath: null,
            updatedAt: ago(9),
          },
          {
            id: "art_schema",
            kind: "design",
            title: "work-items.dbml",
            description: "Pulled from .kim/designs/work-items.dbml",
            revision: 3,
            keep: true,
            controls: [],
            size: DESIGNS.art_schema.content.length,
            designType: "data-model",
            pulledPath: ".kim/designs/work-items.dbml",
            updatedAt: ago(3),
          },
          {
            id: "art_flow",
            kind: "design",
            title: "Issue intake",
            description: "How a labelled issue becomes a work item.",
            revision: 1,
            keep: true,
            controls: [],
            size: DESIGNS.art_flow.content.length,
            designType: "architecture",
            pulledPath: null,
            updatedAt: ago(6),
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
            mentions: [],
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
            mentions: [],
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
                  mentions: ["- Reopening issues the factory closed is out of scope"],
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

/** A design's revision as artifact.get gives it: revision 0 is a pulled file's base. */
function designGet(id: "art_schema" | "art_flow", revision: number | undefined) {
  const d = DESIGNS[id];
  const base = revision === 0 && d.base !== null;
  const latest = id === "art_schema" ? 3 : 1;
  return {
    artifactId: id,
    kind: "design",
    title: id === "art_schema" ? "work-items.dbml" : "Issue intake",
    revision: base ? 0 : latest,
    latest,
    content: base ? (d.base ?? "") : d.content,
    controls: [],
    designType: d.type,
    preview: (base ? d.basePreview : d.preview) as DesignPreview | null,
  };
}

/** A refusal in the server's shape: the fake door answers `{ ok: false, code, error }`. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Writes the behaviour tests (screenshots/behave.mjs) make. Nothing changes: each answers as the
 * server would, and the fake door records the call. Releasing #20 is refused as core refuses an
 * item with no repository.
 */
const released = (input: { workItemId: string }) => {
  const i = ITEMS.find((x) => x.id === input.workItemId);
  if (i && !i.repositoryId) {
    throw new Refusal(
      "conflict",
      `work item #${i.number} needs a repository: choose one of the project's 1 (workItem.update)`,
    );
  }
  return { status: "queued", blockedBy: [] };
};

/**
 * #9's first two runs show where an old run's log is (AGENTS.md "Cloudflare cost"): the triage
 * run's archived to R2, the spec run's lost from the archive with its incident open. (Real runs are
 * archived 30 days after they end; the fixture's are recent, for the shot.)
 */
function withArchivedLogs(d: OpOutput<"workItem.get">): OpOutput<"workItem.get"> {
  if (d.item.id !== "wi_9") return d;
  return {
    ...d,
    runs: d.runs.map((r) =>
      r.runNo === 1
        ? { ...r, log: "archived" as const }
        : r.runNo === 2
          ? {
              ...r,
              log: "missing" as const,
              archiveIncident: { id: "incident_lost", resolvedAt: null },
            }
          : r,
    ),
  };
}

/** One open archive incident: #4's run 2 lost an object from sf-archive. */
const ARCHIVE_INCIDENTS = () => {
  const four = ITEMS.find((i) => i.number === 4);
  return four
    ? [
        {
          id: "incident_lost",
          projectId: four.projectId,
          workItemId: four.id,
          workItemNumber: four.number,
          workItemTitle: four.title,
          runId: "run_2",
          reason: `run 2's archived log: runs/run_2/events/0-199.ndjson is missing from sf-archive`,
          createdAt: ago(60 * 5),
        },
      ]
    : [];
};

export const ANSWERS: Answers = {
  "incident.listArchiveMissing": (input) => ({
    incidents: input.orgId === PERSONAL ? ARCHIVE_INCIDENTS() : [],
    more: false,
    auditArchiveStopped: {
      id: "incident_audit",
      reason: `The audit archive has stopped 3 ticks in a row since ${ago(16)}: audit/2026/08/14/00001_…: the existing object differs`,
      createdAt: ago(6),
    },
  }),
  "incident.resolve": () => ({ resolved: true }),
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
    items: [...ITEMS, ...FACTORY_ITEMS, ...(redFixture() ? [HELD_44()] : [])].filter(
      (i) => !input.orgId || i.orgId === input.orgId,
    ),
  }),
  "workItem.get": (input) => withArchivedLogs(detail(input.workItemId)),
  "workItem.board": (input) => board(input),
  "project.workflow": (input) => workflowOf(input.projectId),
  "workItem.timeline": (input) =>
    input.workItemId === "wi_13" ? timeline(!!input.archived) : TIMELINE,
  "workItem.attachment.list": () => ({ attachments: [] }),
  "planning.get": (input) => planning(input.workItemId),
  // Review of #130: what approving the plan writes, listed at the gate.
  "spec.writeBack": () => {
    const spec = "# Archive old runs\n\n## Scope\n- Runs older than 90 days move to R2\n";
    const base = "app -> d1: reads\napp -> queue: jobs\n";
    return {
      files: [
        {
          path: "docs/specs/wi-12-archive-old-runs.md",
          kind: "spec",
          status: "new",
          content: spec,
          base: null,
        },
        {
          path: ".kim/plans/wi-12-archive-old-runs.md",
          kind: "plan",
          status: "new",
          content: spec,
          base: null,
        },
        {
          path: ".kim/designs/system.d2",
          kind: "design",
          status: "changed",
          content:
            "app -> d1: reads\napp -> queue: archive jobs\nqueue -> r2: <old runs> & chunks\n",
          base,
        },
        {
          path: ".kim/mockups/archive-settings.html",
          kind: "mockup",
          status: "new",
          content: "<section>\n  <h2>Archive</h2>\n  <p>Runs older than 90 days</p>\n</section>\n",
          base: null,
        },
      ],
      kimCount: 3,
    };
  },
  "artifact.get": (input) =>
    input.artifactId === "art_schema" || input.artifactId === "art_flow"
      ? designGet(input.artifactId, input.revision)
      : {
          artifactId: input.artifactId,
          kind: "mockup",
          title: input.artifactId === "art_a" ? "A: GitHub connection" : "B: On each project",
          revision: input.artifactId === "art_a" ? 2 : 1,
          latest: input.artifactId === "art_a" ? 2 : 1,
          content: input.artifactId === "art_a" ? MOCKUP_A : MOCKUP_B,
          controls: ["--accent"],
          designType: null,
          preview: null,
        },
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
          capabilities: ["checks"],
          // What the runner's doctor says (ADR 0501, fifth review): no container runtime is answering
          // on this Mac (Docker Desktop or OrbStack).
          checksNote:
            "not run here: this Mac runner has no container runtime; no container runtime is answering (Docker Desktop or OrbStack): start it, or set checks.weakerMacSandbox",
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
    // The Website runs the org's Software workflow, overriding its retry limit (PR #121).
    current:
      input.projectId === SITE
        ? { ...(CONFIG_HISTORY[0] as (typeof CONFIG_HISTORY)[0]), policy: ON_ORG_WORKFLOW }
        : (CONFIG_HISTORY[0] ?? null),
    error: null,
    pendingMore: false,
    history: CONFIG_HISTORY,
    pending:
      input.projectId === FACTORY
        ? [
            {
              pendingActionId: "pa_cfg_1",
              operation: "config.save",
              note: "Let agents spend and reach outside",
              by: "owner",
              createdAt: ago(30),
              baseVersion: 12,
              policy: { ...POLICY_DOC, autonomyPolicy: "autonomous" },
              toVersion: null,
            },
          ]
        : [],
  }),
  // The engine's classification of a draft against the current version (ADR 0370): here, from the
  // fields the fixtures change, worded as `policyImpact` words them.
  "config.preview": (input) => {
    const draft = input.policy as Record<string, unknown>;
    const changes: { path: string; class: "loosens" | "tightens" | "neutral"; summary: string }[] =
      [];
    for (const [key, label] of [
      ["retryLimit", "Retry limit"],
      ["wipLimit", "WIP limit"],
    ] as const) {
      const before = POLICY_DOC[key];
      const after = draft[key];
      if (typeof after === "number" && after !== before)
        changes.push({
          path: key,
          // As policyImpact: a retry limit is neutral; a lower WIP limit tightens, a higher is neutral.
          class: key === "wipLimit" && after < before ? "tightens" : "neutral",
          summary: `${label} ${before} → ${after}`,
        });
    }
    if (draft.autonomyPolicy !== POLICY_DOC.autonomyPolicy)
      changes.push({
        path: "autonomyPolicy",
        class: draft.autonomyPolicy === "cautious" ? "tightens" : "loosens",
        summary: `Autonomy policy ${POLICY_DOC.autonomyPolicy} → ${String(draft.autonomyPolicy)}`,
      });
    const cls = changes.some((c) => c.class === "loosens")
      ? "loosens"
      : changes.some((c) => c.class === "tightens")
        ? "tightens"
        : "neutral";
    return {
      valid: true,
      error: null,
      impact: { class: cls, changes },
      currentVersion: 12,
    };
  },
  "config.trials": () => ({
    trials: [
      {
        id: "trial_1",
        kind: "instructions",
        status: "promoted" as const,
        evidence: {},
        outcome: null,
        createdAt: ago(60 * 24 * 6),
        decidedAt: ago(60 * 24 * 4),
        summary: "The builder writes the failing test first",
        reason: "5 items did at least as well",
        itemsSoFar: 5,
        targetItems: 5,
        baseVersion: 10,
        candidateVersion: 11,
      },
    ],
  }),
  "workflow.list": () => ({
    version: 4,
    workflows: [
      {
        id: "wf_software",
        name: "Software",
        description: "Code changes, from the org",
        builtIn: null,
        stages: [],
      },
      {
        id: "wf_incident",
        name: "Incident",
        description: "",
        builtIn: "incident" as const,
        stages: [],
      },
    ],
    templates: [],
  }),
  "workflow.get": (input) => ({
    version: 4,
    workflow: {
      schema: 1,
      id: input.workflowId,
      name: "Software",
      description: "",
      stages: [
        {
          id: "plan",
          type: "interview-planning",
          typeVersion: 1,
          name: "Planning",
          phase: "shaping",
          settings: { requiredFrom: "medium" },
        },
        {
          id: "build",
          type: "build",
          typeVersion: 1,
          name: "Build",
          phase: "delivery",
          settings: { retryLimit: 2 },
        },
        {
          id: "verify",
          type: "checks",
          typeVersion: 1,
          name: "Verify",
          phase: "delivery",
          settings: { requiredChecks: ["ci", "typecheck"] },
        },
      ],
    },
    builtIn: null,
    shipped: null,
  }),
  "adjudicator.stats": () => ({
    spec: {
      mode: "shadow" as const,
      decisions: 14,
      approvals: 12,
      agreed: 11,
      precision: 0.92,
      eligible: false,
    },
    step: {
      mode: "off" as const,
      decisions: 3,
      approvals: 0,
      agreed: 0,
      precision: 0,
      eligible: false,
    },
    configVersion: 12,
  }),
  "desktopDevice.list": () => ({
    devices: [
      {
        id: "dev_m5",
        name: "M5",
        platform: "macos" as const,
        keyStorage: "secure-enclave",
        createdAt: ago(60 * 24 * 9),
        lastSeenAt: ago(0),
        revokedAt: null,
        decides: true,
        attestation: null,
        current: true,
      },
      {
        id: "dsk_mini",
        name: "Mac mini",
        platform: "macos" as const,
        keyStorage: "secure-enclave",
        createdAt: ago(60 * 24 * 20),
        lastSeenAt: ago(60 * 24 * 2),
        revokedAt: null,
        decides: true,
        attestation: null,
        current: false,
      },
      {
        id: "dsk_old",
        name: "Old laptop",
        platform: "macos" as const,
        keyStorage: "software",
        createdAt: ago(60 * 24 * 60),
        lastSeenAt: ago(60 * 24 * 40),
        revokedAt: ago(60 * 24 * 30),
        decides: true,
        attestation: null,
        current: false,
      },
    ],
  }),
  // The door lists only kind "cli" (a desktop's token is its device's), as the engine does.
  "cliToken.list": () => ({
    tokens: TOKENS.filter((t) => t.kind === "cli").map(({ kind: _, ...t }) => t),
  }),
  // Spec 53's babysitter line: green unless `?fixture=red`.
  "delivery.status": (input) => {
    if (input.projectId !== FACTORY) return { repositories: [] };
    const red = redFixture();
    return {
      repositories: [
        {
          repositoryId: "repo_software-factory",
          owner: "example",
          name: "software-factory",
          branch: "main",
          main: {
            state: red ? ("red" as const) : ("green" as const),
            headSha: "4d1c9e2a7b",
            failing: red ? ["ci", "typecheck"] : [],
            lastGreenSha: "b7e0f31c55",
            redSince: red ? ago(RED_SINCE_MIN) : null,
            firstRedSha: red ? "4d1c9e2a7b" : null,
            checkedAt: ago(1),
            suspects: red
              ? [
                  {
                    workItemId: "wi_8",
                    number: 8,
                    title: "Retry a planning session that lost its runner",
                    prNumber: 41,
                    mergeSha: "4d1c9e2a7b",
                  },
                ]
              : [],
            culpritWorkItemId: red ? "wi_8" : null,
            attribution: red
              ? "#8's merge (4d1c9e2) is the only landing since b7e0f31 was green, and main went red on it, and the red reproduced on a rerun"
              : null,
            attributedBy: red ? ("proven" as const) : null,
            candidateWorkItemId: null,
          },
          deliveries: red
            ? [
                {
                  workItemId: "wi_40",
                  number: 40,
                  title: "Factory incident: #8 had a run that failed",
                  position: 1,
                  state: "merging" as const,
                  repair: true,
                  driver: "babysitter" as const,
                  headSha: "a1b2c3d4e5",
                  enqueuedAt: ago(9),
                },
                {
                  workItemId: "wi_44",
                  number: 44,
                  title: "Cache the runner list",
                  position: 2,
                  state: "held" as const,
                  repair: false,
                  driver: "babysitter" as const,
                  headSha: "9c41e07d2b",
                  enqueuedAt: ago(12),
                },
              ]
            : [
                {
                  workItemId: "wi_42",
                  number: 42,
                  title: "Keep the runner count fresh",
                  position: 1,
                  state: "merging" as const,
                  repair: false,
                  driver: "babysitter" as const,
                  headSha: "9c41e07d2b",
                  enqueuedAt: ago(12),
                },
              ],
        },
      ],
    };
  },
  "workItem.markRepair": (input) => ({ repair: input.repair }),
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
  "workItem.release": released,
  "workItem.move": () => ({ status: "ready" }),
  "workItem.update": (input) => ({ workItemId: input.workItemId }) as never,
  "workItem.create": (input) =>
    ({
      workItemId: "wi_99",
      number: 99,
      status: input.state ?? "backlog",
      outcome: "created",
    }) as never,
};
