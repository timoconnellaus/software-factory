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

export function triagePrompt(item: ItemBrief): string {
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
    footer(
      '{ "size": "small|medium|large", "reason": "...", "domains": ["..."], "acceptanceCriteria": ["..."], "specRequested": "skip|require (optional)", "summary": "..." }',
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
  input: { criteria: string[]; specPath: string | null; note: string | null; attempt: number },
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
    footer('{ "notes": "anything the reviewer should know (optional)" }'),
  ].join("\n");
}

export function verifyPrompt(
  item: ItemBrief,
  input: { criteria: string[]; headSha: string },
): string {
  return [
    `Review work item #${item.number} (${item.title}) at ${input.headSha} as an independent reviewer. Change nothing.`,
    "",
    "Run the project's tests, lint and typecheck and report each as a check. Check every acceptance criterion one by one and give evidence (a test name, a file and line, a command's output).",
    `Acceptance criteria:\n${input.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    "",
    "Then give your own verdict as the reviewer, with notes, and flag risks (security, data loss, a `.factory/` change).",
    footer(
      '{ "summary": "...", "checks": [{ "name": "tests", "status": "pass|fail|skipped", "detail": "..." }], "criteria": [{ "criterion": "...", "met": true, "evidence": "..." }], "reviewer": { "role": "review", "verdict": "approve|request_changes", "notes": "..." }, "riskFlags": ["..."] }',
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
