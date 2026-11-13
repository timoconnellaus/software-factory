// Policy, Agents and Workflows through the real router (spec 41, slice 5): a skeleton while the
// config loads, the error with Retry when it failed, and "no config yet" only when `config.get`
// answered without one. The project is the rail's org's (Personal: the factory project).
import { describe, expect, it, vi } from "vitest";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const PENDING = 'data-testid="read-pending"';
const ERROR = 'data-testid="read-error"';
const failed = { error: "the factory isn't reachable" };
const noConfig = {
  result: {
    projectId: "prj_factory",
    current: null,
    error: null,
    history: [],
    pending: [],
    pendingMore: false,
  },
};

describe.each([
  ["/factory/policy", "Autonomy policy"],
  ["/factory/agents", "Model roles"],
  ["/factory/workflows", "Software"],
])("%s", (path, shown) => {
  it("shows a skeleton, not 'no config', while the config loads", async () => {
    const html = await renderPage(path, { pending: [["config"]] });
    expect(html).toContain(PENDING);
    expect(textOf(html)).not.toContain("no config yet");
    expect(textOf(html)).not.toContain(shown);
  });

  it("shows the error with Retry when the config read failed", async () => {
    const html = await renderPage(path, { answers: { "config.get": failed } });
    const text = textOf(html);
    expect(html).toContain(ERROR);
    expect(text).toContain("Couldn't load the project's config. the factory isn't reachable Retry");
    expect(text).not.toContain("no config yet");
  });

  it("says there's no config only when the read answered without one", async () => {
    const html = await renderPage(path, { answers: { "config.get": noConfig } });
    expect(html).not.toContain(PENDING);
    expect(textOf(html)).toContain("This project has no config yet.");
  });

  it("shows the project's config", async () => {
    const text = textOf(await renderPage(path));
    expect(text).toContain("Factory");
    expect(text).toContain(shown);
  });

  it("shows the projects' error, not 'no project', when the projects read failed", async () => {
    const html = await renderPage(path, { answers: { "project.list": failed } });
    expect(textOf(html)).toContain("Couldn't load the projects.");
    expect(textOf(html)).not.toContain("No project in this org");
  });
});

describe("Policy", () => {
  it("states the autonomy the gate enforces and that the floor can only tighten it", async () => {
    const text = textOf(await renderPage("/factory/policy"));
    expect(text).toContain(
      "Autonomy policy Balanced Agents go ahead with writing code. A person approves accepting a spec, spending and reaching outside.",
    );
    expect(text).toContain("The factory's floor Can only tighten this");
  });
});

describe("Agents", () => {
  it("labels a model as the role's configured model", async () => {
    const text = textOf(await renderPage("/factory/agents"));
    expect(text).toContain("Role Configured model, standard tier Configured model, light tier");
  });
});

describe("Policy: changing it in the app (ADR 0610)", () => {
  it("offers Edit policy and no website link", async () => {
    const html = await renderPage("/factory/policy");
    expect(html).toContain('data-testid="edit-config"');
    expect(textOf(html)).not.toContain("on the website");
  });

  it("shows a waiting change, with Approve only once the engine has classified it", async () => {
    const html = await renderPage("/factory/policy");
    const text = textOf(html);
    expect(text).toContain("1 change is waiting for an approver");
    expect(text).toContain("Save: Let agents spend and reach outside");
    // Before the classification is on screen there is nothing to approve yet.
    expect(text).toContain("Classifying the change…");
    expect(html).not.toContain('data-testid="pending-approve"');
    expect(html).toContain('data-testid="pending-reject"');
  });

  it("offers only Reject for a change drafted against an older version", async () => {
    const stale = {
      result: {
        projectId: "prj_factory",
        current: { ...CURRENT, version: 13 },
        error: null,
        history: [],
        pending: [
          {
            pendingActionId: "pa_old",
            operation: "config.save",
            note: "Let agents spend and reach outside",
            by: "owner",
            createdAt: new Date().toISOString(),
            baseVersion: 12,
            policy: { retryLimit: 3 },
            toVersion: null,
          },
        ],
        pendingMore: false,
      },
    };
    const html = await renderPage("/factory/policy", { answers: { "config.get": stale } });
    expect(textOf(html)).toContain("drafted against v12; the config is now v13");
    expect(html).not.toContain('data-testid="pending-approve"');
    expect(html).toContain('data-testid="pending-reject"');
  });

  it("edits the whole config as a form, with History and roll back", async () => {
    const html = await renderPage("/factory/policy?edit=1");
    const text = textOf(html);
    expect(html).toContain('data-testid="policy-form"');
    for (const section of [
      "Autonomy",
      "Timeouts and people",
      "Throughput",
      "Review packet",
      "Protection on the default branch",
      "Self-improvement",
      "Adjudicator",
      "History",
    ])
      expect(text).toContain(section);
    expect(text).toContain("Roll back");
    expect(html).toContain('data-testid="edit-json"');
    expect(html).toContain('data-testid="edit-done"');
  });
});

