import { describe, expect, it } from "vitest";
import { streamJsonToEvents } from "../src/runner-local/adapter.ts";

describe("runner-local stream-json parsing", () => {
  it("turns claude -p stream-json lines into contract events", () => {
    expect(streamJsonToEvents('{"type":"system","subtype":"init"}')).toEqual([
      { type: "agent.status", status: "working" },
    ]);
    expect(
      streamJsonToEvents(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"README.md"}}]}}',
      ),
    ).toEqual([{ type: "tool", name: "Edit", input: '{"file_path":"README.md"}' }]);
    expect(streamJsonToEvents('{"type":"result","subtype":"success","result":"done"}')).toEqual([
      { type: "agent.status", status: "done" },
      { type: "session.ended", outcome: "completed", summary: "done" },
    ]);
    expect(
      streamJsonToEvents('{"type":"result","subtype":"error_max_turns","is_error":true}'),
    ).toEqual([
      { type: "agent.status", status: "error" },
      { type: "session.ended", outcome: "failed" },
    ]);
    expect(streamJsonToEvents("not json")).toEqual([
      { type: "log", stream: "stdout", text: "not json" },
    ]);
  });
});
