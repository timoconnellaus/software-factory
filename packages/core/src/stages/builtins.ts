// Workflows shipped in code (spec 52). Software is the template every project's workflow is today;
// Attached PR and Incident are built-in workflows chosen by an item's kind (Q10).
import type { WorkflowDefinition } from "./workflow.ts";

/** Today's fixed path (Workflow v7) as a stage list, with no slot steps. */
export const SOFTWARE: WorkflowDefinition = {
  schema: 1,
  id: "wf_software",
  name: "Software",
  description:
    "Triage, plan when the size needs it, build, check on the exact commit, merge through the queue.",
  stages: [
    // Triage and planning are shaping (Q1, ADR 0493); an item released straight from the backlog
    // runs them after release, on the light pool, as today.
    {
      id: "triage",
      type: "triage",
      typeVersion: 1,
      name: "Triage",
      phase: "shaping",
      settings: {},
    },
    {
      id: "spec",
      type: "interview-planning",
      typeVersion: 1,
      name: "Spec",
      phase: "shaping",
      settings: {},
    },
    { id: "build", type: "build", typeVersion: 1, name: "Build", phase: "delivery", settings: {} },
    {
      id: "verify",
      type: "checks",
      typeVersion: 1,
      name: "Verify",
      phase: "delivery",
      settings: {},
    },
    {
      id: "merge",
      type: "publish",
      typeVersion: 1,
      name: "Merge",
      phase: "delivery",
      settings: {},
    },
  ],
};

/**
 * An incident's fix (`item_kind = 'incident'`) takes the Software stages; it is opened running, never
 * shaped, so triage and planning run in delivery.
 */
export const INCIDENT: WorkflowDefinition = {
  schema: 1,
  id: "wf_incident",
  name: "Incident",
  description: "A factory incident's fix: the Software stages, started at once.",
  stages: SOFTWARE.stages.map((s) => ({ ...s, phase: "delivery" as const })),
};

/**
 * An outside PR (`runAttached`, spec 05): triage, then checks on the PR's own head (the factory
 * never pushes to its branch) and the merge gate, merged directly.
 */
export const ATTACHED_PR: WorkflowDefinition = {
  schema: 1,
  id: "wf_attached_pr",
  name: "Attached PR",
  description: "A pull request opened outside the factory: triage, check its own head, merge.",
  stages: [
    {
      id: "triage",
      type: "triage",
      typeVersion: 1,
      name: "Triage",
      phase: "delivery",
      settings: {},
    },
    {
      id: "verify",
      type: "checks",
      typeVersion: 1,
      name: "Verify",
      phase: "delivery",
      settings: {},
    },
    {
      id: "merge",
      type: "publish",
      typeVersion: 1,
      name: "Merge",
      phase: "delivery",
      settings: { via: "direct" },
    },
  ],
};

/** The workflow templates an org copies (Marketing comes with its stage types). */
export const WORKFLOW_TEMPLATES: readonly WorkflowDefinition[] = [SOFTWARE];

/** The built-in workflows, by the item kind that runs them. Visible, tighten-only (Q10). */
export const BUILT_IN_WORKFLOWS: Readonly<Record<"incident" | "attached", WorkflowDefinition>> = {
  incident: INCIDENT,
  attached: ATTACHED_PR,
};
