// What a chat's model is doing, in plain words (spec 70, "Chat"): a run's steps (flow-run.ts) as quiet
// lines such as "Reading the projects" or "Creating an item in Notes". A tool's name maps to a short
// phrase; a call through the factory MCP server's `flow_call` says the operation in words.
import type { RunStep } from "./flow-run.ts";

/** A line the chat shows for a step: a phrase for a tool call, or a note the model wrote. */
export type ChatStepLine =
  | { kind: "doing"; seq: number; text: string; failed: boolean }
  | { kind: "note"; seq: number; text: string };

type Rec = Record<string, unknown>;
const parse = (input: string): Rec => {
  try {
    const v = JSON.parse(input) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
  } catch {
    return {};
  }
};
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The nouns of the flow.* operations: singular with its article, and plural. */
const NOUNS: Record<string, [string, string]> = {
  workflow: ["a workflow", "the workflows"],
  project: ["a project", "the projects"],
  agent: ["an agent", "the agents"],
  item: ["an item", "the items"],
  plugin: ["a plugin", "the plugins"],
  gateway: ["a gateway", "the gateways"],
  schedule: ["a schedule", "the schedules"],
  board: ["the board", "the board"],
  inbox: ["the inbox", "the inbox"],
  run: ["a run", "the runs"],
  member: ["a member", "the members"],
  timeline: ["an item's history", "an item's history"],
  chat: ["a chat", "the chats"],
};

const VERBS: Record<string, string> = {
  create: "Creating",
  update: "Changing",
  save: "Saving",
  delete: "Deleting",
  move: "Moving",
  finish: "Finishing",
  decide: "Deciding on",
  retry: "Retrying",
  comment: "Commenting on",
  setField: "Setting a field on",
  setWorkflow: "Changing the workflow of",
  setEnabled: "Switching",
  get: "Reading",
  events: "Reading",
};

/** A flow.* operation in words, with the project's name for an item it creates there. */
export function flowOpPhrase(op: string, input: Rec, projectName?: (id: string) => string | null) {
  const [, noun = "", verb = ""] = op.split(".");
  const [one, many] = NOUNS[noun] ?? [`a ${noun}`, `the ${noun}s`];
  const named = str(input.name) ?? str(input.title);
  if (verb === "list" || verb === "all") return `Reading ${many}`;
  if (op === "flow.item.create") {
    const project = str(input.projectId);
    const where = project ? projectName?.(project) : null;
    return where ? `Creating an item in ${where}` : "Creating an item";
  }
  const doing = VERBS[verb];
  if (!doing) return `Using ${op.replace(/^flow\./, "")}`;
  if (named && (verb === "create" || verb === "save"))
    return `${doing} ${one.replace(/^an? /, "the ")} ${named}`;
  return `${doing} ${one}`;
}

/** Built-in tools and the factory server's own, as short phrases. */
const TOOLS: Record<string, string> = {
  Read: "Reading a file",
  Write: "Writing a file",
  Edit: "Editing a file",
  MultiEdit: "Editing a file",
  Bash: "Running a command",
  Grep: "Searching",
  Glob: "Looking for files",
  WebFetch: "Reading a web page",
  WebSearch: "Searching the web",
  TodoWrite: "Planning",
  ToolSearch: "Looking up its tools",
  Task: "Handing part of it off",
  Agent: "Handing part of it off",
  flow_ops: "Looking at what it can do",
  plugin_guide: "Reading the plugin guide",
  plugin_list: "Reading the plugins",
  plugin_read: "Reading a plugin",
  plugin_save: "Saving a plugin",
};

/** One tool call in words. An MCP tool's name is `mcp__<server>__<tool>`. */
export function toolPhrase(
  name: string,
  input: string,
  projectName?: (id: string) => string | null,
): string {
  const tool = name.startsWith("mcp__") ? (name.split("__").at(-1) ?? name) : name;
  const args = parse(input);
  if (tool === "flow_call") {
    const op = str(args.op);
    const opInput = args.input && typeof args.input === "object" ? (args.input as Rec) : {};
    return op ? flowOpPhrase(op, opInput, projectName) : "Using the app";
  }
  const named = str(args.name);
  if (tool === "plugin_save" && named) return `Saving the plugin ${named}`;
  if (tool === "plugin_read" && named) return `Reading the plugin ${named}`;
  return TOOLS[tool] ?? `Using ${tool}`;
}

/** The steps as lines: each tool call in words, each note as it is. */
export function chatStepLines(
  steps: RunStep[],
  projectName?: (id: string) => string | null,
): ChatStepLine[] {
  return steps.map((s) =>
    s.kind === "note"
      ? { kind: "note", seq: s.seq, text: s.text }
      : {
          kind: "doing",
          seq: s.seq,
          text: toolPhrase(s.name, s.input, projectName),
          failed: s.isError,
        },
  );
}

/** "Did 6 things": how many tool calls a finished run made. */
export function didThings(lines: ChatStepLine[]): string {
  const n = lines.filter((l) => l.kind === "doing").length;
  return n === 1 ? "Did 1 thing" : `Did ${n} things`;
}