const CURRENT = {
  version: 12,
  sha: "5da8988",
  source: "app",
  note: null,
  createdBy: "owner",
  createdAt: new Date().toISOString(),
  valid: true,
  impact: null,
  policy: { version: 1, autonomyPolicy: "balanced" },
};

describe("Workflows and Agents: changing them in the app (ADR 0610)", () => {
  it.each(["/factory/workflows", "/factory/agents", "/factory/policy"])(
    "%s offers an edit button and no website link",
    async (path) => {
      const html = await renderPage(path);
      expect(html).toContain('data-testid="edit-config"');
      expect(textOf(html)).not.toContain("on the website");
    },
  );

  it("edits a workflow's slots and steps", async () => {
    const html = await renderPage("/factory/workflows?edit=1");
    const text = textOf(html);
    expect(html).toContain('data-testid="workflow-editor"');
    expect(html).toContain('data-testid="slot-afterSpec"');
    expect(html).toContain('data-testid="step-critic"');
    expect(text).toContain("Add a work step");
    expect(text).toContain("Merge gate Always a person");
  });

  it("edits the agents", async () => {
    const html = await renderPage("/factory/agents?edit=1");
    expect(html).toContain('data-testid="agents-form"');
    expect(html).toContain('data-testid="agent-0"');
    expect(html).toContain('data-testid="add-agent"');
  });
});

describe("Policy on an org workflow (spec 52, PR #121)", () => {
  it("marks the settings the org's workflow sets, with the org's value and the override", async () => {
    const text = textOf(await renderPage("/factory/policy?project=prj_site&edit=1"));
    expect(text).toContain("Software sets 2. Overridden here");
    expect(text).toContain(
      "A looser value than the org's applies only once an org admin approves it",
    );
    expect(text).toContain("Software sets ci, typecheck. This project uses the org's value.");
  });
});

describe("Policy: follow-ups from the review of #145", () => {
  it("on a software key, says this Mac can't approve yet and offers no live Approve or Reject", async () => {
    const html = await renderPage("/factory/policy", { session: { keyStorage: "software" } });
    expect(textOf(html)).toContain(
      "This Mac can't approve yet: its key isn't in the Secure Enclave. Update the app, then sign in again.",
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="pending-reject"/);
  });

  it("says the org's workflow couldn't be read, not that it has no such stage", async () => {
    const text = textOf(
      await renderPage("/factory/policy?project=prj_site&edit=1", {
        answers: { "workflow.get": { error: "the factory isn't reachable" } },
      }),
    );
    expect(text).toContain("Couldn't read the org's workflow");
    expect(text).not.toContain("has no stage that sets this");
  });

  it("edits when a spec is needed", async () => {
    const text = textOf(await renderPage("/factory/policy?edit=1"));
    expect(text).toContain("Spec approval Needed from");
  });
});

describe("Org workflows (spec 52, ADR 0610)", () => {
  it("lists the org's workflows, a workflow's stages, waiting changes, agents and history", async () => {
    const html = await renderPage("/factory/org-workflows");
    const text = textOf(html);
    expect(html).toContain('data-testid="org-workflows"');
    expect(text).toContain("Release notes");
    expect(text).toContain("1 change is waiting for an org admin");
    expect(text).toContain("Save a workflow: Skip the reviewer for docs");
    expect(html).toContain('data-testid="org-agents"');
    expect(html).toContain('data-testid="org-adopt"');
    expect(html).toContain('data-testid="org-history"');
    expect(html).toContain('data-testid="edit-org-workflow"');
  });

  it("edits a workflow's stages, with every decision behind Touch ID", async () => {
    const html = await renderPage("/factory/org-workflows?workflow=wf_software&edit=1");
    expect(html).toContain('data-testid="org-workflow-form"');
    expect(html).toContain('data-testid="org-stage-review"');
    expect(textOf(html)).toContain("Add a stage");
  });

  it("leaves a built-in workflow uneditable here", async () => {
    const html = await renderPage("/factory/org-workflows?workflow=wf_incident");
    expect(html).not.toContain('data-testid="edit-org-workflow"');
    expect(textOf(html)).toContain("Built in");
  });

  it("on a software key, offers no live org decision", async () => {
    const html = await renderPage("/factory/org-workflows", {
      session: { keyStorage: "software" },
    });
    expect(textOf(html)).toContain("This Mac can't approve yet");
  });
});

