// The new core's views (ADR 0660, spec 70) as the desktop app reads them: the `flow.*` operations'
// answers, typed by hand from @software-factory/store and @software-factory/flow (types only; a view
// imports neither), and the pure logic the board and the item panel need: an item's key, its chips,
// the decision it waits on, and its timeline told as one line per move.
import type { FlowAutoOpMap } from "./flow-auto.ts";
import type { FlowChatOpMap } from "./flow-chat.ts";
import type { FlowEditOpMap, FlowField, FlowMember } from "./flow-edit.ts";
import type { FlowRunEvents, FlowRunView } from "./flow-run.ts";
import { ago } from "./format.ts";

export type FlowOwner =
  | { kind: "agent"; agentId: string }
  | { kind: "person"; userId: string }
  | { kind: "none" };

export interface FlowStatus {
  id: string;
  name: string;
  owner: FlowOwner;
  brief?: string;
  onDone?: string;
  onReject?: string;
  needsDecision?: boolean;
}

export type FlowActor =
  | { kind: "person"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "system" };

export type FlowWaiting =
  | { on: "run"; agentId: string }
  | { on: "person"; userId: string }
  | { on: "decision" }
  | { on: "nothing" };

export interface FlowItem {
  id: string;
  orgId: string;
  projectId: string;
  number: number;
  title: string;
  body: string;
  statusId: string;
  waiting: FlowWaiting;
  error: string | null;
  stay: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Plugin fields' values, by field id, when the server sends them (flow-edit.ts `fieldChips`). */
  fields?: Record<string, unknown>;
}

export interface FlowProject {
  id: string;
  orgId: string;
  name: string;
  key: string;
  workflowId: string;
  nextNumber: number;
  /**
   * The GitHub repository its runs work in, or null. Optional: an engine before it sends none.
   */
  repo?: FlowRepo | null;
  /** Its items not yet in the workflow's last status (the server is adding it). */
  openCount?: number;
  createdAt: string;
}

/** A project's repository: where its runs check out and push the item's branch. */
export interface FlowRepo {
  owner: string;
  name: string;
  defaultBranch: string;
}

/** A repository the org's GitHub connection reaches (`flow.github.repos`). */
export interface FlowGithubRepo extends FlowRepo {
  installationId: string;
}

/** `flow.github.repos`: whether the org has a GitHub connection, and what it reaches. */
export interface FlowGithubRepos {
  connected: boolean;
  /** The GitHub account it is connected as, when connected. */
  account: string | null;
  repos: FlowGithubRepo[];
}

/** "acme/api". */
export const repoName = (repo: Pick<FlowRepo, "owner" | "name">) => `${repo.owner}/${repo.name}`;

export interface FlowAgent {
  id: string;
  orgId: string;
  name: string;
  instructions: string;
  /** The MCP servers it gets beyond the base ones: `["factory"]` is the Plugin editor. */
  mcp?: string[];
  createdAt: string;
}

/** An item as `flow.inbox.all` lists it: with its project and status named. */
export interface FlowInboxAllItem extends FlowItem {
  projectName: string;
  projectKey: string;
  statusName: string;
}

/** Across every org you are in: what waits on you and what agents are working on. */
export interface FlowInboxAll {
  orgs: {
    orgId: string;
    name: string;
    work: FlowInboxAllItem[];
    decisions: FlowInboxAllItem[];
    working: FlowInboxAllItem[];
  }[];
}

/** One run of an agent (`flow.run.list` by agent or by item): on an item, or answering a chat. */
export interface FlowRun {
  id?: string;
  itemId: string | null;
  itemTitle?: string | null;
  /** A chat's run: its chat and the chat's title (the item fields null). */
  chatId?: string | null;
  chatTitle?: string | null;
  agentId?: string;
  status: string;
  createdAt?: string;
  claimedAt: string | null;
  finishedAt: string | null;
  result?: unknown;
  error: string | null;
  /** Tool calls stored (an older server leaves it out). */
  steps?: number;
  /** Null when unknown: no runner reports cost today. */
  costUsd?: number | null;
  tokens?: number | null;
}

export interface FlowWorkflow {
  id: string;
  orgId: string;
  workflow: { id: string; name: string; statuses: FlowStatus[] };
  createdAt: string;
  updatedAt: string;
}

export interface FlowBoard {
  columns: { status: FlowStatus; items: FlowItem[] }[];
  truncated: boolean;
  /** The plugin fields its items may carry. */
  declaredFields?: FlowField[];
}

/**
 * A rich card an agent or a plugin adds to the timeline (an entry of kind `card`): one shape for a
 * pull request, a plan, a chart or a document.
 */
export interface FlowCard {
  kind: string;
  title: string;
  subtitle?: string;
  rows?: { label: string; value: string }[];
  checks?: { label: string; ok: boolean }[];
  bars?: { label: string; value: number; max: number }[];
  link?: { label: string; url: string };
}

export interface FlowTimelineEntry {
  seq: number;
  /** `card` is sent by plugins and agents (another change); the kernel writes the other three. */
  kind: "event" | "effect" | "comment" | "card";
  actor: FlowActor;
  data: unknown;
  createdAt: string;
}

export interface FlowTimeline {
  entries: FlowTimelineEntry[];
  truncated: boolean;
}

export interface FlowInbox {
  work: FlowItem[];
  decisions: FlowItem[];
  /** The last 30 items you finished or decided, newest first (an older server leaves it out). */
  done?: (FlowInboxAllItem & { doneAt: string })[];
  truncated: boolean;
}

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
    output: FlowItem & { declaredFields?: FlowField[] };
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

export function agentName(names: Names, agentId: string): string {
  return names.agents.find((a) => a.id === agentId)?.name ?? "An agent";
}

export function actorName(names: Names, actor: FlowActor): string {
  if (actor.kind === "agent") return agentName(names, actor.id);
  if (actor.kind === "person") return personName(names, actor.id);
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
      by: "person" | "agent" | "system";
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
