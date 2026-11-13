// How a change to an org's autopilots classifies (ADR 0514 §5 as amended, spec 52 § Autopilots).
// Judged by REACH, not by shape (review of #197): what an autopilot may do once it is on, compared
// field by field, so no sequence of practice saves reaches what one direct change would have been a
// loosening. One that is off reaches nothing: changing it is practice, and turning it on loosens
// (the person approving sees all it would reach). A new autopilot is judged against nothing:
// creating one that is on loosens; one created off is practice until it is turned on.
import type { ImpactChange } from "../policy/impact.ts";
import type { AutopilotConfig } from "./schema.ts";

type Projects = "all" | readonly string[];

/** What an autopilot reaches. */
interface Reach {
  on: boolean;
  releases: boolean;
  scope: Projects;
  /** Whose events fire it: none for a schedule (it fires on no project's events). */
  eventProjects: Projects;
  events: readonly string[];
  /** How often a schedule fires, in firings a week; an event trigger: unbounded. */
  perWeek: number;
  outputKind: string | null;
  outputProject: string | null;
  /** backlog < ready < queued: how close to running what it files is. */
  outputState: number;
  limits: { minutes: number; maxOutputs: number; runsPerDay: number };
  agent: string | null;
  requires: readonly string[];
  skills: readonly string[];
  instructions: string;
}

const NOTHING: Reach = {
  on: false,
  releases: false,
  scope: [],
  eventProjects: [],
  events: [],
  perWeek: 0,
  outputKind: null,
  outputProject: null,
  outputState: -1,
  limits: { minutes: 0, maxOutputs: 0, runsPerDay: 0 },
  agent: null,
  requires: [],
  skills: [],
  instructions: "",
};

const STATE_RANK: Record<string, number> = { backlog: 0, ready: 1, queued: 2 };

/** How many values a cron field takes (bounded by `lo`..`hi`). */
function fieldCount(field: string, lo: number, hi: number): number {
  if (field === "*") return hi - lo + 1;
  const seen = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return hi - lo + 1;
    const from = m[2] !== undefined ? Number(m[2]) : lo;
    const to = m[3] !== undefined ? Number(m[3]) : m[2] !== undefined && !m[4] ? from : hi;
    const step = m[4] ? Math.max(1, Number(m[4])) : 1;
    for (let v = from; v <= to; v += step) seen.add(v);
  }
  return Math.max(1, seen.size);
}

/** Firings a week of a five-field cron (one fixed minute): hours a day × days a week. */
export function cronPerWeek(cron: string): number {
  const f = cron.trim().split(/\s+/);
  const hours = fieldCount(f[1] ?? "*", 0, 23);
  const dom = f[2] ?? "*";
  const dow = f[4] ?? "*";
  const days =
    dow !== "*"
      ? Math.min(7, fieldCount(dow, 0, 6))
      : dom !== "*"
        ? Math.min(7, (fieldCount(dom, 1, 31) * 7) / 30)
        : 7;
  return hours * days;
}

function reachOf(a: AutopilotConfig): Reach {
  const event = a.trigger.kind === "event";
  return {
    on: a.enabled,
    releases: a.output.kind === "backlog" && a.output.state === "queued",
    scope: a.scope.projects,
    eventProjects: event ? (a.trigger.kind === "event" ? (a.trigger.projects ?? "all") : []) : [],
    events: a.trigger.kind === "event" ? [a.trigger.event] : [],
    perWeek: a.trigger.kind === "schedule" ? cronPerWeek(a.trigger.cron) : Number.POSITIVE_INFINITY,
    outputKind: a.output.kind,
    outputProject: a.output.kind === "backlog" ? a.output.project : null,
    outputState: a.output.kind === "backlog" ? (STATE_RANK[a.output.state] ?? 0) : -1,
    limits: a.limits,
    agent: a.agent.toLowerCase(),
    requires: a.requires,
    skills: a.skills,
    instructions: a.instructions,
  };
}

/** `after` reaches projects `before` didn't. */
function widens(before: Projects, after: Projects): boolean {
  if (before === "all") return false;
  if (after === "all") return true;
  return after.some((p) => !before.includes(p));
}
const adds = (before: readonly string[], after: readonly string[]) =>
  after.some((x) => !before.includes(x));

