// The impact summary of a config change (ADR 0370): what a new version loosens, tightens or leaves
// alone, computed on the server so a person (and the gate) can trust it. Anything more permissive,
// and any change this file can't classify, is `loosens`: unknown fails closed.
import { HARNESS_PERMISSION_MODES, JOB_STAGES } from "@software-factory/runner-contract";
import { ACTOR_TYPES } from "../actors.ts";
import { decide, type FloorParse, RISK_CLASSES } from "./gate.ts";
import type { ProjectPolicy } from "./project-policy.ts";

export type ImpactClass = "loosens" | "tightens" | "neutral";

export interface ImpactChange {
  /** The setting, as a dotted path (`autonomyPolicy`, `gate.agent.spend`, `approvers`, …). */
  path: string;
  class: ImpactClass;
  /** One plain sentence for the person reading the save bar or the review card. */
  summary: string;
}

export interface PolicyImpact {
  /** The strongest class among the changes: loosens > tightens > neutral. */
  class: ImpactClass;
  changes: ImpactChange[];
}

const RANK = { allow: 0, review: 1, deny: 2 } as const;
const SIZES = ["small", "medium", "large"] as const;
/** Higher is more permissive. */
const MODE_RANK: Record<string, number> = Object.fromEntries(
  HARNESS_PERMISSION_MODES.map((m) => [
    m,
    m === "bypassPermissions" ? 2 : m === "acceptEdits" ? 1 : 0,
  ]),
);

/** Settings this file knows how to classify; any other changed key is `loosens`. */
const KNOWN = new Set([
  "version",
  "autonomyPolicy",
  "overrides",
  "spec",
  "timeouts",
  "wipLimit",
  "retryLimit",
  "approvers",
  "backupOwner",
  "modelRoles",
  "requires",
  "harness",
  "protection",
  "reviewPacket",
]);

/**
 * What changing `before` into `after` does. `before` null means there was no valid config (a first
 * version): nothing can loosen what denied everything, so every change is neutral.
 */
