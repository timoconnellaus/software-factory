// The contract between the desktop app and the engine's `flow.*` operations: for every operation
// the app calls, the shape of the answer it reads (a zod schema; the types the screens use are
// inferred from the same schemas) and the inputs it sends, built by the app's own builders. Two
// checks hold the app to it: packages/client/test/flow-contract.test.ts (no database: each name is
// in the server's registry and each input parses against its schema) and the engine's
// test/flow-contract.test.ts (each answer, from the real routes over a seeded org, parses here).
// The desktop's fixtures are checked against the same schemas (apps/desktop/test).
import { z } from "zod";
import {
  agentUpdate,
  decisionFor,
  type FlowItem,
  type FlowOpMap,
  type FlowStatus,
  flowAgentSchema,
  flowBoardSchema,
  flowGithubReposSchema,
  flowInboxAllSchema,
  flowInboxSchema,
  flowItemDetailSchema,
  flowItemSchema,
  flowProjectSchema,
  flowRunSchema,
  flowTimelineSchema,
  flowWorkflowSchema,
} from "./flow.ts";
import { draftOf, flowSavedScheduleSchema, flowScheduleSchema, toInput } from "./flow-auto.ts";
import { flowChatOptionsSchema, flowChatSchema, flowChatViewSchema } from "./flow-chat.ts";
import {
  flowGatewaySchema,
  flowMemberSchema,
  flowPluginDetailSchema,
  flowPluginSchema,
  newStatus,
  statusesToSave,
} from "./flow-edit.ts";
import { flowRunEventsSchema, flowRunViewSchema } from "./flow-run.ts";

type Responses = { [K in keyof FlowOpMap]: z.ZodType<FlowOpMap[K]["output"]> };

const ok = z.object({ ok: z.boolean() });

/** What each operation the app calls answers, as the app reads it. */
export const FLOW_RESPONSES = {
  "flow.project.list": z.object({ projects: z.array(flowProjectSchema) }),
  "flow.project.create": flowProjectSchema,
  "flow.project.setWorkflow": flowProjectSchema,
  "flow.project.get": flowProjectSchema,
  "flow.project.setRepository": flowProjectSchema,
  "flow.github.repos": flowGithubReposSchema,
  "flow.workflow.list": z.object({ workflows: z.array(flowWorkflowSchema) }),
  "flow.workflow.get": flowWorkflowSchema,
  "flow.workflow.create": flowWorkflowSchema,
  "flow.workflow.update": flowWorkflowSchema,
  "flow.agent.list": z.object({ agents: z.array(flowAgentSchema) }),
  "flow.agent.create": flowAgentSchema,
  "flow.agent.update": flowAgentSchema,
  "flow.inbox.all": flowInboxAllSchema,
  "flow.inbox.get": flowInboxSchema,
  "flow.member.list": z.object({ members: z.array(flowMemberSchema) }),
  "flow.run.list": z.object({ runs: z.array(flowRunSchema) }),
  "flow.run.get": z.object({ run: flowRunViewSchema }),
  "flow.run.events": flowRunEventsSchema,
  "flow.board.get": flowBoardSchema,
  "flow.timeline.get": flowTimelineSchema,
  "flow.item.get": flowItemDetailSchema,
  "flow.item.create": flowItemSchema,
  "flow.item.finish": flowItemSchema,
  "flow.item.decide": flowItemSchema,
  "flow.item.retry": flowItemSchema,
  "flow.item.comment": ok,
  "flow.plugin.list": z.object({ plugins: z.array(flowPluginSchema) }),
  "flow.plugin.get": flowPluginDetailSchema,
  "flow.plugin.setEnabled": flowPluginSchema,
  "flow.plugin.delete": ok,
  "flow.gateway.list": z.object({ gateways: z.array(flowGatewaySchema) }),
  "flow.gateway.save": flowGatewaySchema,
  "flow.gateway.delete": ok,
  "flow.chat.options": flowChatOptionsSchema,
  "flow.chat.list": z.object({ chats: z.array(flowChatSchema) }),
  "flow.chat.get": flowChatViewSchema,
  "flow.chat.create": flowChatViewSchema,
  "flow.chat.send": flowChatViewSchema,
  "flow.chat.delete": z.object({ deleted: z.boolean() }),
  "flow.schedule.list": z.object({ schedules: z.array(flowScheduleSchema) }),
  "flow.schedule.save": flowSavedScheduleSchema,
  "flow.schedule.delete": ok,
  "flow.schedule.runNow": z.object({ id: z.string(), number: z.number() }),
} satisfies Responses;

