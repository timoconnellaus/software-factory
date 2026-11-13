// The `babysit` job's prompt (spec 53 §4, ADR 0583). The job is woken by the deliverer for one
// reason it can't decide in code; it judges that reason and, for a conflict, resolves it on its run
// branch. Everything it may do follows from its result, in code: it never merges, approves, pushes
// to the default branch, rebases or force-pushes, and it has no GitHub credentials of its own.
import { RESULT_FILE } from "@software-factory/runner-contract";

export type BabysitReasonKind = "conflict" | "check-failed";

export interface BabysitPromptInput {
  kind: BabysitReasonKind;
  item: { number: number; title: string; branch: string };
  defaultBranch: string;
  headSha: string;
  /** For `check-failed`: each failing check, with what it reported (output and annotations). */
  failing?: { name: string; url: string | null; detail: string }[];
  /** The repository's known flakes (`core_flakes`), newest first. */
  knownFlakes?: { check: string; test: string | null; seenAt: string }[];
}

const RESULT_SHAPE = `{
  "verdict": "flake" | "regression" | "resolved" | "person",
  "check": "<the failing check you judged>",          // check-failed only
  "test": "<the failing test, when the output names one>", // optional
  "note": "<what you saw and why, in a few sentences>"
}`;

/** The prompt for one `babysit` job. */
export function babysitPrompt(input: BabysitPromptInput): string {
  const head = input.headSha.slice(0, 7);
  const lines = [
    `You are the factory's babysitter for work item #${input.item.number}, "${input.item.title}".`,
    `A person (or the workflow's own approval) approved its merge. The babysitter delivers it to ${input.defaultBranch}; it met something code can't decide, and you decide it.`,
    "",
    "Rules that hold whatever you find:",
    `- Never push to ${input.defaultBranch}, never rebase, never force-push, never merge the pull request, never approve anything, never change settings, rulesets or factory config.`,
    "- You have no GitHub credentials. Everything you need is below or in the worktree.",
    `- When you are done, write your verdict as JSON to \`${RESULT_FILE}\` at the worktree root:`,
    RESULT_SHAPE,
    "",
  ];
  if (input.kind === "conflict") {
    lines.push(
      `What happened: ${input.item.branch} at ${head} conflicts with ${input.defaultBranch}. The runner merged ${input.defaultBranch} into your branch and left the conflicts in the worktree.`,
      "",
      "Resolve them:",
      "- Keep both sides' intent. Read each conflicted file's history on both sides before you choose.",
      "- A generated file (a lockfile, generated types, a snapshot): don't hand-merge it. Take either side, then run its generator and commit what it writes.",
      "- A migration-number clash (two migrations with the same number) or anything that changes behaviour beyond the merge: don't resolve it. Write verdict `person` and say why.",
      "- Commit the merge (a merge commit, not a rebase). The runner pushes your run branch; the factory then moves the item's branch to it, withdraws the approval and verifies the new head, and a person reviews only your resolution.",
      "",
      "When it is resolved and committed, write verdict `resolved` with a note saying what conflicted and how you resolved each file. If you can't, leave the merge unfinished and write `person`.",
    );
  } else {
    lines.push(
      `What happened: after the branch was brought up to date with ${input.defaultBranch}, a required check failed on ${head}. Is it a flake or a regression?`,
      "",
      "- A flake: infrastructure (a connection reset, a job cancelled at its time limit, out of memory, a provider API error), a check or test on the known-flake list below, or a test that fails without anything in this change or the merge touching it. The factory reruns the check once; if it passes it is recorded as a known flake.",
      "- A regression: the failure follows from the change or from merging it with the default branch. The item goes back to build with your note.",
      "- Unsure, or the output says too little: `person`.",
      "Don't change any files; read the worktree to see what the change touches.",
      "",
      "The failing checks:",
    );
    for (const f of input.failing ?? []) {
      lines.push(
        "",
        `### ${f.name}${f.url ? ` (${f.url})` : ""}`,
        "",
        f.detail.trim() ? fence(f.detail) : "(the check reported nothing about itself)",
      );
    }
    lines.push("", "Write one verdict for the first failing check, and name it in `check`.");
  }
  const flakes = input.knownFlakes ?? [];
  lines.push(
    "",
    "Known flakes in this repository:",
    ...(flakes.length
      ? flakes.map(
          (f) => `- ${f.check}${f.test ? ` / ${f.test}` : ""} (last seen ${f.seenAt.slice(0, 10)})`,
        )
      : ["- none recorded"]),
  );
  return lines.join("\n");
}

/** Untrusted text (a check's output) in a fence it can't close. */
function fence(text: string): string {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}text\n${text}\n${ticks}`;
}
