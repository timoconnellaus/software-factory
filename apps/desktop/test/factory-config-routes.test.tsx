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
  result: { projectId: "prj_factory", current: null, error: null, history: [], pending: [] },
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