export type FlowOpName = keyof FlowOpMap;

/** The operations the app calls, in the order a contract test can call them. */
export const FLOW_OP_NAMES = Object.keys(FLOW_RESPONSES) as FlowOpName[];

/** The ids a request names; the engine's test fills them from what it seeded. */
export interface ContractIds {
  orgId: string;
  userId: string;
  projectId: string;
  workflowId: string;
  /** An agent (without the Plugin editor). */
  agentId: string;
  itemId: string;
  runId: string;
  chatId: string;
  pluginName: string;
  gatewayName: string;
  gatewayId: string;
  scheduleId: string;
  /** A repository the org's GitHub connection reaches (the project Settings picker). */
  repoOwner: string;
  repoName: string;
}

/** An item as decisionFor reads it: waiting on `waiting`. */
const waitingItem = (ids: ContractIds, waiting: FlowItem["waiting"]): FlowItem => ({
  id: ids.itemId,
  orgId: ids.orgId,
  projectId: ids.projectId,
  number: 1,
  title: "An item",
  body: "",
  statusId: "review",
  waiting,
  error: null,
  stay: 1,
  createdBy: ids.userId,
  createdAt: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-11-15T00:00:00.000Z",
});

const REVIEW: FlowStatus[] = [
  { id: "draft", name: "Draft", owner: { kind: "none" } },
  { id: "review", name: "Review", owner: { kind: "none" } },
  { id: "done", name: "Done", owner: { kind: "none" } },
];

/** The inputs of the item panel's buttons for an item waiting as `waiting` (item.tsx `act`). */
function actionInputs(ids: ContractIds, waiting: FlowItem["waiting"]) {
  const decision = decisionFor(waitingItem(ids, waiting), REVIEW, ids.userId);
  return (decision?.actions ?? []).map((a) => ({
    orgId: ids.orgId,
    itemId: ids.itemId,
    ...a.input,
  }));
}

/** A schedule form filled in and sent (auto-form.tsx), or refused before it is sent. */
function scheduleInput(
  ids: ContractIds,
  draft: Partial<ReturnType<typeof draftOf>>,
  scheduleId?: string,
) {
  const input = toInput(
    ids.orgId,
    { ...draftOf(null, ids.projectId, "Australia/Sydney"), ...draft },
    scheduleId,
  );
  if ("problem" in input) throw new Error(input.problem);
  return input;
}

/**
 * Each operation's inputs as the app builds them (its builders where it has one, else the literal
 * the screen writes), for the given ids. Mutating operations are meant to be called in order.
 */
