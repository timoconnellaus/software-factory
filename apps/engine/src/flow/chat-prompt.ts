// The prompt for a chat's run (migration 0433): the agent's instructions, what this app is and where
// its tools are, the conversation so far, the person's new message (the run's brief), and the
// result footer, whose summary is the agent's reply to the person.
import { RESULT_FILE } from "@software-factory/runner-contract";
import type { ChatMessage, ClaimedRun } from "@software-factory/store";

/** How many of a chat's newest messages a chat run's prompt reads. */
export const PROMPT_CHAT_MESSAGES = 100;
/** The most characters of conversation a chat run's prompt quotes; the oldest are dropped first. */
export const PROMPT_CHAT_CHARS = 24_000;

const SPEAKER = { person: "Person", agent: "You", did: "You did" } as const;

/**
 * The conversation as quoted lines, oldest first, within `cap` characters: whole messages, the
 * oldest dropped, and a note when any were.
 */
export function quoteConversation(history: ChatMessage[], cap = PROMPT_CHAT_CHARS): string[] {
  const kept: string[] = [];
  let size = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as ChatMessage;
    const line = `${SPEAKER[m.role]}: ${m.text.trim()}`;
    if (size + line.length > cap) {
      kept.push("(Older messages left out.)");
      break;
    }
    kept.push(line);
    size += line.length;
  }
  return kept.reverse();
}

export function chatPrompt(run: ClaimedRun, history: ChatMessage[]): string {
  const agent = run.agent;
  const lines = [
    agent ? `You are ${agent.name}.` : "You are an agent in this app.",
    ...(agent?.instructions.trim() ? ["", agent.instructions.trim()] : []),
    "",
    "## This app",
    "It runs an org's work as workflows. A workflow is an ordered list of statuses, and each status has an owner: an agent (with a brief), a person, or nobody.",
    "Projects follow a workflow and their items move through its statuses: an agent runs when an item enters a status it owns, and a person finds theirs in their inbox.",
    "Plugins add what the base can't do (a step, a reaction, a rule, a field, a card), and gateways are the org's connections to outside systems, which plugins use by name.",
    "Your tools for all of it are on the `factory` MCP server: start with `flow_ops` (every operation, each called with `flow_call`), and read `plugin_guide` before writing a plugin.",
    "A person is talking to you in Chat. Do what they ask with those tools; what you change is live at once.",
  ];
  const said = quoteConversation(history);
  if (said.length) lines.push("", "## The conversation so far, oldest first", ...said);
  lines.push(
    "",
    "## Their new message",
    run.brief.trim(),
    "",
    `When you are done, write your reply as JSON to \`${RESULT_FILE}\` in your working directory:`,
    "```",
    '{ "outcome": "done", "summary": "your reply to the person" }',
    "```",
    "The summary is shown to the person as your reply. Write it in plain words: say what you did (or why you didn't), and ask at most one question.",
  );
  return lines.join("\n");
}