/** One autopilot's change, from what it reached to what it reaches. */
function compare(label: string, path: string, b: Reach, a: Reach): ImpactChange[] {
  const out: ImpactChange[] = [];
  const add = (key: string, cls: ImpactChange["class"], summary: string) =>
    out.push({ path: `${path}${key ? `.${key}` : ""}`, class: cls, summary });
  if (a.on !== b.on)
    add(
      "enabled",
      a.on ? "loosens" : "tightens",
      `${a.on ? "Turns on" : "Turns off"} the autopilot ${label}.`,
    );
  // One that ends off reaches nothing: what it would reach is judged when it is turned on (that
  // loosens, and the person approving it sees all of it).
  if (!a.on) {
    if (JSON.stringify(a) !== JSON.stringify(b))
      add("practice", "neutral", `The autopilot ${label} changed (off).`);
    return out;
  }
  if (a.releases !== b.releases)
    add(
      "output.state",
      a.releases ? "loosens" : "tightens",
      `${label} ${a.releases ? "now releases" : "no longer releases"} the work it files.`,
    );
  else if (a.outputState !== b.outputState)
    add(
      "output.state",
      a.outputState > b.outputState ? "loosens" : "tightens",
      `${label} files work ${a.outputState > b.outputState ? "closer to" : "further from"} running.`,
    );
  if (widens(b.scope, a.scope)) add("scope", "loosens", `${label} reaches more projects.`);
  else if (widens(a.scope, b.scope)) add("scope", "tightens", `${label} reaches fewer projects.`);
  if (widens(b.eventProjects, a.eventProjects))
    add("trigger.projects", "loosens", `${label} fires on more projects' events.`);
  else if (widens(a.eventProjects, b.eventProjects))
    add("trigger.projects", "tightens", `${label} fires on fewer projects' events.`);
  if (adds(b.events, a.events)) add("trigger.event", "loosens", `${label} fires on another event.`);
  else if (adds(a.events, b.events))
    add("trigger.event", "tightens", `${label} fires on fewer events.`);
  if (a.perWeek > b.perWeek) add("trigger", "loosens", `${label} fires more often.`);
  else if (a.perWeek < b.perWeek) add("trigger", "tightens", `${label} fires less often.`);
  if (a.outputKind !== b.outputKind && a.outputKind !== null)
    add("output", "loosens", `${label}'s output is now ${a.outputKind}.`);
  else if (a.outputProject !== b.outputProject && a.outputProject !== null)
    add("output.project", "loosens", `${label} files into ${a.outputProject}.`);
  for (const k of ["minutes", "maxOutputs", "runsPerDay"] as const)
    if (a.limits[k] !== b.limits[k])
      add(
        `limits.${k}`,
        a.limits[k] > b.limits[k] ? "loosens" : "tightens",
        `${label}'s ${k} limit ${b.limits[k]} → ${a.limits[k]}.`,
      );
  if (a.agent !== b.agent && a.agent !== null)
    add("agent", "loosens", `${label} hands to another agent (${a.agent}).`);
  if (adds(b.requires, a.requires))
    add("requires", "loosens", `${label} needs more capabilities (${a.requires.join(", ")}).`);
  else if (adds(a.requires, b.requires))
    add("requires", "tightens", `${label} needs fewer capabilities.`);
  if (adds(b.skills, a.skills)) add("skills", "loosens", `${label} follows more skills.`);
  else if (adds(a.skills, b.skills)) add("skills", "tightens", `${label} follows fewer skills.`);
  // A rewritten instruction for one that is on: what it does changes, so a person approves it.
  if (a.instructions !== b.instructions)
    add("instructions", a.on ? "loosens" : "neutral", `${label}'s instructions changed.`);
  return out;
}

export function autopilotImpact(
  before: readonly AutopilotConfig[],
  after: readonly AutopilotConfig[],
): ImpactChange[] {
  const out: ImpactChange[] = [];
  for (const a of after) {
    const b = before.find((x) => x.id === a.id);
    const path = `autopilots.${a.id}`;
    if (b && JSON.stringify(a) === JSON.stringify(b)) continue;
    const changes = compare(a.name, path, b ? reachOf(b) : NOTHING, reachOf(a));
    if (!b)
      changes.unshift({
        path,
        class: "neutral",
        summary: `Adds the autopilot ${a.name}${a.enabled ? "" : " (off)"}.`,
      });
    // Anything else (its name, description, the priority of what it files): recorded, practice.
    if (changes.length === 0)
      changes.push({
        path: `${path}.practice`,
        class: "neutral",
        summary: `The autopilot ${a.name} changed.`,
      });
    out.push(...changes);
  }
  for (const b of before)
    if (!after.some((a) => a.id === b.id))
      out.push({
        path: `autopilots.${b.id}`,
        class: b.enabled ? "tightens" : "neutral",
        summary: `Removes the autopilot ${b.name}.`,
      });
  return out;
}
