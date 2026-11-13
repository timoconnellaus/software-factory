// How a change to an org's autopilots classifies (ADR 0514 §5, spec 52 § Autopilots). Adding or
// enabling one is practice (neutral), except where it releases work (`backlog` output with
// `state: "queued"`) or its reach widens (more projects, a different output, higher limits), which
// loosens: an org admin approves it. Disabling or removing one, or narrowing it, tightens. Judged
// whether or not it is enabled, so widening a disabled one and then enabling it can't slip through.
import type { ImpactChange } from "../policy/impact.ts";
import type { AutopilotConfig } from "./schema.ts";

const releases = (a: AutopilotConfig) => a.output.kind === "backlog" && a.output.state === "queued";

/** `after` reaches projects `before` didn't ("all" reaches every project). */
function widens(
  before: "all" | readonly string[] | undefined,
  after: "all" | readonly string[] | undefined,
): boolean {
  if (before === undefined || before === "all") return false;
  if (after === undefined || after === "all") return true;
  return after.some((p) => !before.includes(p));
}

export function autopilotImpact(
  before: readonly AutopilotConfig[],
  after: readonly AutopilotConfig[],
): ImpactChange[] {
  const out: ImpactChange[] = [];
  const add = (a: AutopilotConfig, key: string, cls: ImpactChange["class"], summary: string) =>
    out.push({ path: `autopilots.${a.id}${key ? `.${key}` : ""}`, class: cls, summary });
  for (const a of after) {
    const b = before.find((x) => x.id === a.id);
    if (!b) {
      if (a.enabled && releases(a))
        add(a, "", "loosens", `Adds the autopilot ${a.name}, on, releasing the work it files.`);
      else add(a, "", "neutral", `Adds the autopilot ${a.name}${a.enabled ? "" : " (off)"}.`);
      continue;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a.enabled !== b.enabled)
      add(
        a,
        "enabled",
        a.enabled ? (releases(a) ? "loosens" : "neutral") : "tightens",
        a.enabled
          ? `Turns on the autopilot ${a.name}${releases(a) ? ", which releases the work it files" : ""}.`
          : `Turns off the autopilot ${a.name}.`,
      );
    if (releases(a) && !releases(b))
      add(a, "output.state", "loosens", `${a.name} now releases the work it files.`);
    else if (releases(b) && !releases(a))
      add(a, "output.state", "tightens", `${a.name} no longer releases the work it files.`);
    if (widens(b.scope.projects, a.scope.projects))
      add(a, "scope", "loosens", `${a.name} reaches more projects.`);
    else if (widens(a.scope.projects, b.scope.projects))
      add(a, "scope", "tightens", `${a.name} reaches fewer projects.`);
    const evB = b.trigger.kind === "event" ? (b.trigger.projects ?? "all") : undefined;
    const evA = a.trigger.kind === "event" ? (a.trigger.projects ?? "all") : undefined;
    if (evB !== undefined && evA !== undefined && widens(evB, evA))
      add(a, "trigger.projects", "loosens", `${a.name} fires on more projects' events.`);
    if (a.output.kind !== b.output.kind)
      add(
        a,
        "output",
        "loosens",
        `${a.name}'s output changes from ${b.output.kind} to ${a.output.kind}.`,
      );
    else if (
      a.output.kind === "backlog" &&
      b.output.kind === "backlog" &&
      a.output.project !== b.output.project
    )
      add(a, "output.project", "loosens", `${a.name} files into ${a.output.project}.`);
    for (const k of ["minutes", "maxOutputs", "runsPerDay"] as const)
      if (a.limits[k] !== b.limits[k])
        add(
          a,
          `limits.${k}`,
          a.limits[k] > b.limits[k] ? "loosens" : "tightens",
          `${a.name}'s ${k} limit ${b.limits[k]} → ${a.limits[k]}.`,
        );
    if (
      a.agent !== b.agent ||
      a.instructions !== b.instructions ||
      JSON.stringify(a.trigger) !== JSON.stringify(b.trigger) ||
      a.name !== b.name ||
      a.description !== b.description ||
      JSON.stringify(a.requires) !== JSON.stringify(b.requires) ||
      JSON.stringify(a.skills) !== JSON.stringify(b.skills)
    )
      add(a, "practice", "neutral", `The autopilot ${a.name} changed.`);
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
