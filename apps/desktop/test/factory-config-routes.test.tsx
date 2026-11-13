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
    expect(html).toContain('data-testid="edit-policy"');
    expect(textOf(html)).not.toContain("on the website");
  });

  it("shows a waiting change, with Approve only once the engine has classified it", async () => {
    const html = await renderPage("/factory/policy");
    const text = textOf(html);
    expect(text).toContain("1 change is waiting for an approver");
    expect(text).toContain("Save: One more retry for flaky builds");
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
            note: "One more retry for flaky builds",
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
