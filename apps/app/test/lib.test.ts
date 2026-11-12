// The page logic the specs pin down, as pure functions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerLabel, updateLabel } from "#/components/runner-health";
import { duration } from "#/lib/format";
import { groupByProject } from "#/lib/inbox";
import type { Inbox, WorkItemDetail } from "#/lib/ops";
import { keptOnRunner, packetSections, parsePacket } from "#/lib/packet";
import { answerChoices, bulkAcceptable } from "#/lib/questions";
import { agentTime, stageSteps, yourTime } from "#/lib/work-item";

const NOW = "2026-11-11T10:00:00.000Z";

function detail(
  over: Partial<WorkItemDetail> & { item?: Partial<WorkItemDetail["item"]> } = {},
): WorkItemDetail {
  const { item, ...rest } = over;
  return {
    item: {
      id: "wi_1",
      projectId: "prj_1",
      orgId: "org_1",
      number: 1,
      title: "Add dark mode",
      kind: "change",
      stage: "build",
      status: "running",
      statusReason: null,
      size: "small",
      requesterUserId: "u_me",
      source: "app",
      branch: "factory/1-add-dark-mode",
      prUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
      body: "",
      specRequired: false,
      specDecisionReason: "sized small, below the spec threshold (medium)",
      domains: [],
      headSha: null,
      prNumber: null,
      policySha: null,
      ...item,
    },
    stages: [],
    spec: null,
    questions: [],
    gates: [],
    runs: [],
    reviewPacket: null,
    mergeQueue: null,
    policy: null,
    approvers: { rule: "org owners and admins", users: [] },
    viewer: { isApprover: true, isRequester: true },
    ...rest,
  };
}

describe("review packet sections (spec 14, criterion 1)", () => {
  it("follows the project's order and leaves out what it doesn't list", () => {
    expect(packetSections(["reviewer", "verdict", "criteria-evidence", "nonsense"])).toEqual([
      "reviewer",
      "verdict",
      "criteria",
    ]);
  });
  it("shows every section when the project doesn't configure them", () => {
    expect(packetSections(null)).toEqual([
      "verdict",
      "whatChanged",
      "criteria",
      "holdout",
      "reviewer",
      "visual",
      "risk",
      "diff",
    ]);
  });
  it("never fetches evidence kept on the runner, only references it (criterion 9)", () => {
    expect(keptOnRunner("runner: ~/runs/42/screenshot.png")).toBe("~/runs/42/screenshot.png");
    expect(keptOnRunner("e2e: login.spec ✓")).toBeNull();
  });
  it("reads a stored packet defensively", () => {
    const p = parsePacket({
      id: "rp_1",
      headSha: "a".repeat(40),
      verdict: "pass",
      summary: "",
      criteria: [{ criterion: "A", met: true, evidence: "unit ✓" }, { junk: 1 }],
      checks: [{ name: "ci", status: "pass" }],
      reviewer: { role: "review", verdict: "approve", notes: "ok", sameModelAsImplementer: true },
      riskFlags: [],
      sections: {},
      createdAt: NOW,
    });
    expect(p.criteria).toHaveLength(1);
    expect(p.reviewer?.sameModelAsImplementer).toBe(true);
  });
});

describe("questions", () => {
  it("offers the recommendation first, then the default, then the other options, once each", () => {
    expect(
      answerChoices({
        options: ["Cap at 10k", "Stream", "Email a link"],
        defaultAnswer: "Cap at 10k",
        recommendation: "Stream",
      }),
    ).toEqual([
      { answer: "Stream", tag: "recommended" },
      { answer: "Cap at 10k", tag: "default" },
      { answer: "Email a link", tag: null },
    ]);
  });
  it("never bulk-accepts security & privacy or irreversible questions (spec 13, criterion 9)", () => {
    const q = {
      id: "q",
      domain: "product",
      prompt: "?",
      options: [],
      defaultAnswer: "yes",
      recommendation: null,
      blocking: true,
      irreversible: false,
      status: "open",
      answer: null,
      acceptedDefault: false,
      assigneeUserId: null,
    };
    expect(bulkAcceptable(q)).toBe(true);
    expect(bulkAcceptable({ ...q, domain: "security" })).toBe(false);
    expect(bulkAcceptable({ ...q, domain: "Privacy" })).toBe(false);
    expect(bulkAcceptable({ ...q, irreversible: true })).toBe(false);
    expect(bulkAcceptable({ ...q, defaultAnswer: null })).toBe(false);
  });
});

