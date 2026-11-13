// The planning MCP server (spec 20, ADR 0300, 0340): the planning agent's only way to change its work
// item's planning. One tool per planning operation (`question_ask` → `question.ask`, …), with the
// input schemas the cloud validates (runner-contract `PLANNING_INPUTS`), each call relayed through
// the runner host. A minimal stdio server: newline-delimited JSON-RPC 2.0, `initialize`,
// `tools/list`, `tools/call` and `ping`.
import {
  PLANNING_OPS,
  PLANNING_TOOL_DESCRIPTIONS,
  PLANNING_TOOL_INPUTS,
  type PlanningOp,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { type DesignChecker, designAfterPull, designBeforeSave } from "./designs.ts";
import { readHookState } from "./hooks.ts";
import { callRelay, RelayError, type RelayInfo } from "./relay.ts";

/**
 * Operations the agent calls as tools. News and waits come through the hooks instead, and a
 * pulled design's preview is stored by this server itself (spec 22 part B).
 */
export const PLANNING_TOOL_OPS = PLANNING_OPS.filter(
  (op) => op !== "planning.wait" && op !== "planning.peek" && op !== "design.preview",
);

/** An MCP tool name for an operation: `question.ask` → `question_ask`. */
export const toolName = (op: PlanningOp) => op.replace(".", "_");
const opFor = (name: string) => PLANNING_TOOL_OPS.find((op) => toolName(op) === name);

export function planningTools() {
  return PLANNING_TOOL_OPS.map((op) => ({
    name: toolName(op),
    description: PLANNING_TOOL_DESCRIPTIONS[op],
    // The shape the model writes (before the schema's transforms and defaults).
    inputSchema: z.toJSONSchema(PLANNING_TOOL_INPUTS[op], { io: "input", unrepresentable: "any" }),
  }));
}

interface Request {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Answers one JSON-RPC message; null for a notification. */
export async function handleMcp(
  message: Request,
  relay: Pick<RelayInfo, "url" | "token">,
  options: { fetch?: typeof fetch; relayFile?: string; designs?: DesignChecker } = {},
): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id ?? null, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id: message.id ?? null,
    error: { code, message: text },
  });
  if (message.id === undefined || message.id === null) return null;
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion:
          typeof message.params?.protocolVersion === "string"
            ? message.params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "software-factory-planning", version: "1" },
        instructions:
          "The work item's planning: questions, the living spec, chat, and asking for the spec gate. Every change goes through these tools.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: planningTools() });
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const op = opFor(name);
      if (!op) return fail(-32602, `unknown tool ${name}`);
      const raw = (message.params?.arguments ?? {}) as Record<string, unknown>;
      // The tool's own schema: delivery fields (ack, hold, cursor) are the hooks', never the
      // model's, so anything outside it is dropped before the call (review of #67).
      const parsed = PLANNING_TOOL_INPUTS[op].safeParse(raw);
      if (!parsed.success) {
        return reply({
          isError: true,
          content: [{ type: "text", text: `Invalid input: ${parsed.error.message}` }],
        });
      }
      const args = { ...(parsed.data as Record<string, unknown>) };
      // Asking for the gate, the agent has read what the hooks showed it: say so (spec 26).
      if (op === "planning.ready" && options.relayFile) {
        const shown = (await readHookState(options.relayFile)).shown;
        if (shown !== undefined) args.ack = shown;
      }
      const call = (o: PlanningOp, a: Record<string, unknown>) =>
        callRelay(relay, o, a, {
          timeoutMs: 60_000,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      try {
        // A design is checked here, on the runner, before it is saved (spec 22 part B): one that
        // won't draw is refused with its lines and never reaches the cloud; one that draws goes
        // with its preview, and its layout warnings come back to the planner.
        const design = await designBeforeSave(op, args, call, options.designs);
        if (design?.refused)
          return reply({ isError: true, content: [{ type: "text", text: design.refused }] });
        // The cloud parses them again with the operation's schema.
        const result = await call(op, args);
        const after = await designAfterPull(op, result, call, options.designs);
        const extra = design?.warnings?.length
          ? { layoutWarnings: design.warnings }
          : after
            ? { design: after }
            : {};
        return reply({
          content: [{ type: "text", text: JSON.stringify({ ...(result as object), ...extra }) }],
        });
      } catch (error) {
        const text =
          error instanceof RelayError
            ? `${op} refused${error.code ? ` (${error.code})` : ""}: ${error.message}`
            : `${op} failed: ${error instanceof Error ? error.message : error}`;
        return reply({ isError: true, content: [{ type: "text", text }] });
      }
    }
    default:
      return fail(-32601, `method not found: ${message.method}`);
  }
}

/** Runs the server on stdin/stdout until stdin closes. */
export async function serveMcp(
  relay: Pick<RelayInfo, "url" | "token">,
  relayFile?: string,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<void> {
  let buffer = "";
  const pending: Promise<void>[] = [];
  for await (const chunk of io.input) {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let message: Request;
      try {
        message = JSON.parse(line) as Request;
      } catch {
        io.output.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
        );
        continue;
      }
      pending.push(
        handleMcp(message, relay, relayFile ? { relayFile } : {}).then((answer) => {
          if (answer) io.output.write(`${JSON.stringify(answer)}\n`);
        }),
      );
    }
  }
  await Promise.all(pending);
}
