// Factory incidents (V1 improvement loop): every send-back or exhausted retry is a sign the
// factory's own config let something through. The incident gets a root-cause class, from which
// part of `.factory/` should change, and a proposed fix the incident's work item builds, always with
// a regression case under `evals/regressions/` that would have caught it.
//
// The class is a first guess from what the factory saw (the reason text and how it failed); the
// incident's own triage and build can refine it. It is deterministic so the journal and the
// metrics can group incidents.

export const ROOT_CAUSES = [
  /** CI or a runner check caught it late, or nothing caught it: add a check. */
  "missing-check",
  /** The criteria weren't met, or the reviewer rejected the work: the build prompt or a skill. */
  "prompt-or-skill",
  /** The agent lacked something it needed to know: project context. */
  "missing-context",
  /** Timeouts, retries or requirements in the policy didn't fit the work. */
  "policy",
  /** The run stalled or the runner failed it: placement, capabilities or the runner itself. */
  "runner",
  /** A push outside the run's own branch (ADR 0052). */
  "confinement",
  "unknown",
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

export type IncidentKind = "sent_back" | "run_failed" | "run_stalled" | "manual";

export interface IncidentClassification {
  rootCause: RootCause;
  /** Markdown: what to change in `.factory/` and the regression case to add. */
  proposedFix: string;
}

const has = (text: string, ...patterns: RegExp[]) => patterns.some((p) => p.test(text));

export function classifyIncident(input: {
  kind: IncidentKind;
  reason: string;
  incidentId: string;
}): IncidentClassification {
  const reason = input.reason;
  let rootCause: RootCause;
  if (has(reason, /outside (its|the run'?s?) (own )?branch|may only push|pushed .*factory\//i)) {
    rootCause = "confinement";
  } else if (
    input.kind === "run_stalled" ||
    // The live harness wasn't configured as the factory launched it (ADR 0270): the runner's launcher.
    has(reason, /stall|lease expired|no heartbeat|harness-config-mismatch/i)
  ) {
    rootCause = "runner";
  } else if (has(reason, /timed?[ _-]?out|timeout|retry limit|wip/i)) {
    rootCause = "policy";
  } else if (
    has(
      reason,
      /failing: |\bCI\b|lint|typecheck|type error|tests? (fail|broke|missing)|no tests?|regression|broke the build/i,
    )
  ) {
    rootCause = "missing-check";
  } else if (
    has(reason, /didn'?t know|unaware|context|convention|docs?\b|wrong (file|place|package)/i)
  ) {
    rootCause = "missing-context";
  } else if (
    has(reason, /unmet: |reviewer|request(ed)? changes|criteri|not what|scope|spec/i) ||
    input.kind === "sent_back"
  ) {
    rootCause = "prompt-or-skill";
  } else {
    rootCause = "unknown";
  }
  return { rootCause, proposedFix: proposedFix(rootCause, input.incidentId) };
}

/** Where the regression case for an incident goes. */
export const regressionPath = (incidentId: string) => `evals/regressions/${incidentId}.json`;

function proposedFix(rootCause: RootCause, incidentId: string): string {
  const target: Record<RootCause, string> = {
    "missing-check":
      "Add a check under `.factory/checks/` (a JSON rule: `appliesTo` globs plus `forbid`/`require` patterns) that fails on what slipped through.",
    "prompt-or-skill":
      "Tighten the build prompt or add a skill under `.factory/skills/` so the agent meets this kind of criterion; if a static rule can catch it, add a check under `.factory/checks/` too.",
    "missing-context":
      "Add the missing knowledge to `.factory/context/` (or the project's AGENTS.md) so the next run has it.",
    policy:
      "Propose a change to `.factory/policy.json` (timeouts, retry limit, required capabilities). Policy changes are self-modify: a person must merge them.",
    runner:
      "Check placement and capabilities (`requires` in `.factory/policy.json`) and the runner's health; add a check if the work itself caused the stall.",
    confinement:
      "Find how the run pushed outside its branch; tighten `.claude/settings.json` hooks or the ruleset. This needs a person.",
    unknown: "Find the root cause, then fix the part of `.factory/` it points to.",
  };
  return [
    `**Root cause (first guess):** ${rootCause}`,
    "",
    `**Fix:** ${target[rootCause]}`,
    "",
    `**Regression case:** add \`${regressionPath(incidentId)}\`: the input that slipped through, and the`,
    "check that must now fail on it (format: `evals/README.md`). CI runs it, so it passes on the PR's head.",
    "",
    "A fix that only **adds** files under `.factory/checks/` and `evals/regressions/` can merge on its own",
    "once CI and `factory/verify` are green, if the project opts in (ADR 0230). Anything else waits for a person.",
  ].join("\n");
}
