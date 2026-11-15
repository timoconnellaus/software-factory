// The prompt for a run in the new core (spec 70): who the agent is, what this status asks of it,
// the item, its recent comments, and the result file it must write (as workflow/prompts.ts does for
// the old stages). Nothing here names a status or a kind of work.
import { RESULT_FILE } from "@software-factory/runner-contract";
import type { ClaimedRun, TimelineEntry } from "@software-factory/store";

/** How many of the item's newest comments a prompt quotes. */
export const PROMPT_COMMENTS = 10;

function who(actor: TimelineEntry["actor"]): string {
  if (actor.kind === "person") return `person ${actor.id}`;
  if (actor.kind === "agent") return `agent ${actor.id}`;
  return "the system";
}

export function flowPrompt(run: ClaimedRun, comments: TimelineEntry[]): string {
  const agent = run.agent;
  const lines = [
    agent ? `You are ${agent.name}.` : "You are an agent working on an item.",
    ...(agent?.instructions.trim() ? ["", agent.instructions.trim()] : []),
    "",
    "## What this step asks of you",
    run.brief.trim() || "Do the work this item asks for.",
    "",
    `## The item: #${run.item.number} ${run.item.title}`,
    run.item.body.trim() || "(no description)",
  ];
  const said = comments
    .map((c) => ({ by: who(c.actor), text: (c.data as { text?: unknown }).text }))
    .filter((c): c is { by: string; text: string } => typeof c.text === "string");
  if (said.length) {
    lines.push("", "## Recent comments, oldest first");
    for (const c of said) lines.push(`- ${c.by}: ${c.text}`);
  }
  lines.push(
    "",
    `When you are done, write your result as JSON to \`${RESULT_FILE}\` in your working directory:`,
    "```",
    '{ "outcome": "done" | "rejected", "summary": "what you did, or why you did not, for a person to read" }',
    "```",
    'If the work cannot or should not be done, answer "rejected" and give the reason in the summary.',
  );
  return lines.join("\n");
}