export function policyImpact(
  before: ProjectPolicy | null,
  after: ProjectPolicy,
  floor: FloorParse,
): PolicyImpact {
  if (!before) {
    return {
      class: "neutral",
      changes: [{ path: "*", class: "neutral", summary: "First valid config for this project." }],
    };
  }
  const changes: ImpactChange[] = [];
  const add = (path: string, cls: ImpactClass, summary: string) =>
    changes.push({ path, class: cls, summary });

  // The gate: every non-human actor × risk class, old against new, with the real floor.
  if (before.autonomyPolicy !== after.autonomyPolicy || !same(before.overrides, after.overrides)) {
    if (before.autonomyPolicy !== after.autonomyPolicy) {
      add(
        "autonomyPolicy",
        "neutral",
        `Autonomy policy ${title(before.autonomyPolicy)} → ${title(after.autonomyPolicy)}.`,
      );
    }
    for (const actor of ACTOR_TYPES) {
      if (actor === "human") continue;
      for (const risk of RISK_CLASSES) {
        const was = decide({ actor, risk, policy: before, floor }).decision;
        const now = decide({ actor, risk, policy: after, floor }).decision;
        if (was === now) continue;
        const cls = RANK[now] < RANK[was] ? "loosens" : "tightens";
        add(`gate.${actor}.${risk}`, cls, `${actor} ${risk}: ${was} → ${now}.`);
      }
    }
  }

  // People.
  const wasApprovers = new Set(before.approvers.map((a) => a.toLowerCase()));
  const nowApprovers = new Set(after.approvers.map((a) => a.toLowerCase()));
  if (wasApprovers.size === 0 && nowApprovers.size > 0) {
    // Empty means the org's owners and admins; naming people instead may narrow or widen it.
    add("approvers", "loosens", `Approvers: org owners and admins → ${list(after.approvers)}.`);
  } else if (nowApprovers.size === 0 && wasApprovers.size > 0) {
    add("approvers", "loosens", `Approvers: ${list(before.approvers)} → org owners and admins.`);
  } else {
    const added = after.approvers.filter((a) => !wasApprovers.has(a.toLowerCase()));
    const removed = before.approvers.filter((a) => !nowApprovers.has(a.toLowerCase()));
    if (added.length)
      add("approvers", "loosens", `Adds approver ${list(added)}: more people can open gates.`);
    if (removed.length) add("approvers", "tightens", `Removes approver ${list(removed)}.`);
  }
  if ((before.backupOwner ?? null) !== (after.backupOwner ?? null)) {
    add(
      "backupOwner",
      "neutral",
      `Backup owner: ${before.backupOwner ?? "the first approver"} → ${after.backupOwner ?? "the first approver"}.`,
    );
  }

  // Gates and limits.
  const wasSpec = SIZES.indexOf(before.spec.requiredFrom);
  const nowSpec = SIZES.indexOf(after.spec.requiredFrom);
  if (wasSpec !== nowSpec) {
    add(
      "spec.requiredFrom",
      nowSpec > wasSpec ? "loosens" : "tightens",
      `Spec required from ${before.spec.requiredFrom} → ${after.spec.requiredFrom}${nowSpec > wasSpec ? ": fewer items get a spec gate" : ""}.`,
    );
  }
  for (const key of ["gateHours", "questionHours"] as const) {
    if (before.timeouts[key] !== after.timeouts[key]) {
      add(
        `timeouts.${key}`,
        "neutral",
        `${key === "gateHours" ? "Gate" : "Question"} timeout ${before.timeouts[key]}h → ${after.timeouts[key]}h.`,
      );
    }
  }
  if (before.wipLimit !== after.wipLimit) {
    add("wipLimit", "neutral", `WIP limit ${before.wipLimit} → ${after.wipLimit}.`);
  }
  if (before.retryLimit !== after.retryLimit) {
    add("retryLimit", "neutral", `Retry limit ${before.retryLimit} → ${after.retryLimit}.`);
  }

  // Protection.
  if (before.protection.onRed !== after.protection.onRed) {
    add(
      "protection.onRed",
      after.protection.onRed === "warn" ? "loosens" : "tightens",
      `When main's protection is red: ${before.protection.onRed} → ${after.protection.onRed}.`,
    );
  }
  const wasChecks = new Set(before.protection.requiredChecks);
  const nowChecks = new Set(after.protection.requiredChecks);
  const droppedChecks = [...wasChecks].filter((c) => !nowChecks.has(c));
  const addedChecks = [...nowChecks].filter((c) => !wasChecks.has(c));
  if (droppedChecks.length)
    add("protection.requiredChecks", "loosens", `No longer requires ${list(droppedChecks)}.`);
  if (addedChecks.length)
    add("protection.requiredChecks", "tightens", `Also requires ${list(addedChecks)}.`);

  // Review packet: hiding a section hides evidence from the approver.
  const wasSections = before.reviewPacket?.sections ?? null;
  const nowSections = after.reviewPacket?.sections ?? null;
  if (!same(wasSections, nowSections)) {
    const shown = (s: string[] | null) => (s ? new Set(s.map(norm)) : null);
    const was = shown(wasSections);
    const now = shown(nowSections);
    const hidden =
      was === null
        ? now
          ? ["some sections"]
          : []
        : now === null
          ? []
          : [...was].filter((s) => !now.has(s));
    if (hidden.length)
      add("reviewPacket.sections", "loosens", `Hides ${list(hidden)} from the review packet.`);
    else add("reviewPacket.sections", "neutral", "Review packet sections reordered or added.");
  }

  // Models: a different reviewer can weaken the check that catches everything else.
  for (const role of new Set([
    ...Object.keys(before.modelRoles),
    ...Object.keys(after.modelRoles),
  ])) {
    const was = (before.modelRoles as Record<string, string | undefined>)[role];
    const now = (after.modelRoles as Record<string, string | undefined>)[role];
    if (was === now) continue;
    add(
      `modelRoles.${role}`,
      role === "review" ? "loosens" : "neutral",
      `${role} model: ${was ?? "default"} → ${now ?? "default"}.`,
    );
  }

  // Capabilities a stage requires: fewer requirements place jobs more widely.
  for (const stage of JOB_STAGES) {
    const was = new Set(before.requires[stage] ?? []);
    const now = new Set(after.requires[stage] ?? []);
    const dropped = [...was].filter((c) => !now.has(c));
    const added = [...now].filter((c) => !was.has(c));
    if (dropped.length)
      add(`requires.${stage}`, "loosens", `${stage} no longer requires ${list(dropped)}.`);
    if (added.length) add(`requires.${stage}`, "tightens", `${stage} now requires ${list(added)}.`);
  }

  // The harness: a wider mode, more allow rules or more hosts widen what an agent may do.
  harnessChanges(before.harness, after.harness, add);

  // Anything else that changed is something this file can't judge: fail closed.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (KNOWN.has(key)) continue;
    const b = (before as Record<string, unknown>)[key];
    const a = (after as Record<string, unknown>)[key];
    if (!same(b, a)) add(key, "loosens", `${key} changed (not classified: treated as loosening).`);
  }

  const cls: ImpactClass = changes.some((c) => c.class === "loosens")
    ? "loosens"
    : changes.some((c) => c.class === "tightens")
      ? "tightens"
      : "neutral";
  return { class: cls, changes };
}

