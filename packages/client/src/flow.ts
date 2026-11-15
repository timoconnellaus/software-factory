// The new core's views (ADR 0660, spec 70) as the desktop app reads them: the `flow.*` operations'
// answers, typed by hand from @software-factory/store and @software-factory/flow (types only; a view
// imports neither), and the pure logic the board and the item panel need: an item's key, its chips,
// the decision it waits on, and its timeline told as one line per move.
import { z } from "zod";
import type { FlowAutoOpMap } from "./flow-auto.ts";
import type { FlowChatOpMap } from "./flow-chat.ts";
import { type FlowEditOpMap, type FlowMember, flowFieldSchema } from "./flow-edit.ts";
import type { FlowRunEvents, FlowRunView } from "./flow-run.ts";
import { ago } from "./format.ts";

// Each answer's shape is a zod schema and its type is inferred from it, so the type the screens
// read and the check that the server (and the fixtures) really answer it can't drift apart
// (flow-contract.ts). The schemas only describe: nothing parses a server's answer at run time.

export const flowOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("person"), userId: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type FlowOwner = z.infer<typeof flowOwnerSchema>;

export const flowStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: flowOwnerSchema,
  brief: z.string().optional(),
  onDone: z.string().optional(),
  onReject: z.string().optional(),
  needsDecision: z.boolean().optional(),
});
export type FlowStatus = z.infer<typeof flowStatusSchema>;

export const flowActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), id: z.string() }),
  z.object({ kind: z.literal("agent"), id: z.string() }),
  /** A plugin acting through its hooks (a card, a field); `id` is the plugin's name. */
  z.object({ kind: z.literal("plugin"), id: z.string() }),
  z.object({ kind: z.literal("system") }),
]);
export type FlowActor = z.infer<typeof flowActorSchema>;

export const flowWaitingSchema = z.discriminatedUnion("on", [
  z.object({ on: z.literal("run"), agentId: z.string() }),
  z.object({ on: z.literal("person"), userId: z.string() }),
  z.object({ on: z.literal("decision") }),
  z.object({ on: z.literal("nothing") }),
]);
export type FlowWaiting = z.infer<typeof flowWaitingSchema>;

export const flowItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  projectId: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  statusId: z.string(),
  waiting: flowWaitingSchema,
  error: z.string().nullable(),
  stay: z.number(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Plugin fields' values, by field id (flow-edit.ts `fieldChips`). */
  fields: z.record(z.string(), z.unknown()).optional(),
  /** Its branch on the project's repository, once a run there was claimed (else null). */
  branch: z.string().nullable().optional(),
  /** The head the last run that ended done pushed to that branch (else null). */
  headSha: z.string().nullable().optional(),
});
export type FlowItem = z.infer<typeof flowItemSchema>;

/** A project's repository: where its runs check out and push the item's branch. */
export const flowRepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
});
export type FlowRepo = z.infer<typeof flowRepoSchema>;

/** A repository the org's GitHub connection reaches (`flow.github.repos`). */
export const flowGithubRepoSchema = flowRepoSchema.extend({ installationId: z.string() });
export type FlowGithubRepo = z.infer<typeof flowGithubRepoSchema>;

/** `flow.github.repos`: whether the org has a GitHub connection, and what it reaches. */
export const flowGithubReposSchema = z.object({
  connected: z.boolean(),
  /** The GitHub account it is connected as, when connected. */
  account: z.string().nullable(),
  repos: z.array(flowGithubRepoSchema),
});
export type FlowGithubRepos = z.infer<typeof flowGithubReposSchema>;

/** "acme/api". */
export const repoName = (repo: Pick<FlowRepo, "owner" | "name">) => `${repo.owner}/${repo.name}`;

export const flowProjectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  key: z.string(),
  workflowId: z.string(),
  nextNumber: z.number(),
  /** The GitHub repository its runs work in, or null. Optional: an engine before it sends none. */
  repo: flowRepoSchema.nullable().optional(),
  /** Its items not yet in the workflow's last status (`flow.project.list` only). */
  openCount: z.number().optional(),
  createdAt: z.string(),
});
export type FlowProject = z.infer<typeof flowProjectSchema>;

