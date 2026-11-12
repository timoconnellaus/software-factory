// Spec 21 (ADR 0472): the planner's mockups. Revisions kept with the controls they declare,
// questions linked to them (cards, bound controls) checked against those controls, `applied`
// values with a bound answer, and comments pinned to an element.
import {
  appliedValues,
  type CapabilityManifest,
  CONTRACT_VERSION,
  declaredControls,
  frameSize,
  type Job,
  type PlanningNews,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import { newItem, ok, RUNNER_ACTOR, refusal, uid, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};
type W = Awaited<ReturnType<typeof world>>;

async function planning(w: W) {
  const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const m5 = RUNNER_ACTOR(r.runnerId);
  const item = await newItem(w, "Take work from GitHub issues");
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  const started = await ok<{ jobId: string }>(
    "planning.start",
    { workItemId: item.workItemId },
    FOREMAN,
  );
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest,
      capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
    },
    m5,
  );
  if (!job || job.jobId !== started.jobId) throw new Error("expected the planning job");
  const agent = <O = Record<string, unknown>>(op: string, input: Record<string, unknown> = {}) =>
    ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, m5);
  return { item, agent };
}

const SETTINGS = `<!doctype html><html><head><style>
:root { --accent: #2563eb; --radius: 8px; }
.card { border-radius: var(--radius); }
[data-plan-nav="top"] .side { display: none; }
</style></head><body data-plan-nav="side">
<h1 data-plan-text="headline">Connections</h1>
<button data-name="import switch" style="background: var(--accent)">Take work from issues</button>
</body></html>`;

