// Stage prompts for the harness. Short on purpose: the harness adapter (harness-claude) projects the
// project's AGENTS.md / CLAUDE.md and the per-run settings; these say what this stage must produce.
// Each ends by naming the result file and its shape (runner-contract stage-results).
import { RESULT_FILE } from "@software-factory/runner-contract";

export interface ItemBrief {
  number: number;
  title: string;
  body: string;
  branch: string;
  /** The project's default branch. Missing in the cached meta of instances started before v3. */
  defaultBranch?: string;
}

const footer = (shape: string) =>
  [
    "",
    `When you are done, write your result as JSON to \`${RESULT_FILE}\` at the repository root (do not commit it):`,
    "```",
    shape,
    "```",
  ].join("\n");

export function triagePrompt(
  item: ItemBrief,
  workflows: { name: string; description: string }[] = [],
  /** Spec 23 (v9): score readiness too; the answers to an earlier round's questions, if any. */
  readiness?: { answers: { prompt: string; answer: string }[] },
): string {
  return [
    `You are triaging work item #${item.number} for the software factory. Read the repository (AGENTS.md, CONTEXT.md, docs/) but change nothing.`,
    "",
    `Title: ${item.title}`,
    "",
    item.body,
    "",
    "Size it: small (one clear change, no design choices), medium (a few files or one real decision), large (new behaviour across the system, or several decisions).",
    "Draft its acceptance criteria (checkable statements) and list the decision domains it touches (product, architecture, security, ...).",
    "You may ask to skip or require a spec (`specRequested`), but the autonomy policy decides.",
    ...(readiness
      ? [
          "",
          "Score readiness (`readiness`, with `readinessReason`): `ready` if it can be built as asked; `needs_answers` if a few questions would settle what's unclear (ask them in `questions`, at most five, each with options and a recommended default where you can); `not_actionable` if the requester must say what they want first (ask them in `questions`). Don't ask what the repository already answers.",
          ...(readiness.answers.length
            ? [
                "",
                "The requester already answered:",
                ...readiness.answers.map((a) => `- ${a.prompt}: ${a.answer}`),
              ]
            : []),
        ]
      : []),
    ...(workflows.length
      ? [
          "",
          "Pick the project workflow that fits this work best (`workflow`, by name) and say why (`workflowReason`). Omit `workflow` if none fits. The workflows:",
          ...workflows.map((w) => `- ${w.name}${w.description ? `: ${w.description}` : ""}`),
        ]
      : []),
    footer(
      readiness
        ? '{ "size": "small|medium|large", "reason": "...", "domains": ["..."], "acceptanceCriteria": ["..."], "specRequested": "skip|require (optional)", "readiness": "ready|needs_answers|not_actionable", "readinessReason": "...", "questions": [{ "prompt": "...", "options": ["..."], "defaultAnswer": "..." }], "workflow": "name (optional)", "workflowReason": "...", "summary": "..." }'
        : workflows.length
          ? '{ "size": "small|medium|large", "reason": "...", "domains": ["..."], "acceptanceCriteria": ["..."], "specRequested": "skip|require (optional)", "workflow": "name (optional)", "workflowReason": "...", "summary": "..." }'
          : '{ "size": "small|medium|large", "reason": "...", "domains": ["..."], "acceptanceCriteria": ["..."], "specRequested": "skip|require (optional)", "summary": "..." }',
    ),
  ].join("\n");
}