export const flowAgentSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  instructions: z.string(),
  /** The MCP servers it gets beyond the base ones: `["factory"]` is the Plugin editor. */
  mcp: z.array(z.string()).optional(),
  createdAt: z.string(),
});
export type FlowAgent = z.infer<typeof flowAgentSchema>;

/** An item as `flow.inbox.all` lists it: with its project and status named. */
export const flowInboxAllItemSchema = flowItemSchema.extend({
  projectName: z.string(),
  projectKey: z.string(),
  statusName: z.string(),
});
export type FlowInboxAllItem = z.infer<typeof flowInboxAllItemSchema>;

/** Across every org you are in: what waits on you and what agents are working on. */
export const flowInboxAllSchema = z.object({
  orgs: z.array(
    z.object({
      orgId: z.string(),
      name: z.string(),
      work: z.array(flowInboxAllItemSchema),
      decisions: z.array(flowInboxAllItemSchema),
      working: z.array(flowInboxAllItemSchema),
    }),
  ),
});
export type FlowInboxAll = z.infer<typeof flowInboxAllSchema>;

/** One run of an agent (`flow.run.list` by agent or by item): on an item, or answering a chat. */
export const flowRunSchema = z.object({
  id: z.string().optional(),
  itemId: z.string().nullable(),
  itemTitle: z.string().nullable().optional(),
  /** A chat's run: its chat and the chat's title (the item fields null). */
  chatId: z.string().nullable().optional(),
  chatTitle: z.string().nullable().optional(),
  agentId: z.string().optional(),
  status: z.string(),
  createdAt: z.string().optional(),
  claimedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  result: z.unknown().optional(),
  error: z.string().nullable(),
  /** Tool calls stored (an older server leaves it out). */
  steps: z.number().optional(),
  /** Null when unknown: no runner reports cost today. */
  costUsd: z.number().nullable().optional(),
  tokens: z.number().nullable().optional(),
});
export type FlowRun = z.infer<typeof flowRunSchema>;

