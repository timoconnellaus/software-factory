// What each Workflow version of a work item does (coordinator's rule, 2026-11-12): one row per
// version, the set of features it has. A row is immutable once merged: a running instance replays
// with the features of the version it started on, so changing a row would switch steps on (or off)
// inside instances already running. Code asks `has(version, "feature")`, never `version >= N`.
//
// A new version is the next number above main's highest at merge time, with its own row. The
// Workflow (apps/engine) and core (which jobs carry checks, what the verdict reads) share this table,
// so they always agree on what an item's version does.

export const WORKFLOW_FEATURES = [
  /** v2: the review packet decides, CI on the head, the PR opened at verify, incident auto-merge. */
  "verify-packet",
  /** v3: an unmergeable PR is its own state, and no CI at all asks a person (ADR 0320). */
  "conflicts",
  /** v4: approved merges land through the project's merge queue (ADR 0330). */
  "merge-queue",
  /** v5: the spec stage is a planning session (spec 20). */
  "planning-spec",
  /** v6: the project's workflow plan and its slots (ADR 0371). */
  "workflow-plan",
  /** v7: a shaped item waits for its release before delivery (spec 50 part C). */
  "release-wait",
  /** v8: the runner host runs the project's checks; their results decide (spec 51, ADR 0501). */
  "host-checks",
  /** v11: the babysitter lands the approved merge; the item waits for `delivered-<item>` (spec 53). */
  "babysitter-delivery",
] as const;
export type WorkflowFeature = (typeof WORKFLOW_FEATURES)[number];

const v1: readonly WorkflowFeature[] = [];
const v2 = [...v1, "verify-packet"] as const;
const v3 = [...v2, "conflicts"] as const;
const v4 = [...v3, "merge-queue"] as const;
const v5 = [...v4, "planning-spec"] as const;
const v6 = [...v5, "workflow-plan"] as const;
const v7 = [...v6, "release-wait"] as const;
const v8 = [...v7, "host-checks"] as const;
// v9–v10 are other builds' numbers (spec 53, **Workflow versions**); v11 has v8's host checks.
const v11 = [...v8, "babysitter-delivery"] as const;

/** Each version's features. Immutable once merged: add a row, never edit one. */
export const WORKFLOW_VERSION_FEATURES: Readonly<Record<number, ReadonlySet<WorkflowFeature>>> = {
  1: new Set(v1),
  2: new Set(v2),
  3: new Set(v3),
  4: new Set(v4),
  5: new Set(v5),
  6: new Set(v6),
  7: new Set(v7),
  8: new Set(v8),
  11: new Set(v11),
};

/** Whether an instance of Workflow `version` has `feature` (an unknown version has none). */
export function has(version: number | null | undefined, feature: WorkflowFeature): boolean {
  return WORKFLOW_VERSION_FEATURES[version ?? 0]?.has(feature) ?? false;
}