export const FLOW_REQUESTS: {
  [K in FlowOpName]: (ids: ContractIds) => FlowOpMap[K]["input"][];
} = {
  "flow.project.list": ({ orgId }) => [{ orgId }],
  "flow.project.create": ({ orgId, workflowId }) => [
    { orgId, name: "Contract", key: "CON", workflowId },
  ],
  "flow.project.setWorkflow": ({ orgId, projectId, workflowId }) => [
    { orgId, projectId, workflowId },
  ],
  "flow.project.get": ({ orgId, projectId }) => [{ orgId, projectId }],
  // The project's Settings (project-settings.tsx): Clear, then a repository picked from the list.
  "flow.project.setRepository": ({ orgId, projectId, repoOwner, repoName }) => [
    { orgId, projectId, clear: true },
    { orgId, projectId, owner: repoOwner, name: repoName },
  ],
  "flow.github.repos": ({ orgId }) => [{ orgId }],
  "flow.workflow.list": ({ orgId }) => [{ orgId }],
  "flow.workflow.get": ({ orgId, workflowId }) => [{ orgId, workflowId }],
  "flow.workflow.create": (ids) => {
    // The editor's statuses: new ones get ids from their names on save (workflow.tsx).
    const draft = {
      ...newStatus("Draft"),
      owner: { kind: "agent" as const, agentId: ids.agentId },
    };
    const review = {
      ...newStatus("Review"),
      owner: { kind: "person" as const, userId: ids.userId },
      onReject: draft.id,
    };
    const done = { ...newStatus("Done"), needsDecision: false };
    const { statuses } = statusesToSave([
      { ...draft, brief: "Write it.", onDone: review.id },
      review,
      done,
    ]);
    return [{ orgId: ids.orgId, name: "Contract workflow", statuses }];
  },
  "flow.workflow.update": (ids) => {
    const { statuses } = statusesToSave([
      { id: "draft", name: "Draft", owner: { kind: "agent", agentId: ids.agentId }, brief: "Go." },
      { ...newStatus("Check"), owner: { kind: "person", userId: ids.userId }, onReject: "draft" },
      { id: "done", name: "Done", owner: { kind: "none" }, onDone: "draft" },
    ]);
    return [{ orgId: ids.orgId, workflowId: ids.workflowId, name: "Contract (edited)", statuses }];
  },
  "flow.agent.list": ({ orgId }) => [{ orgId }],
  "flow.agent.create": ({ orgId }) => [{ orgId, name: "Reviewer", instructions: "Review it." }],
  "flow.agent.update": ({ orgId, agentId }) => {
    const agent = { id: agentId, name: "Writer", instructions: "Write it.", mcp: [] };
    return [
      agentUpdate(orgId, agent, { instructions: "Write it plainly." }),
      agentUpdate(orgId, agent, { pluginEditor: true }),
      agentUpdate(orgId, agent, { model: "sonnet", effort: "high" }),
      agentUpdate(orgId, agent, { model: null }),
    ];
  },
  "flow.inbox.all": () => [{}],
  "flow.inbox.get": ({ orgId }) => [{ orgId }],
  "flow.member.list": ({ orgId }) => [{ orgId }],
  "flow.run.list": ({ orgId, agentId, itemId }) => [
    { orgId, agentId, limit: 20 },
    { orgId, itemId },
  ],
  "flow.run.get": ({ orgId, runId }) => [{ orgId, runId }],
  "flow.run.events": ({ orgId, runId }) => [
    { orgId, runId },
    { orgId, runId, after: 1 },
  ],
  "flow.board.get": ({ orgId, projectId }) => [{ orgId, projectId }],
  "flow.timeline.get": ({ orgId, itemId }) => [{ orgId, itemId }],
  "flow.item.get": ({ orgId, itemId }) => [{ orgId, itemId }],
  "flow.item.create": ({ orgId, projectId }) => [
    { orgId, projectId, title: "Write the launch post", body: "" },
  ],
  // The item panel's Done (the first action) for an item waiting on the person.
  "flow.item.finish": (ids) =>
    actionInputs(ids, { on: "person", userId: ids.userId }).slice(
      0,
      1,
    ) as FlowOpMap["flow.item.finish"]["input"][],
  // Its Approve, for an item waiting on a decision.
  "flow.item.decide": (ids) =>
    actionInputs(ids, { on: "decision" }).slice(0, 1) as FlowOpMap["flow.item.decide"]["input"][],
  "flow.item.retry": ({ orgId, itemId }) => [{ orgId, itemId }],
  "flow.item.comment": ({ orgId, itemId }) => [{ orgId, itemId, text: "Mention the board." }],
  "flow.plugin.list": ({ orgId }) => [{ orgId }],
  "flow.plugin.get": ({ orgId, pluginName }) => [{ orgId, name: pluginName }],
  "flow.plugin.setEnabled": ({ orgId, pluginName }) => [
    { orgId, name: pluginName, enabled: false },
    { orgId, name: pluginName, enabled: true },
  ],
  "flow.plugin.delete": ({ orgId, pluginName }) => [{ orgId, name: pluginName }],
  "flow.gateway.list": ({ orgId }) => [{ orgId }],
  // The connection form (plugins.tsx): a new one with its secret, then an edit by id.
  "flow.gateway.save": ({ orgId, gatewayName, gatewayId }) => [
    {
      orgId,
      name: gatewayName,
      baseUrl: "https://api.example.com/v1",
      auth: { kind: "bearer" },
      secret: "s3cret",
    },
    {
      orgId,
      gatewayId,
      name: gatewayName,
      baseUrl: "https://api.example.com/v2",
      auth: { kind: "header", header: "X-Api-Key" },
    },
  ],
  "flow.gateway.delete": ({ orgId, gatewayName }) => [{ orgId, name: gatewayName }],
  "flow.chat.list": ({ orgId }) => [{ orgId }],
  "flow.chat.get": ({ orgId, chatId }) => [{ orgId, chatId }],
  "flow.chat.options": ({ orgId }) => [{ orgId }],
  "flow.chat.create": ({ orgId }) => [
    { orgId, text: "Set up a workflow for launch posts.", model: "sonnet", effort: "high" },
  ],
  "flow.chat.send": ({ orgId, chatId }) => [
    { orgId, chatId, text: "And a plugin for it.", model: "opus" },
  ],
  "flow.chat.delete": ({ orgId, chatId }) => [{ orgId, chatId }],
  "flow.schedule.list": ({ orgId }) => [{ orgId }],
  // The Auto form: a daily one, an hourly one, a weekly one; then the table's on/off switch,
  // which sends the schedule back whole (auto.tsx).
  "flow.schedule.save": (ids) => [
    scheduleInput(ids, { name: "Nightly", title: "Tidy the board", time: "02:00" }),
    scheduleInput(ids, { name: "Hourly", title: "Check", every: "hour", time: "00:15" }),
    scheduleInput(ids, { name: "Weekly", title: "Plan", every: "week", onDay: 1 }),
    {
      ...scheduleInput(ids, { name: "Nightly", title: "Tidy the board", time: "02:00" }),
      scheduleId: ids.scheduleId,
      enabled: false,
    },
  ],
  "flow.schedule.delete": ({ orgId, scheduleId }) => [{ orgId, scheduleId }],
  "flow.schedule.runNow": ({ orgId, scheduleId }) => [{ orgId, scheduleId }],
};