export const flowWorkflowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workflow: z.object({ id: z.string(), name: z.string(), statuses: z.array(flowStatusSchema) }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowWorkflow = z.infer<typeof flowWorkflowSchema>;

export const flowBoardSchema = z.object({
  columns: z.array(z.object({ status: flowStatusSchema, items: z.array(flowItemSchema) })),
  truncated: z.boolean(),
  /** The plugin fields its items may carry. */
  declaredFields: z.array(flowFieldSchema).optional(),
});
export type FlowBoard = z.infer<typeof flowBoardSchema>;

/**
 * A rich card an agent or a plugin adds to the timeline (an entry of kind `card`): one shape for a
 * pull request, a plan, a chart or a document.
 */
export const flowCardSchema = z.object({
  kind: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  rows: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  checks: z.array(z.object({ label: z.string(), ok: z.boolean() })).optional(),
  bars: z.array(z.object({ label: z.string(), value: z.number(), max: z.number() })).optional(),
  link: z.object({ label: z.string(), url: z.string() }).optional(),
});
export type FlowCard = z.infer<typeof flowCardSchema>;

export const flowTimelineEntrySchema = z.object({
  seq: z.number(),
  /** `card` is sent by plugins and agents; the kernel writes the other three. */
  kind: z.enum(["event", "effect", "comment", "card"]),
  actor: flowActorSchema,
  data: z.unknown(),
  createdAt: z.string(),
});
export type FlowTimelineEntry = z.infer<typeof flowTimelineEntrySchema>;

export const flowTimelineSchema = z.object({
  entries: z.array(flowTimelineEntrySchema),
  truncated: z.boolean(),
});
export type FlowTimeline = z.infer<typeof flowTimelineSchema>;

export const flowInboxSchema = z.object({
  work: z.array(flowItemSchema),
  decisions: z.array(flowItemSchema),
  /** The last 30 items you finished or decided, newest first (an older server leaves it out). */
  done: z.array(flowInboxAllItemSchema.extend({ doneAt: z.string() })).optional(),
  truncated: z.boolean(),
});
export type FlowInbox = z.infer<typeof flowInboxSchema>;

/** `flow.item.get`: the item, and the fields the org's plugins declare. */
export const flowItemDetailSchema = flowItemSchema.extend({
  declaredFields: z.array(flowFieldSchema).optional(),
});
export type FlowItemDetail = z.infer<typeof flowItemDetailSchema>;

type Org = { orgId: string };

/** The `flow.*` operations the desktop calls, for packages/client's OpMap. */
export interface FlowOpMap extends FlowEditOpMap, FlowAutoOpMap, FlowChatOpMap {
  "flow.project.list": { input: Org; output: { projects: FlowProject[] } };
  "flow.project.create": {
    input: Org & { name: string; key: string; workflowId: string };
    output: FlowProject;
  };
  "flow.project.get": { input: Org & { projectId: string }; output: FlowProject };
  "flow.project.setRepository": {
    input:
      | (Org & { projectId: string; owner: string; name: string })
      | (Org & { projectId: string; clear: true });
    output: FlowProject;
  };
  "flow.github.repos": { input: Org; output: FlowGithubRepos };
  "flow.workflow.list": { input: Org; output: { workflows: FlowWorkflow[] } };
  "flow.workflow.get": { input: Org & { workflowId: string }; output: FlowWorkflow };
  "flow.agent.list": { input: Org; output: { agents: FlowAgent[] } };
  "flow.agent.create": {
    input: Org & { name: string; instructions: string; mcp?: string[] };
    output: FlowAgent;
  };
  "flow.agent.update": {
    input: Org & { agentId: string; name: string; instructions: string; mcp?: string[] };
    output: FlowAgent;
  };
  "flow.inbox.all": { input: Record<string, never>; output: FlowInboxAll };
  "flow.run.list": {
    input: Org & { agentId?: string; itemId?: string; limit?: number };
    output: { runs: FlowRun[] };
  };
  "flow.run.get": { input: Org & { runId: string }; output: { run: FlowRunView } };
  "flow.run.events": {
    input: Org & { runId: string; after?: number };
    output: FlowRunEvents;
  };
  "flow.board.get": { input: Org & { projectId: string }; output: FlowBoard };
  "flow.timeline.get": { input: Org & { itemId: string }; output: FlowTimeline };
  "flow.inbox.get": { input: Org; output: FlowInbox };
  "flow.item.get": {
    input: Org & { itemId: string };
    output: FlowItemDetail;
  };
  "flow.item.create": {
    input: Org & { projectId: string; title: string; body?: string };
    output: FlowItem;
  };
  "flow.item.finish": {
    input: Org & { itemId: string; outcome: "done" | "rejected" };
    output: FlowItem;
  };
  "flow.item.decide": {
    input: Org & { itemId: string; decision: "approve" | "reject" };
    output: FlowItem;
  };
  "flow.item.retry": { input: Org & { itemId: string }; output: FlowItem };
  "flow.item.comment": { input: Org & { itemId: string; text: string }; output: { ok: boolean } };
}

/** "FP-12": the project's key and the item's number. */
export function flowKey(project: Pick<FlowProject, "key"> | undefined, number: number): string {
  return project ? `${project.key}-${number}` : `#${number}`;
}

/** Who the app can name: the signed-in person, the org's agents and (once read) its members. */
export interface Names {
  me: { id: string; name: string };
  agents: Pick<FlowAgent, "id" | "name">[];
  members?: Pick<FlowMember, "userId" | "name">[];
}

/**
 * A person's name: the signed-in person's own, else the org's member list's (`flow.member.list`),
 * else "A teammate" (a server without that operation yet, or someone who has left).
 */
export function personName(names: Names, userId: string): string {
  if (userId === names.me.id) return names.me.name;
  return names.members?.find((m) => m.userId === userId)?.name ?? "A teammate";
}

/** Whether an agent has the Plugin editor: its `mcp` has `factory`. A missing field is off. */
export const hasPluginEditor = (agent: Pick<FlowAgent, "mcp">) =>
  agent.mcp?.includes("factory") ?? false;

/**
 * What `flow.agent.update` is sent for one change: it takes the whole agent, so its name and saved
 * instructions go with it, and its `mcp` (missing reads as none). The Plugin editor is `factory`.
 */
export function agentUpdate(
  orgId: string,
  agent: Pick<FlowAgent, "id" | "name" | "instructions" | "mcp">,
  change: { instructions?: string; pluginEditor?: boolean },
): FlowOpMap["flow.agent.update"]["input"] {
  const mcp =
    change.pluginEditor === undefined
      ? (agent.mcp ?? [])
      : change.pluginEditor
        ? ["factory"]
        : (agent.mcp ?? []).filter((m) => m !== "factory");
  return {
    orgId,
    agentId: agent.id,
    name: agent.name,
    instructions: change.instructions ?? agent.instructions,
    mcp,
  };
}

export function agentName(names: Names, agentId: string): string {
  return names.agents.find((a) => a.id === agentId)?.name ?? "An agent";
}

export function actorName(names: Names, actor: FlowActor): string {
  if (actor.kind === "agent") return agentName(names, actor.id);
  if (actor.kind === "person") return personName(names, actor.id);
  // A plugin's card or field: the plugin by its name.
  if (actor.kind === "plugin") return actor.id;
  return "The workflow";
}

/** A status's owner, as the column and the card show it. */
export function ownerOf(
  names: Names,
  owner: FlowOwner,
): { name: string; kind: "agent" | "person" | "none" } {
  if (owner.kind === "agent") return { name: agentName(names, owner.agentId), kind: "agent" };
  if (owner.kind === "person") return { name: personName(names, owner.userId), kind: "person" };
  return { name: "Nobody", kind: "none" };
}

/** What a card shows beside its key: Working, Needs you, Stopped, or nothing. */
export type Chip = "working" | "needs-you" | "stopped" | null;

export function chipOf(item: FlowItem, meId: string): Chip {
  if (item.error) return "stopped";
  if (item.waiting.on === "run") return "working";
  if (item.waiting.on === "decision") return "needs-you";
  if (item.waiting.on === "person" && item.waiting.userId === meId) return "needs-you";
  return null;
}

/** Where `done` and `rejected` take an item from a status: its own setting, else the next or previous. */
export function nextStatuses(
  statuses: FlowStatus[],
  statusId: string,
): { done: FlowStatus | null; rejected: FlowStatus | null } {
  const at = statuses.findIndex((s) => s.id === statusId);
  const here = statuses[at];
  if (!here) return { done: null, rejected: null };
  const find = (id: string | undefined, fallback: number) =>
    (id ? statuses.find((s) => s.id === id) : statuses[fallback]) ?? null;
  return { done: find(here.onDone, at + 1), rejected: find(here.onReject, at - 1) };
}

/** The decision an item waits on from the signed-in person: the card at the end of its timeline. */
export interface Decision {
  kind: "work" | "decision";
  question: string;
  detail: string;
  /** The primary button first. */
  actions: {
    label: string;
    op: "flow.item.finish" | "flow.item.decide";
    input: { outcome: "done" | "rejected" } | { decision: "approve" | "reject" };
  }[];
}

export function decisionFor(item: FlowItem, statuses: FlowStatus[], meId: string): Decision | null {
  if (item.error) return null;
  const status = statuses.find((s) => s.id === item.statusId);
  const name = status?.name ?? "this status";
  const { done, rejected } = nextStatuses(statuses, item.statusId);
  const where = (to: FlowStatus | null, verb: string) =>
    to ? `${verb} moves it to ${to.name}` : null;
  if (item.waiting.on === "person" && item.waiting.userId === meId) {
    return {
      kind: "work",
      question: `${name} is yours`,
      detail: sentence([where(done, "Done"), where(rejected, "Send back")]),
      actions: [
        { label: "Done", op: "flow.item.finish", input: { outcome: "done" } },
        { label: "Send back", op: "flow.item.finish", input: { outcome: "rejected" } },
      ],
    };
  }
  if (item.waiting.on === "decision") {
    return {
      kind: "decision",
      question: `Approve ${name}?`,
      detail: sentence([where(done, "Approve"), where(rejected, "Reject")]),
      actions: [
        { label: "Approve", op: "flow.item.decide", input: { decision: "approve" } },
        { label: "Reject", op: "flow.item.decide", input: { decision: "reject" } },
      ],
    };
  }
  return null;
}

function sentence(parts: (string | null)[]): string {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length ? `${kept.join("; ")}.` : "";
}

// ---- The timeline -------------------------------------------------------------------------------

/** One thing the timeline shows. */
export type TimelineRow =
  | {
      type: "line";
      seq: number;
      /** Who did it, then what: "Writer" + "moved it from Draft to Review". */
      who: string;
      what: string;
      /** What the move did next: "Handed to Editor, who started a run", "Waiting on Tim". */
      after: string | null;
      tone: "quiet" | "bad";
      at: string;
    }
  | {
      type: "entry";
      seq: number;
      who: string;
      by: FlowActor["kind"];
      text: string | null;
      cards: FlowCard[];
      at: string;
      /** The run an agent's summary comment reports on: its run line opens it. */
      runId: string | null;
    };

type Event =
  | { type: "created"; statusId?: string }
  | { type: "run.ended"; stay: number; outcome: "done" | "rejected" }
  | { type: "run.failed"; stay: number; error: string }
  | { type: "person.finished"; outcome: "done" | "rejected" }
  | { type: "decided"; decision: "approve" | "reject" }
  | { type: "moved"; to: string }
  | { type: "retried" };

type Effect =
  | { type: "run.start"; agentId: string; statusId: string }
  | { type: "run.cancel" }
  | { type: "inbox.add"; userId: string; statusId: string }
  | { type: "decision.ask"; statusId: string }
  | { type: "entered"; from: string | null; to: string; by: FlowActor }
  | { type: "stopped"; statusId: string; error: string };

const typed = <T>(data: unknown): T | null =>
  data && typeof data === "object" && typeof (data as { type?: unknown }).type === "string"
    ? (data as T)
    : null;

/** The run an agent's comment reports on (its `runId`), else null. */
function runIdOf(entry: FlowTimelineEntry): string | null {
  if (entry.actor.kind !== "agent") return null;
  const runId = (entry.data as { runId?: unknown } | null)?.runId;
  return typeof runId === "string" && runId ? runId : null;
}

/** A card entry's data, if it has the card's shape. */
export function asCard(data: unknown): FlowCard | null {
  if (!data || typeof data !== "object") return null;
  const c = data as Partial<FlowCard>;
  return typeof c.title === "string" ? ({ kind: "card", ...c } as FlowCard) : null;
}

/**
 * The item's timeline as a person reads it. The kernel writes an event and then each of its effects
 * (an `entered`, a `run.start`, an `inbox.add`): together they are one move, told as one line with
 * what happened next beneath it. Comments are entries; an agent's comment after its run is its
 * summary, shown before the move it caused. A `card` entry joins its author's entry just before it,
 * or stands as its own entry.
 */
export function buildTimeline(
  entries: FlowTimelineEntry[],
  statuses: FlowStatus[],
  names: Names,
): TimelineRow[] {
  const statusName = (id: string) => statuses.find((s) => s.id === id)?.name ?? id;
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i] as FlowTimelineEntry;
    if (entry.kind === "comment") {
      const text = (entry.data as { text?: unknown } | null)?.text;
      rows.push({
        type: "entry",
        seq: entry.seq,
        who: actorName(names, entry.actor),
        by: entry.actor.kind,
        text: typeof text === "string" ? text : "",
        cards: [],
        at: entry.createdAt,
        runId: runIdOf(entry),
      });
      i++;
      continue;
    }
    if (entry.kind === "card") {
      const card = asCard(entry.data);
      const last = rows.at(-1);
      const who = actorName(names, entry.actor);
      if (card && last?.type === "entry" && last.who === who) last.cards.push(card);
      else if (card)
        rows.push({
          type: "entry",
          seq: entry.seq,
          who,
          by: entry.actor.kind,
          text: null,
          cards: [card],
          at: entry.createdAt,
          runId: null,
        });
      i++;
      continue;
    }
    // An event and the effects written after it; an effect on its own is told the same way.
    const event = entry.kind === "event" ? typed<Event>(entry.data) : null;
    const effects: Effect[] = [];
    let j = entry.kind === "event" ? i + 1 : i;
    while (j < entries.length && entries[j]?.kind === "effect") {
      const e = typed<Effect>(entries[j]?.data);
      if (e) effects.push(e);
      j++;
    }
    // An agent's summary of the run that caused this move comes first, as it does in the mockup.
    const summary = entries[j];
    const before: TimelineRow[] = [];
    if (
      event?.type === "run.ended" &&
      summary?.kind === "comment" &&
      summary.actor.kind === "agent"
    ) {
      const text = (summary.data as { text?: unknown } | null)?.text;
      const cards: FlowCard[] = [];
      j++;
      // The cards the agent added with its summary go in the same entry.
      const author = summary.actor.id;
      for (let next = entries[j]; next?.kind === "card"; next = entries[j]) {
        if (next.actor.kind !== "agent" || next.actor.id !== author) break;
        const card = asCard(next.data);
        if (card) cards.push(card);
        j++;
      }
      before.push({
        type: "entry",
        seq: summary.seq,
        who: actorName(names, summary.actor),
        by: "agent",
        text: typeof text === "string" ? text : "",
        cards,
        at: summary.createdAt,
        runId: runIdOf(summary),
      });
    }
    rows.push(...before);
    const line = moveLine(event, effects, entry.actor, names, statusName);
    if (line) rows.push({ type: "line", seq: entry.seq, at: entry.createdAt, ...line });
    i = Math.max(j, i + 1);
  }
  return rows;
}

