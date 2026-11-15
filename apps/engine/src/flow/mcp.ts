// The engine's own MCP server, "factory" (spec 70 milestone 2): what an agent with it in its `mcp`
// uses, during one of its runs, to set up workflows, projects, agents and items (every flow.*
// operation) and to build plugins (the plugin editor). Streamable HTTP at /flow/mcp: a POST of one
// JSON-RPC message (or a batch) answered as JSON; no sessions and no server-sent stream. The
// bearer token names the run (mcp-auth.ts); every call acts as that run's agent, in its org.
import { type CallResult, describeWithInputs } from "@software-factory/ops";
import { PLUGIN_GUIDE } from "@software-factory/plugins";
import { callFlowAs } from "./door.ts";
import { authenticateMcp } from "./mcp-auth.ts";

const PROTOCOL = "2025-06-18";

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const text = { type: "string" };

/** The tools, with the flow operation each one calls (if it is one). */
const TOOLS = [
  {
    name: "flow_ops",
    description:
      "List every flow.* operation (workflows, projects, agents, items, the board, plugins, gateways) with its description and input JSON Schema. Call them with flow_call.",
    inputSchema: object(),
  },
  {
    name: "flow_call",
    description:
      "Call one flow.* operation as this run's agent, in this run's org (orgId is filled in for you). Use it to set up workflows, projects and agents, and to create and move items.",
    inputSchema: object(
      { op: { ...text, description: "e.g. flow.workflow.create" }, input: { type: "object" } },
      ["op"],
    ),
  },
  {
    name: "plugin_guide",
    description:
      "How to write a plugin: the module's shape, its hooks, ctx, gateways, triggers, failure, and a complete example. Read it before plugin_save.",
    inputSchema: object(),
  },
  {
    name: "plugin_list",
    description: "The org's plugins: name, request, on or off, last error, fields and hooks.",
    inputSchema: object(),
  },
  {
    name: "plugin_read",
    description: "One plugin by name, with its code and trigger path.",
    inputSchema: object({ name: text }, ["name"]),
  },
  {
    name: "plugin_save",
    description:
      "Create or replace the plugin `name` with `code` (one ES module), recording `request`, the person's plain words. Saved only if the module loads and its default export has the right shape; otherwise the load error comes back. Live at once for the whole org.",
    inputSchema: object({ name: text, request: text, code: text }, ["name", "code"]),
  },
  {
    name: "plugin_delete",
    description: "Delete the plugin `name`.",
    inputSchema: object({ name: text }, ["name"]),
  },
  {
    name: "gateway_list",
    description:
      "The org's gateways, by name and base URL: what ctx.gateway(name).fetch(path) can reach.",
    inputSchema: object(),
  },
] as const;

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
type Auth = NonNullable<Awaited<ReturnType<typeof authenticateMcp>>>;

const toolResult = (value: unknown, isError = false) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
  ...(isError ? { isError: true } : {}),
});

const fromCall = (out: CallResult, map: (r: unknown) => unknown = (r) => r) =>
  out.ok
    ? toolResult(map(out.result))
    : toolResult(`${out.error.code}: ${out.error.message}`, true);

async function callTool(env: Env, auth: Auth, name: string, args: Record<string, unknown>) {
  const org = auth.run.orgId;
  const as = (op: string, input: Record<string, unknown>) =>
    callFlowAs(env, auth.caller, op, { ...input, orgId: org });
  switch (name) {
    case "flow_ops":
      return toolResult(describeWithInputs());
    case "flow_call": {
      const op = typeof args.op === "string" ? args.op : "";
      const input = (args.input && typeof args.input === "object" ? args.input : {}) as Record<
        string,
        unknown
      >;
      return fromCall(await as(op, input));
    }
    case "plugin_guide":
      return toolResult(PLUGIN_GUIDE);
    case "plugin_list":
      return fromCall(await as("flow.plugin.list", {}));
    case "plugin_read":
      return fromCall(await as("flow.plugin.get", { name: args.name }));
    case "plugin_save":
      return fromCall(
        await as("flow.plugin.save", {
          name: args.name,
          request: typeof args.request === "string" ? args.request : "",
          code: args.code,
        }),
      );
    case "plugin_delete":
      return fromCall(await as("flow.plugin.delete", { name: args.name }));
    case "gateway_list":
      return fromCall(await as("flow.gateway.list", {}), (r) =>
        (r as { gateways: { name: string; baseUrl: string }[] }).gateways.map((g) => ({
          name: g.name,
          baseUrl: g.baseUrl,
        })),
      );
    default:
      return null;
  }
}

/** Answers one JSON-RPC message; null for a notification (or a response) that needs none. */
async function answer(env: Env, auth: Auth, message: Message): Promise<unknown> {
  if (message.id === undefined || message.id === null || typeof message.method !== "string") {
    return null;
  }
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, text: string) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: text },
  });
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as {
    protocolVersion?: unknown;
    name?: unknown;
    arguments?: unknown;
  };
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "software-factory", version: "1" },
        instructions:
          "This org's workflows, projects, agents, items and plugins. flow_ops lists the operations and flow_call calls one; read plugin_guide before writing a plugin with plugin_save.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const args = (
        params.arguments && typeof params.arguments === "object" ? params.arguments : {}
      ) as Record<string, unknown>;
      const result = await callTool(env, auth, String(params.name ?? ""), args);
      return result ? reply(result) : fail(-32602, `Unknown tool ${String(params.name)}.`);
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The /flow/mcp route. */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "POST JSON-RPC messages here; this server has no event stream." }, 405);
  }
  const auth = await authenticateMcp(env.DB, request.headers.get("authorization"));
  if (!auth) {
    return json(
      { error: "This token is unknown, or its run is no longer claimed.", code: "unauthenticated" },
      401,
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    // At most 20 a request: each may be a few D1 queries (AGENTS.md cost rule 7).
    for (const message of body.slice(0, 20)) {
      const a = await answer(env, auth, message as Message);
      if (a) out.push(a);
    }
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const a = await answer(env, auth, body as Message);
  return a ? json(a) : new Response(null, { status: 202 });
}
