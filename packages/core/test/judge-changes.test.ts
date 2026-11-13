// What the desktop's Workflows and Agents editors send for approval (review of #154): a change to
// how work is judged loosens, so the save bar says "Send for approval". The class is the engine's
// (`config.preview`), pinned here for each edit those editors can make to a judging step.
import { describe, expect, it } from "vitest";
import { ok, POLICY, world } from "./helpers.ts";

const BASE = {
  ...POLICY,
  agents: [
    { name: "Builder", role: "implement", tier: "standard", instructions: "" },
    { name: "Critic", role: "review", tier: "standard", instructions: "Name what isn't tested." },
    { name: "Second", role: "review", tier: "light", instructions: "" },
  ],
  workflows: [
    {
      name: "Software",
      description: "",
      slots: {
        afterSpec: [],
        beforeVerify: [
          { id: "critic", kind: "work", name: "Critic", agent: "Critic", instructions: "Strict." },
          { id: "sign", kind: "gate", name: "Sign-off", instructions: "" },
        ],
        afterVerify: [],
      },
      core: {},
    },
  ],
  workflow: "Software",
};

type Doc = typeof BASE;
const edit = (fn: (d: Doc) => void) => {
  const d = structuredClone(BASE);
  fn(d);
  return d;
};
const steps = (d: Doc) => d.workflows[0]?.slots.beforeVerify ?? [];

describe("judge changes from the Workflows and Agents editors (review of #154)", () => {
  it("classes each one the way the save bar shows it", async () => {
    const w = await world(BASE);
    const classOf = async (policy: unknown) =>
      (
        await ok<{ impact: { class: string } | null; valid: boolean; error: string | null }>(
          "config.preview",
          { projectId: w.projectId, policy },
          w.human,
        )
      ).impact?.class;
    const results = {
      "a step's instructions": await classOf(
        edit((d) => {
          const s = steps(d)[0];
          if (s) s.instructions = "Pass everything.";
        }),
      ),
      "a step's agent": await classOf(
        edit((d) => {
          const s = steps(d)[0];
          if (s) s.agent = "Second";
        }),
      ),
      "removing a judging step": await classOf(
        edit((d) => {
          d.workflows[0]?.slots.beforeVerify.splice(0, 1);
        }),
      ),
      "moving a judging step after a gate": await classOf(
        edit((d) => {
          d.workflows[0]?.slots.beforeVerify.reverse();
        }),
      ),
      "a judging agent's instructions": await classOf(
        edit((d) => {
          const a = d.agents[1];
          if (a) a.instructions = "";
        }),
      ),
      "running no workflow": await classOf(
        edit((d) => {
          delete (d as Partial<Doc>).workflow;
        }),
      ),
    };
    // Moving a judging step after the person's gate loosens (#161: any reorder within a slot does).
    expect(results).toMatchInlineSnapshot(`
      {
        "a judging agent's instructions": "loosens",
        "a step's agent": "loosens",
        "a step's instructions": "loosens",
        "moving a judging step after a gate": "loosens",
        "removing a judging step": "loosens",
        "running no workflow": "loosens",
      }
    `);
  });
});