function moveLine(
  event: Event | null,
  effects: Effect[],
  actor: FlowActor,
  names: Names,
  statusName: (id: string) => string,
): { who: string; what: string; after: string | null; tone: "quiet" | "bad" } | null {
  const entered = effects.find(
    (e): e is Extract<Effect, { type: "entered" }> => e.type === "entered",
  );
  const stopped = effects.find(
    (e): e is Extract<Effect, { type: "stopped" }> => e.type === "stopped",
  );
  const who = actorName(names, entered?.by ?? actor);
  const after = handedTo(effects, names);
  if (stopped) {
    const runner = event?.type === "run.failed" ? actorName(names, actor) : who;
    return {
      who: runner,
      what: `couldn't finish ${statusName(stopped.statusId)}`,
      after: "Stopped until someone retries it",
      tone: "bad",
    };
  }
  const back =
    (event?.type === "run.ended" && event.outcome === "rejected") ||
    (event?.type === "person.finished" && event.outcome === "rejected") ||
    (event?.type === "decided" && event.decision === "reject");
  if (entered) {
    // The kernel creates as the workflow; the timeline row carries the person who created it.
    if (entered.from === null)
      return { who: actorName(names, actor), what: "created this item", after, tone: "quiet" };
    const route = `from ${statusName(entered.from)} to ${statusName(entered.to)}`;
    const approved = event?.type === "decided" && event.decision === "approve";
    const verb = approved ? "approved it" : back ? "sent it back" : "moved it";
    return { who, what: `${verb} ${route}`, after, tone: "quiet" };
  }
  if (event?.type === "retried") return { who, what: "retried it", after, tone: "quiet" };
  if (event?.type === "run.ended" || event?.type === "person.finished")
    return { who, what: back ? "sent it back" : "finished", after, tone: "quiet" };
  if (event?.type === "decided")
    return {
      who,
      what: event.decision === "approve" ? "approved it" : "rejected it",
      after,
      tone: "quiet",
    };
  if (after) return { who, what: "handed it on", after, tone: "quiet" };
  return null;
}

/** What a move did next, in one phrase. */
function handedTo(effects: Effect[], names: Names): string | null {
  for (const e of effects) {
    if (e.type === "run.start")
      return `Handed to ${agentName(names, e.agentId)}, who started a run`;
    if (e.type === "inbox.add")
      return `Waiting on ${e.userId === names.me.id ? "you" : personName(names, e.userId)}`;
    if (e.type === "decision.ask") return "Waiting on a decision";
  }
  return null;
}

/** "3h ago", "just now". */
export const when = (iso: string, now = Date.now()) => ago(iso, now);