export function specPrompt(
  item: ItemBrief,
  input: {
    criteria: string[];
    note: string | null;
    answers: { prompt: string; answer: string }[];
    mayAsk: boolean;
  },
): string {
  return [
    `Write the spec for work item #${item.number} in the repository's stage-spec format (Goal / Scope / Out of scope / Acceptance criteria). Change no code.`,
    "",
    `Title: ${item.title}`,
    "",
    item.body,
    "",
    input.criteria.length
      ? `Draft acceptance criteria from triage:\n${input.criteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    input.note ? `\nThe approver asked for changes:\n${input.note}` : "",
    input.answers.length
      ? `\nAnswers to your questions:\n${input.answers.map((a) => `- ${a.prompt} → ${a.answer}`).join("\n")}`
      : "",
    "",
    input.mayAsk
      ? "Ask only questions a person must decide, each with a default and your recommendation. Record reversible choices as assumptions instead."
      : "Don't ask more questions: record anything still open as an assumption.",
    footer(
      '{ "specMd": "...", "acceptanceCriteria": ["..."], "assumptions": ["..."], "questions": [{ "prompt": "...", "domain": "product", "options": ["..."], "defaultAnswer": "...", "recommendation": "...", "blocking": true, "irreversible": false }] }',
    ),
  ].join("\n");
}

export function buildPrompt(
  item: ItemBrief,
  input: {
    criteria: string[];
    specPath: string | null;
    note: string | null;
    attempt: number;
    /** The build agent's standing instructions (ADR 0372), appended. */
    instructions?: string;
  },
): string {
  return [
    `Implement work item #${item.number}: ${item.title}`,
    "",
    item.body,
    "",
    input.specPath
      ? `The approved spec is ${input.specPath} on this branch. Build exactly what it says.`
      : "",
    `Acceptance criteria:\n${input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none recorded; infer them from the request)"}`,
    input.note ? `\nThis is attempt ${input.attempt}. Fix this first:\n${input.note}` : "",
    "",
    `Before you start, the runner merged the latest \`${item.defaultBranch ?? "main"}\` into this branch (ADR 0320). If \`git status\` shows a merge in progress, resolve every conflict first, keeping the intent of both sides, then \`git commit --no-edit\`. Never rebase, reset or force-push. A renumbered ADR or migration that collides with one on \`${item.defaultBranch ?? "main"}\` takes the next free number (docs/parallel-work.md, if the repo has it).`,
    "",
    "Commit your work on the current branch with focused commits. Run the project's lint, typecheck and tests before you finish. Don't change `.factory/` unless the work item is about it.",
    input.instructions ? `\nThe project's instructions for this build:\n${input.instructions}` : "",
    footer('{ "notes": "anything the reviewer should know (optional)" }'),
  ].join("\n");
}

export function verifyPrompt(
  item: ItemBrief,
  input: {
    criteria: string[];
    headSha: string;
    /**
     * The factory's own checks (ADR 0501), which the runner host runs itself. null: an instance
     * from before v7, whose reviewer still runs and reports the checks.
     */
    checks?: string[] | null;
  },
): string {
  const factoryChecks = input.checks !== undefined && input.checks !== null;
  return [
    `Review work item #${item.number} (${item.title}) at ${input.headSha} as an independent reviewer. Change nothing.`,
    "",
    factoryChecks
      ? [
          `The factory runs the project's checks itself on this commit${input.checks?.length ? `: ${input.checks.map((c) => `\`${c}\``).join(", ")}` : ""}, and CI runs on the pull request. Their results decide; you don't need to run or report them.`,
          "Check every acceptance criterion one by one: say whether it is met and why (a test name, a file and line). For each, list in `checks` the names of the checks that prove it: the factory's checks above or CI check names. A criterion is marked proven only when a check you link passed; your judgement alone is shown as opinion.",
        ].join("\n")
      : "Run the project's tests, lint and typecheck and report each as a check. Check every acceptance criterion one by one and give evidence (a test name, a file and line, a command's output).",
    `Acceptance criteria:\n${input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    "",
    "Then give your own verdict as the reviewer, with notes, and flag risks (security, data loss, a `.factory/` change).",
    footer(
      factoryChecks
        ? '{ "summary": "...", "criteria": [{ "criterion": "...", "met": true, "evidence": "...", "checks": ["tests"] }], "reviewer": { "role": "review", "verdict": "approve|request_changes", "notes": "..." }, "riskFlags": ["..."] }'
        : '{ "summary": "...", "checks": [{ "name": "tests", "status": "pass|fail|skipped", "detail": "..." }], "criteria": [{ "criterion": "...", "met": true, "evidence": "..." }], "reviewer": { "role": "review", "verdict": "approve|request_changes", "notes": "..." }, "riskFlags": ["..."] }',
    ),
  ].join("\n");
}

/**
 * Triage for an attached PR (spec 05): the work is already built, so triage reads the PR's diff
 * and drafts the acceptance criteria verify will check it against. The checkout is the PR's branch.
 */
export function attachedTriagePrompt(
  item: ItemBrief,
  input: { prNumber: number | null; headSha: string | null; defaultBranch: string },
): string {
  return [
    `You are triaging work item #${item.number} for the software factory: pull request ${input.prNumber ? `#${input.prNumber}` : ""} on branch \`${item.branch}\`${input.headSha ? ` at ${input.headSha}` : ""}, opened outside the factory and attached to it. The work is already done; the factory will verify it, not build it. Read the repository (AGENTS.md, CONTEXT.md, docs/) and the PR's diff against \`${input.defaultBranch}\` (\`git diff origin/${input.defaultBranch}...HEAD\`, or the merge base with the default branch), but change nothing.`,
    "",
    `PR title: ${item.title}`,
    "",
    item.body,
    "",
    "Size it as if it were new work: small (one clear change, no design choices), medium (a few files or one real decision), large (new behaviour across the system, or several decisions).",
    "Draft its acceptance criteria from the PR's title, body and diff: checkable statements of what the PR claims to do, which an independent reviewer will check. List the decision domains it touches (product, architecture, security, ...).",
    footer(
      '{ "size": "small|medium|large", "reason": "...", "domains": ["..."], "acceptanceCriteria": ["..."], "summary": "..." }',
    ),
  ].join("\n");
}