type Harness = ProjectPolicy["harness"];

function harnessChanges(
  before: Harness,
  after: Harness,
  add: (path: string, cls: ImpactClass, summary: string) => void,
) {
  if (same(before ?? null, after ?? null)) return;
  for (const stage of JOB_STAGES) {
    const was = before?.permissionMode?.[stage];
    const now = after?.permissionMode?.[stage];
    if (was !== now) {
      // An unset mode is the stage's default, which is never wider than an explicit bypass.
      const wasRank = was === undefined ? -1 : (MODE_RANK[was] ?? 3);
      const nowRank = now === undefined ? -1 : (MODE_RANK[now] ?? 3);
      add(
        `harness.permissionMode.${stage}`,
        nowRank > wasRank ? "loosens" : "tightens",
        `${stage} permission mode: ${was ?? "default"} → ${now ?? "default"}.`,
      );
    }
    const wasAllow = new Set(before?.allow?.[stage] ?? []);
    const nowAllow = new Set(after?.allow?.[stage] ?? []);
    const added = [...nowAllow].filter((r) => !wasAllow.has(r));
    const removed = [...wasAllow].filter((r) => !nowAllow.has(r));
    if (added.length)
      add(`harness.allow.${stage}`, "loosens", `${stage} may also run ${list(added)}.`);
    if (removed.length)
      add(`harness.allow.${stage}`, "tightens", `${stage} may no longer run ${list(removed)}.`);
  }
  const wasHosts = new Set(before?.allowedDomains ?? []);
  const nowHosts = new Set(after?.allowedDomains ?? []);
  const addedHosts = [...nowHosts].filter((h) => !wasHosts.has(h));
  const removedHosts = [...wasHosts].filter((h) => !nowHosts.has(h));
  if (addedHosts.length)
    add("harness.allowedDomains", "loosens", `Agents may also reach ${list(addedHosts)}.`);
  if (removedHosts.length)
    add("harness.allowedDomains", "tightens", `Agents may no longer reach ${list(removedHosts)}.`);
}

function norm(section: string): string {
  return section.toLowerCase().replace(/[\s_]/g, "-");
}

function title(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function list(items: string[]): string {
  return items.join(", ");
}

/** Structural equality for JSON values (key order doesn't matter). */
export function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