/** Input keys the server's schema dropped: a field the app sends that the server never reads. */
export function droppedKeys(sent: unknown, parsed: unknown, path = ""): string[] {
  if (Array.isArray(sent)) {
    return sent.flatMap((v, i) =>
      droppedKeys(v, Array.isArray(parsed) ? parsed[i] : undefined, `${path}${i}.`),
    );
  }
  if (!sent || typeof sent !== "object") return [];
  const out = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  return Object.entries(sent as Record<string, unknown>).flatMap(([key, value]) =>
    value === undefined
      ? []
      : key in out
        ? droppedKeys(value, out[key], `${path}${key}.`)
        : [`${path}${key}`],
  );
}

/**
 * Every optional key path a schema describes (an array's elements as `[]`). A required key needs no
 * such check: an answer without it fails the schema.
 */
function optionalPaths(schema: z.ZodType, path: string, out: Set<string>): Set<string> {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return optionalPaths(schema.unwrap() as z.ZodType, path, out);
  }
  if (schema instanceof z.ZodObject) {
    for (const [key, value] of Object.entries(schema.shape)) {
      if (value instanceof z.ZodOptional) out.add(`${path}${key}`);
      optionalPaths(value as z.ZodType, `${path}${key}.`, out);
    }
  } else if (schema instanceof z.ZodArray) {
    optionalPaths(schema.element as z.ZodType, `${path}[].`, out);
  } else if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) optionalPaths(option as z.ZodType, path, out);
  }
  return out;
}

/** Every key path the values carry (null counts: the server sent it). */
function presentPaths(value: unknown, path: string, out: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) presentPaths(v, `${path}[].`, out);
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out.add(`${path}${key}`);
      presentPaths(v, `${path}${key}.`, out);
    }
  }
  return out;
}

/**
 * The optional keys a response schema describes that none of the answers carried: a field the app
 * reads (it passes the schema when it is missing) that the server may never send.
 */
export function unseenKeys(schema: z.ZodType, answers: unknown[]): string[] {
  const present = new Set<string>();
  for (const a of answers) presentPaths(a, "", present);
  return [...optionalPaths(schema, "", new Set())].filter((p) => !present.has(p));
}