/**
 * A workflow's work step (ADR 0371): an advisory check on the branch, read-only. It passes, sends
 * the item back to build with notes, or asks a person. The project's instructions come from the
 * step and its agent; they never reach verify's or the reviewer's prompt.
 */
export function stepPrompt(
  item: ItemBrief,
  input: {
    workflow: string;
    step: string;
    slot: "afterSpec" | "beforeVerify" | "afterVerify";
    instructions: string;
    criteria: string[];
    headSha: string | null;
    specPath: string | null;
  },
): string {
  const where =
    input.slot === "afterSpec"
      ? "The spec is approved and nothing is built yet."
      : input.slot === "beforeVerify"
        ? `The build is done${input.headSha ? ` (at ${input.headSha})` : ""}; verify hasn't run yet.`
        : `Verify passed${input.headSha ? ` at ${input.headSha}` : ""}; a person reviews it next.`;
  return [
    `You are the "${input.step}" step of the "${input.workflow}" workflow, for work item #${item.number}: ${item.title}. ${where} Read the repository and the branch, but change nothing.`,
    "",
    item.body,
    "",
    input.specPath ? `The approved spec is ${input.specPath} on this branch.` : "",
    `Acceptance criteria:\n${input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none recorded)"}`,
    "",
    `Your instructions:\n${input.instructions || "(none: review what the step's name says)"}`,
    "",
    "Your verdict is advisory. `pass` lets the item go on. `sendBack` returns it to the builder: say exactly what to change in `notes`. `ask` puts up to 5 questions to a person first (`questions`, each with a prompt and options).",
    footer(
      '{ "verdict": "pass|sendBack|ask", "summary": "...", "notes": "what to change (for sendBack)", "questions": [{ "prompt": "...", "options": ["..."] }] }',
    ),
  ].join("\n");
}

/**
 * The spec critic (spec 23 part C): a second agent reads the plan going to the gate and the
 * repository, and writes notes for the person and the planner. It decides nothing.
 */
export function criticPrompt(
  item: ItemBrief,
  spec: { bodyMd: string; acceptanceCriteria: string[] },
): string {
  return [
    `You are the spec critic for work item #${item.number}. Read the plan below and the repository (AGENTS.md, CONTEXT.md, docs/, the code it touches) but change nothing.`,
    "",
    `Title: ${item.title}`,
    "",
    item.body,
    "",
    "The plan:",
    spec.bodyMd,
    "",
    "Its acceptance criteria:",
    ...spec.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    "Write notes a person deciding the spec gate should read: what's missing or unclear, criteria that can't be checked, contradictions with the code or the docs, risks, and questions nobody asked. Be specific (name the file or the line of the plan), and keep each note to a sentence or two. You can't approve or reject the spec, and nothing you write opens the gate: a person decides.",
    footer('{ "notes": ["..."], "summary": "..." }'),
  ].join("\n");
}