describe("the inbox", () => {
  it("puts each gate and question once in its project's group, with the WIP hold", () => {
    const inbox: Inbox = {
      gates: [
        {
          id: "pa_1",
          kind: "spec",
          workItemId: "wi_1",
          projectId: "p1",
          title: "A",
          operation: "spec.approve",
          createdAt: NOW,
          timeoutAt: null,
          escalated: false,
        },
        {
          id: "pa_2",
          kind: "merge",
          workItemId: "wi_2",
          projectId: "p2",
          title: "B",
          operation: "pr.merge",
          createdAt: NOW,
          timeoutAt: null,
          escalated: false,
        },
      ],
      questions: [
        {
          id: "q1",
          workItemId: "wi_3",
          projectId: "p1",
          title: "C",
          domain: "product",
          prompt: "?",
          options: [],
          defaultAnswer: null,
          recommendation: null,
          irreversible: false,
        },
      ],
      running: [],
      runners: [],
      planning: [],
      wipHolds: [{ projectId: "p2", waitingBuilds: 2 }],
      protection: [],
    };
    const groups = groupByProject(inbox);
    expect(
      groups.map((g) => [g.projectId, g.gates.length, g.questions.length, g.waitingBuilds]),
    ).toEqual([
      ["p1", 1, 1, 0],
      ["p2", 1, 0, 2],
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a rate-limited runner's until time and an offline runner's last-seen time (spec 12, criterion 7)", () => {
    // Pin the clock to local noon on a fixed day, so the times a minute either side are the same
    // day whenever and wherever the test runs (the label adds the date for another day).
    vi.useFakeTimers({ toFake: ["Date"] });
    const pinned = new Date(2026, 10, 11, 12, 0, 0);
    vi.setSystemTime(pinned);
    const base = {
      id: "r",
      name: "m5",
      inUse: 0,
      max: 2,
      light: null,
      rateLimitedUntil: null,
      lastSeenAt: null,
      update: null,
    };
    const soon = new Date(pinned.getTime() + 60_000).toISOString();
    const earlier = new Date(pinned.getTime() - 60_000).toISOString();
    expect(runnerLabel({ ...base, state: "rate-limited", rateLimitedUntil: soon })).toMatch(
      /^rate-limited until \d\d:\d\d$/,
    );
    expect(runnerLabel({ ...base, state: "offline", lastSeenAt: earlier })).toMatch(
      /^offline since \d\d:\d\d/,
    );
    expect(runnerLabel({ ...base, state: "busy", inUse: 2 })).toBe("busy 2/2");
  });

  it("says when a runner's code is behind, blocked or rolled back (ADR 0360)", () => {
    const base = {
      id: "r",
      name: "m5",
      state: "online" as const,
      inUse: 0,
      max: 2,
      light: null,
      rateLimitedUntil: null,
      lastSeenAt: null,
    };
    expect(updateLabel({ ...base, update: null })).toBe("");
    expect(updateLabel({ ...base, update: { state: "behind", reason: null } })).toBe(
      "updating to the latest version",
    );
    expect(
      updateLabel({
        ...base,
        update: { state: "blocked", reason: "the checkout has local changes" },
      }),
    ).toBe("can't update: the checkout has local changes");
    expect(updateLabel({ ...base, update: { state: "rolled_back", reason: null } })).toBe(
      "update rolled back",
    );
  });
});

describe("work item detail", () => {
  it("shows a skipped spec with the reason triage logged (spec 13, criterion 6)", () => {
    const steps = stageSteps(detail());
    expect(steps.map((s) => [s.stage, s.state])).toEqual([
      ["intake", "done"],
      ["triage", "done"],
      ["spec", "skipped"],
      ["build", "now"],
      ["verify", "todo"],
      ["merge", "todo"],
    ]);
    expect(steps[2]?.reason).toBe("sized small, below the spec threshold (medium)");
  });

  it("'your time' is the summed open time of gates you decided (spec 13, criterion 3)", () => {
    const gate = (id: string, by: string, openMs: number) => ({
      id,
      kind: "spec",
      operation: "spec.approve",
      status: "approved",
      decision: "approved",
      assigneeUserId: by,
      createdAt: NOW,
      decidedAt: new Date(Date.parse(NOW) + openMs).toISOString(),
      decidedBy: by,
      note: null,
    });
    const d = detail({
      gates: [gate("a", "u_me", 60_000), gate("b", "u_me", 40_000), gate("c", "u_other", 999_000)],
    });
    expect(yourTime(d, "u_me")).toBe(100_000);
    expect(duration(yourTime(d, "u_me"))).toBe("1m 40s");
  });

  it("'agent time' sums the runs", () => {
    const run = (n: number, ms: number) => ({
      id: `run_${n}`,
      jobId: "job",
      runNo: n,
      stage: "build",
      runnerId: "r",
      branch: "b",
      status: "done",
      outcome: "succeeded",
      summary: null,
      headSha: null,
      takeover: null,
      startedAt: NOW,
      endedAt: new Date(Date.parse(NOW) + ms).toISOString(),
    });
    expect(agentTime(detail({ runs: [run(1, 60_000), run(2, 120_000)] }))).toBe(180_000);
  });
});

describe("the verify stage's sections (spec 04)", () => {
  it("counts CI on the head SHA, not the runner's checks, and surfaces why", async () => {
    const { checkCounts, packetExtras } = await import("#/lib/packet");
    const p = parsePacket({
      id: "rp_1",
      headSha: "a".repeat(40),
      verdict: "fail",
      summary: "",
      criteria: [],
      checks: [{ name: "local tests", status: "pass" }],
      reviewer: null,
      riskFlags: [],
      sections: {
        verdict: { verdict: "fail", reasons: ["CI failing on aaaaaaa: ci"], warnings: [] },
        ci: {
          state: "failure",
          checks: [
            { name: "ci", status: "completed", conclusion: "failure", url: null },
            { name: "lint", status: "completed", conclusion: "success", url: null },
          ],
        },
        changed: { files: 1, paths: [{ path: "a.ts", status: "modified" }] },
      },
      createdAt: NOW,
    });
    expect(checkCounts(p)).toEqual({ passed: 1, failed: 1, total: 2, source: "ci" });
    expect(packetExtras(p).reasons).toEqual(["CI failing on aaaaaaa: ci"]);
    expect(packetExtras(p).changed?.files).toBe(1);
    expect(packetSections(["ci", "changed", "risk"])).toEqual(["verdict", "whatChanged", "risk"]);
  });
});

describe("runner pairing (incident 2026-11-11-bootstrap)", () => {
  it("copies a ready-to-run command that pipes only the key", async () => {
    const { pairCommand } = await import("#/lib/runner-pairing");
    expect(pairCommand("r_abc123")).toBe(
      "pbpaste | local/runner-host/bin/sf-runner pair --runner-id r_abc123 --key-stdin",
    );
  });
});
