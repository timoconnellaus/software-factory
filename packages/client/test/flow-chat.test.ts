// The conversation told as turns (flow-chat.ts): a person's message, then the model's reply with what
// it did under it, and the working turn while a run is in flight. And what the model is doing, in
// plain words (flow-chat-steps.ts).
import { describe, expect, it } from "vitest";
import {
  chatTurns,
  choiceLabel,
  didCount,
  EMPTY_MADE,
  type FlowChatMessage,
  madeAnything,
} from "../src/flow-chat.ts";
import { chatStepLines, didThings, toolPhrase } from "../src/flow-chat-steps.ts";
import { runSteps } from "../src/flow-run.ts";

const msg = (
  seq: number,
  role: FlowChatMessage["role"],
  text: string,
  data: unknown = null,
  runId: string | null = null,
) => ({
  id: `m${seq}`,
  seq,
  role,
  text,
  data,
  runId,
  createdAt: "2026-11-15T00:00:00.000Z",
});

describe("chatTurns", () => {
  it("puts each run's did rows under its reply, with the run and the model that wrote it", () => {
    const turns = chatTurns(
      [
        msg(1, "person", "Set up a workflow", null, "frun_1"),
        msg(2, "did", "Created the workflow Launch content"),
        msg(3, "did", "Added the agent Research"),
        msg(4, "assistant", "Done.", { model: "opus" }, "frun_1"),
        msg(5, "person", "Post it to the blog", null, "frun_2"),
        msg(6, "assistant", "I couldn't finish that: it broke.", { failed: true }, "frun_2"),
      ],
      false,
    );
    expect(turns).toEqual([
      { kind: "person", seq: 1, text: "Set up a workflow" },
      {
        kind: "assistant",
        seq: 2,
        runId: "frun_1",
        text: "Done.",
        model: "opus",
        failed: false,
        working: false,
        dids: [
          { seq: 2, text: "Created the workflow Launch content" },
          { seq: 3, text: "Added the agent Research" },
        ],
      },
      { kind: "person", seq: 5, text: "Post it to the blog" },
      {
        kind: "assistant",
        seq: 6,
        runId: "frun_2",
        text: "I couldn't finish that: it broke.",
        model: null,
        failed: true,
        working: false,
        dids: [],
      },
    ]);
  });

  it("shows the working turn, with its run and the did rows so far, while a run is in flight", () => {
    const turns = chatTurns(
      [msg(1, "person", "Hi", null, "frun_9"), msg(2, "did", "Built the plugin X")],
      true,
    );
    expect(turns.at(-1)).toMatchObject({
      kind: "assistant",
      text: null,
      working: true,
      runId: "frun_9",
    });
    expect(turns).toHaveLength(2);
    const fresh = chatTurns([msg(1, "person", "Hi", null, "frun_1")], true);
    expect(fresh.at(-1)).toMatchObject({ kind: "assistant", working: true, dids: [] });
    expect(didCount([msg(1, "person", "Hi"), msg(2, "did", "x")])).toBe(1);
  });

  it("names a model by its label, and the runner's default as Claude", () => {
    const models = [{ id: "opus", label: "Opus" }];
    expect(choiceLabel(models, "opus")).toBe("Opus");
    expect(choiceLabel(models, null)).toBe("Claude");
    expect(madeAnything(EMPTY_MADE)).toBe(false);
    expect(
      madeAnything({ ...EMPTY_MADE, items: [{ id: "i", name: "x", projectId: "p", number: 1 }] }),
    ).toBe(true);
  });
});

describe("what the model is doing", () => {
  const notes = (id: string) => (id === "fprj_notes" ? "Notes" : null);

  it("says each tool call in plain words, and a flow_call's operation", () => {
    const call = (op: string, input: unknown) =>
      toolPhrase("mcp__factory__flow_call", JSON.stringify({ op, input }), notes);
    expect(call("flow.project.list", {})).toBe("Reading the projects");
    expect(call("flow.item.create", { projectId: "fprj_notes", title: "Search" })).toBe(
      "Creating an item in Notes",
    );
    expect(call("flow.workflow.create", { name: "Launch" })).toBe("Creating the workflow Launch");
    expect(call("flow.item.move", { itemId: "x" })).toBe("Moving an item");
    expect(toolPhrase("mcp__factory__flow_ops", "{}")).toBe("Looking at what it can do");
    expect(toolPhrase("mcp__factory__plugin_save", '{"name":"Blog"}')).toBe(
      "Saving the plugin Blog",
    );
    expect(toolPhrase("Read", '{"file_path":"/x"}')).toBe("Reading a file");
    expect(toolPhrase("Frobnicate", "{}")).toBe("Using Frobnicate");
  });

  it("tells a run's steps as lines and counts what it did", () => {
    const at = "2026-11-15T00:00:00.000Z";
    const lines = chatStepLines(
      runSteps([
        { seq: 1, at, kind: "note", text: "Let me look." },
        {
          seq: 2,
          at,
          kind: "tool",
          name: "mcp__factory__flow_call",
          label: "",
          input: '{"op":"flow.project.list","input":{}}',
          toolId: "t1",
        },
        { seq: 3, at, kind: "result", toolId: "t1", output: "[]", isError: false },
      ]),
      notes,
    );
    expect(lines).toEqual([
      { kind: "note", seq: 1, text: "Let me look." },
      { kind: "doing", seq: 2, text: "Reading the projects", failed: false },
    ]);
    expect(didThings(lines)).toBe("Did 1 thing");
  });
});