describe("2c: the last website-only decisions, in the app (ADR 0610)", () => {
  it("lists the kill switches on the Overview, with Turn off for one that is on", async () => {
    const html = await renderPage("/factory");
    const text = textOf(html);
    expect(html).toContain('data-testid="kill-switches"');
    expect(text).toContain("Website On Deploys are failing on the host Turn off");
  });

  it("offers an org admin's Approve on a looser override that isn't approved", async () => {
    const html = await renderPage("/factory/policy?project=prj_site&edit=1");
    expect(html).toContain('data-testid="approve-override-retryLimit"');
  });

  it("offers Mark as a repair while the project's main is red, and Not a repair once marked", async () => {
    const { repairShown } = await import("../src/mainview/components/repair-toggle.tsx");
    expect(repairShown(true, false)).toBe(true);
    expect(repairShown(false, true)).toBe(true);
    expect(repairShown(false, false)).toBe(false);
    // Only approvers decide repairs.
    expect(repairShown(true, false, false)).toBe(false);
  });

  it("switches a runner's Claude account from the Runners page", async () => {
    const html = await renderPage("/factory/runners");
    expect(textOf(html)).toContain("Use personal");
  });
});

describe("Org workflows: deciding a waiting change (review of #159)", () => {
  it("shows the engine's classification and the difference before Approve", async () => {
    const html = await renderPage("/factory/org-workflows");
    const text = textOf(html);
    expect(html).toContain('data-testid="org-pending-impact"');
    expect(text).toContain("Removes the agent check Reviewer.");
    expect(html).toContain('data-testid="org-pending-diff"');
    expect(text).toContain("Reviewer (removed)");
    expect(html).toContain('data-testid="org-pending-approve"');
  });

  it("offers only Reject when a change can't be shown or no longer applies", async () => {
    const { cannotApproveOrg } = await import("../src/mainview/routes/factory.org.tsx");
    const base = {
      pendingActionId: "pa_1",
      operation: "workflow.save",
      note: null,
      by: null,
      createdAt: "",
      baseVersion: 4,
      proposal: { id: "wf_x", name: "New" },
      current: null,
      toVersion: null,
      impact: { class: "loosens" as const, changes: [] },
    };
    expect(cannotApproveOrg(base, 4)).toBeNull();
    expect(cannotApproveOrg(base, 5)).toMatch(/drafted on v4/);
    expect(cannotApproveOrg({ ...base, impact: null }, 4)).toMatch(/couldn't classify/);
    expect(cannotApproveOrg({ ...base, proposal: null }, 4)).toMatch(/can't be shown/);
    // Fail closed: no base version, or nothing shown, is nothing to approve.
    expect(cannotApproveOrg({ ...base, baseVersion: null }, 4)).toMatch(/unknown version/);
    expect(cannotApproveOrg({ ...base, proposal: { id: "wf_x" } }, 4)).toMatch(/changes nothing/);
  });
});

describe("2c fixes (review of #165)", () => {
  it("says the kill switches couldn't be read, never 'all off'", async () => {
    const html = await renderPage("/factory", {
      answers: { "killSwitch.list": { error: "the factory isn't reachable" } },
    });
    const text = textOf(html);
    expect(text).toContain("Couldn't load the kill switches.");
    expect(text).not.toContain("Turn on");
  });

  it("turns a switch on with a call, and off only through a decision", async () => {
    const { killSwitchPath } = await import("../src/mainview/components/kill-switches.tsx");
    expect(killSwitchPath(true)).toBe("call");
    expect(killSwitchPath(false)).toBe("decide");
    const { DECISION_OPS, DECIDE_OPS } = await import("../src/shared/decisions.ts");
    // Off goes through decide (Touch ID); on stays a plain call.
    expect(DECIDE_OPS.has("killSwitch.set")).toBe(true);
    expect(DECISION_OPS.has("killSwitch.set")).toBe(false);
  });

  it("offers a runner's accounts only to its owner", async () => {
    const { ANSWERS } = await import("../screenshots/fixtures.ts");
    const runners = (
      ANSWERS["runner.list"] as (i: unknown) => { runners: Record<string, unknown>[] }
    )({});
    const theirs = {
      runners: runners.runners.map((r) => ({ ...r, ownerUserId: "usr_someone_else" })),
    };
    const html = await renderPage("/factory/runners", {
      answers: { "runner.list": { result: theirs } },
    });
    expect(textOf(html)).not.toContain("Use personal");
  });
});

describe("2c round two (review of #165)", () => {
  it("shows a project past the list's cap as not loaded, with no Turn on", async () => {
    const html = await renderPage("/factory", {
      answers: { "killSwitch.list": { result: { org: null, projects: [], more: true } } },
    });
    const text = textOf(html);
    expect(text).toContain("Website Not loaded");
    expect(text).toContain("More projects have switches than are shown here");
  });
});