describe("planning visuals (spec 21)", () => {
  it("reads the controls a mockup declares, and sizes its frame by what it says it is", () => {
    expect(declaredControls(SETTINGS)).toEqual(["#headline", "--accent", "--radius", "@nav"]);
    expect(frameSize("Settings", null)).toMatchObject({ width: 1280, height: 800 });
    expect(frameSize("Settings", "On a phone")).toMatchObject({ width: 390, height: 844 });
    expect(frameSize("Tablet layout", null)).toMatchObject({ width: 834, height: 1112 });
  });

  it("keeps every revision, and the view shows the latest and whether it's kept (criteria 1, 6)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const added = await agent<{ artifactId: string; revision: number; controls: string[] }>(
      "artifact.add",
      { title: "Settings: GitHub connection", content: SETTINGS, show: true },
    );
    expect(added).toMatchObject({
      revision: 1,
      controls: ["#headline", "--accent", "--radius", "@nav"],
    });
    await agent("artifact.update", {
      artifactId: added.artifactId,
      content: SETTINGS.replace("Connections", "GitHub"),
      keep: true,
    });
    const latest = await ok<{ revision: number; content: string }>(
      "artifact.get",
      { workItemId: item.workItemId, artifactId: added.artifactId },
      w.human,
    );
    expect(latest.revision).toBe(2);
    expect(latest.content).toContain(">GitHub<");
    const first = await ok<{ content: string }>(
      "artifact.get",
      { workItemId: item.workItemId, artifactId: added.artifactId, revision: 1 },
      w.human,
    );
    expect(first.content).toContain(">Connections<");
    const view = await ok<{
      session: { shownArtifactId: string | null };
      artifacts: { id: string; revision: number; keep: boolean }[];
    }>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(view.artifacts).toEqual([
      expect.objectContaining({ id: added.artifactId, revision: 2, keep: true }),
    ]);
    expect(view.session.shownArtifactId).toBe(added.artifactId);
  });

  it("shows options as cards: a choice names an artifact per option, and choosing answers it (criterion 2)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const a = await agent<{ artifactId: string }>("artifact.add", {
      title: "A: GitHub connection",
      content: SETTINGS,
    });
    const b = await agent<{ artifactId: string }>("artifact.add", {
      title: "B: On each project",
      content: SETTINGS,
    });
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        {
          kind: "single-choice",
          prompt: "Where does the import setting live?",
          options: ["GitHub connection", "On each project"],
          default: "GitHub connection",
          optionArtifacts: { "GitHub connection": a.artifactId, "On each project": b.artifactId },
        },
      ],
    });
    // An option that isn't one, or an artifact that isn't this item's, is refused.
    const wrong = await refusal(
      agent("question.ask", {
        questions: [
          {
            kind: "single-choice",
            prompt: "?",
            options: ["One", "Two"],
            optionArtifacts: { Three: a.artifactId },
          },
        ],
      }),
    );
    expect(wrong.code).toBe("invalid_input");
    await ok("question.answer", { questionId: questionIds[0], answer: "On each project" }, w.human);
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toEqual([
      expect.objectContaining({ type: "answer.submitted", answer: "On each project" }),
    ]);
    void item;
  });

  it("binds answers to a mockup's controls, brings the applied values to the planner, and refuses an undeclared one (criterion 3)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const m = await agent<{ artifactId: string }>("artifact.add", {
      title: "Settings",
      content: SETTINGS,
    });
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        {
          kind: "single-choice",
          prompt: "Accent colour?",
          options: ["Blue", "Green"],
          default: "Blue",
          artifactId: m.artifactId,
          optionValues: { Blue: { "--accent": "#2563eb" }, Green: { "--accent": "#16a34a" } },
        },
        {
          kind: "number",
          prompt: "Corner radius?",
          default: 8,
          artifactId: m.artifactId,
          control: "--radius",
          unit: "px",
          min: 0,
          max: 24,
        },
      ],
    });
    const undeclared = await refusal(
      agent("question.ask", {
        questions: [
          {
            kind: "single-choice",
            prompt: "Font?",
            options: ["Inter", "Fraunces"],
            artifactId: m.artifactId,
            optionValues: { Inter: { "--font-display": "Inter" } },
          },
        ],
      }),
    );
    expect(undeclared.code).toBe("invalid_input");
    expect(undeclared.message).toContain("--font-display");
    await ok("question.answer", { questionId: questionIds[0], answer: "Green" }, w.human);
    await ok("question.answer", { questionId: questionIds[1], answer: "12" }, w.human);
    const news = await agent<PlanningNews>("planning.news");
    const applied = news.events.flatMap((e) => (e.type === "answer.submitted" ? [e.applied] : []));
    expect(applied).toEqual([
      { artifactId: m.artifactId, values: { "--accent": "#16a34a" } },
      { artifactId: m.artifactId, values: { "--radius": "12px" } },
    ]);
    // A revision that drops a bound control says so.
    const update = await agent<{ warnings: string[] }>("artifact.update", {
      artifactId: m.artifactId,
      content: SETTINGS.replace(/--radius[^;]*;/, "").replace("var(--radius)", "4px"),
    });
    expect(update.warnings).toEqual([expect.stringContaining("--radius")]);
    expect(
      appliedValues(
        {
          kind: "text",
          artifactId: m.artifactId,
          optionValues: null,
          control: "#headline",
          unit: null,
        },
        "GitHub",
      ),
    ).toEqual({ "#headline": "GitHub" });
    void item;
  });

  it("brings a comment pinned to an element to the planner, naming the element and the mockup (criterion 4)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const m = await agent<{ artifactId: string }>("artifact.add", {
      title: "Settings",
      content: SETTINGS,
    });
    await ok(
      "chat.send",
      {
        workItemId: item.workItemId,
        text: "Show the label name here",
        pin: {
          artifactId: m.artifactId,
          element: "import switch",
          selector: null,
          x: 640.4,
          y: 120.6,
          fx: 0.5,
          fy: 0.5,
          width: 1280,
        },
      },
      w.human,
    );
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toEqual([
      expect.objectContaining({
        type: "chat.message",
        pin: expect.objectContaining({
          artifactId: m.artifactId,
          artifact: "Settings",
          element: "import switch",
          x: 640,
          y: 121,
        }),
      }),
    ]);
    // A pin on an artifact of another item is refused.
    const other = await refusal(
      ok(
        "chat.send",
        {
          workItemId: item.workItemId,
          text: "?",
          pin: {
            artifactId: "art_nope",
            element: "x",
            selector: null,
            x: 0,
            y: 0,
            fx: 0,
            fy: 0,
            width: 1,
          },
        },
        w.human,
      ),
    );
    expect(other.code).toBe("not_found");
  });
});
