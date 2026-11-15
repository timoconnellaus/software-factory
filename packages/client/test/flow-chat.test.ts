// The conversation told as turns (flow-chat.ts): a person's message, then the agent's reply with
// what it did under it, and the working turn while a run is in flight.
import { describe, expect, it } from "vitest";
import { chatTurns, didCount, type FlowChatMessage } from "../src/flow-chat.ts";

const msg = (seq: number, role: FlowChatMessage["role"], text: string, data: unknown = null) => ({
  id: `m${seq}`,
  seq,
  role,
  text,
  data,
  runId: null,
  createdAt: "2026-11-15T00:00:00.000Z",
});

describe("chatTurns", () => {
  it("puts each run's did rows under its reply", () => {
    const turns = chatTurns(
      [
        msg(1, "person", "Set up a workflow"),
        msg(2, "did", "Created the workflow Launch content"),
        msg(3, "did", "Added the agent Research"),
        msg(4, "agent", "Done."),
        msg(5, "person", "Post it to the blog"),
        msg(6, "agent", "I couldn't finish that: it broke.", { failed: true }),
      ],
      false,
    );
    expect(turns).toEqual([
      { kind: "person", seq: 1, text: "Set up a workflow" },
      {
        kind: "agent",
        seq: 2,
        text: "Done.",
        failed: false,
        working: false,
        dids: [
          { seq: 2, text: "Created the workflow Launch content" },
          { seq: 3, text: "Added the agent Research" },
        ],
      },
      { kind: "person", seq: 5, text: "Post it to the blog" },
      {
        kind: "agent",
        seq: 6,
        text: "I couldn't finish that: it broke.",
        failed: true,
        working: false,
        dids: [],
      },
    ]);
  });

  it("shows the working turn, with the did rows so far, while a run is in flight", () => {
    const turns = chatTurns([msg(1, "person", "Hi"), msg(2, "did", "Built the plugin X")], true);
    expect(turns.at(-1)).toMatchObject({ kind: "agent", text: null, working: true });
    expect(turns).toHaveLength(2);
    const fresh = chatTurns([msg(1, "person", "Hi")], true);
    expect(fresh.at(-1)).toMatchObject({ kind: "agent", working: true, dids: [] });
    expect(didCount([msg(1, "person", "Hi"), msg(2, "did", "x")])).toBe(1);
  });
});
