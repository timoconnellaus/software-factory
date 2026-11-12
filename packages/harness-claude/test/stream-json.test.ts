// The stream-json session mode's harness side (spec 37, ADR 0450): the launch argv, the takeover
// command, and output lines turned into bounded contract events.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MESSAGE_MAX,
  runnerEventSchema,
  TOOL_OUTPUT_MAX,
  TURN_ERROR_MAX,
} from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeArgv,
  denyPermissionLine,
  interruptLine,
  type LaunchRecord,
  projectHarness,
  resumeArgv,
  resumeCommand,
  STREAM_FLAGS,
  streamLineEvents,
  userMessageLine,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const job = { stage: "build" as const, harness: { id: "claude-code" as const, role: "implement" as const, prompt: "p", model: "m-1" } };

describe("the stream-json launch (ADR 0450)", () => {
  it("adds the stream flags and its own session id after the factory's flags", () => {
    const argv = claudeArgv(job, { settingsPath: "/r/s.json", stream: { sessionId: "sid-1" } });
    expect(argv.slice(0, 8)).toEqual([
      "claude",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project,local",
      "--settings",
      "/r/s.json",
      "--strict-mcp-config",
    ]);
    expect(argv).toContain("--session-id");
    expect(argv.slice(-STREAM_FLAGS.length)).toEqual([...STREAM_FLAGS]);
    expect(STREAM_FLAGS).toContain("--permission-prompts");
    // The TUI launch is unchanged.
    expect(claudeArgv(job, { settingsPath: "/r/s.json" })).not.toContain("-p");
  });

  it("projects a stream launch: the record has the session id and the unsets", async () => {
    const root = await mkdtemp(join(tmpdir(), "sf-stream-h-"));
    dirs.push(root);
    const projected = await projectHarness(
      { jobId: "job_1", ...job },
      { worktree: join(root, "wt"), runDir: join(root, "run"), session: "stream" },
    );
    const sid = projected.launch.stream?.sessionId as string;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(projected.launch.argv).toContain(sid);
    expect(projected.launch.unset).toContain("CLAUDE_CODE_PLUGIN_DIRS");
    const script = await readFile(projected.scriptPath, "utf8");
    expect(script).toContain("--input-format stream-json");
    expect(script).toContain(`--session-id ${sid}`);
  });

  it("builds the takeover command: interactive, same settings, the session resumed", () => {
    const record: Pick<LaunchRecord, "argv" | "worktree" | "unset"> = {
      argv: claudeArgv(job, { settingsPath: "/r/it's.json", stream: { sessionId: "sid-1" } }),
      worktree: "/w/a b",
      unset: ["GH_TOKEN", "CLAUDE_CODE_PLUGIN_DIRS"],
    };
    expect(resumeArgv(record, "sid-1")).toEqual([
      "claude",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project,local",
      "--settings",
      "/r/it's.json",
      "--strict-mcp-config",
      "--model",
      "m-1",
      "--resume",
      "sid-1",
    ]);
    expect(resumeCommand(record, "sid-1")).toBe(
      "cd '/w/a b' && env -u GH_TOKEN -u CLAUDE_CODE_PLUGIN_DIRS claude --permission-mode bypassPermissions --setting-sources project,local --settings '/r/it'\\''s.json' --strict-mcp-config --model m-1 --resume sid-1",
    );
    // A planning launch's own `--resume` is replaced, its MCP config kept.
    const planning = claudeArgv(
      { ...job, stage: "planning" },
      {
        settingsPath: "/s",
        planning: { mcpConfigPath: "/r/mcp.json", sessionRef: "ref-1", resume: true },
        stream: {},
      },
    );
    expect(resumeArgv({ argv: planning }, "ref-1").join(" ")).toBe(
      "claude --permission-mode dontAsk --setting-sources project,local --settings /s --strict-mcp-config --mcp-config /r/mcp.json --model m-1 --resume ref-1",
    );
  });
});

describe("stream-json output → events (ADR 0450)", () => {
  const line = (o: unknown) => JSON.stringify(o);

  it("maps init, text, tool calls, tool results and results; every event fits the wire", () => {
    const events = [
      ...streamLineEvents(line({ type: "system", subtype: "init", session_id: "s" })),
      ...streamLineEvents(
        line({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "  Reading.  " },
              { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "a.ts" } },
            ],
          },
        }),
      ),
      ...streamLineEvents(
        line({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu_1",
                content: [{ type: "text", text: "x".repeat(10_000) }],
                is_error: true,
              },
            ],
          },
        }),
      ),
      ...streamLineEvents(
        line({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          duration_ms: 12.6,
          num_turns: 3,
          total_cost_usd: 1.23,
          usage: { input_tokens: 1, output_tokens: 2 },
          errors: ["e".repeat(5_000)],
        }),
      ),
      ...streamLineEvents("not json"),
      ...streamLineEvents(line({ type: "stream_event" })),
    ];
    expect(events.map((e) => e.type)).toEqual([
      "agent.status",
      "message",
      "tool",
      "tool.result",
      "turn",
      "log",
    ]);
    expect(events[1]).toEqual({ type: "message", role: "assistant", text: "Reading." });
    expect(events[2]).toEqual({ type: "tool", name: "Read", input: '{"file_path":"a.ts"}', id: "tu_1" });
    const result = events[3] as { output: string; isError: boolean };
    expect(result.output.length).toBe(TOOL_OUTPUT_MAX);
    expect(result.output.startsWith("…")).toBe(true);
    expect(result.isError).toBe(true);
    const turn = events[4] as { error: string; usage: unknown; durationMs: number };
    expect(turn.error.length).toBe(TURN_ERROR_MAX);
    expect(turn.durationMs).toBe(13);
    // Counts only: no cost.
    expect(JSON.stringify(turn)).not.toContain("1.23");
    expect(turn.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    for (const [seq, e] of events.entries()) {
      expect(
        runnerEventSchema.safeParse({ ...e, jobId: "job_1", seq, at: new Date().toISOString() })
          .success,
      ).toBe(true);
    }
  });

  it("clips long assistant text and leaves out a subagent's own messages", () => {
    const [long] = streamLineEvents(
      line({ type: "assistant", message: { content: [{ type: "text", text: "a".repeat(20_000) }] } }),
    );
    expect((long as { text: string }).text.length).toBe(MESSAGE_MAX);
    expect(
      streamLineEvents(
        line({
          type: "assistant",
          parent_tool_use_id: "tu_task",
          message: { content: [{ type: "text", text: "inner" }] },
        }),
      ),
    ).toEqual([]);
  });

  it("writes the input lines Claude reads", () => {
    expect(JSON.parse(userMessageLine("hi", "s"))).toEqual({
      type: "user",
      message: { role: "user", content: "hi" },
      parent_tool_use_id: null,
      session_id: "s",
    });
    expect(userMessageLine("hi").endsWith("\n")).toBe(true);
    expect(JSON.parse(interruptLine("r1"))).toEqual({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "interrupt" },
    });
    expect(JSON.parse(denyPermissionLine("r2")).response.response.behavior).toBe("deny");
  });
});
