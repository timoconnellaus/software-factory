// The prompt for a chat's run (migrations 0433, 0437): a short fixed system text (this is a chat with
// a model inside the owner's workflow app, what the app is, and when to act on it with the `factory`
// tools), the conversation so far, the person's new message (the run's brief), and the result
// footer, whose summary is the reply. No agent: Chat is a conversation with a model.
import { RESULT_FILE } from "@software-factory/runner-contract";
import type { ChatMessage, ClaimedRun } from "@software-factory/store";

/** How many of a chat's newest messages a chat run's prompt reads. */
export const PROMPT_CHAT_MESSAGES = 100;
/** The most characters of conversation a chat run's prompt quotes; the oldest are dropped first. */
export const PROMPT_CHAT_CHARS = 24_000;

const SPEAKER = { person: "Person", assistant: "You", did: "You did" } as const;

/** What every chat run is told before the conversation. */
export const CHAT_SYSTEM = [
  "You are a helpful assistant in a chat inside the owner's workflow app. Answer like a normal assistant: think things through with the person, answer questions, and give your view.",
  "",
  "## This app",
  "It runs an org's work. Projects hold items, and each project follows a workflow: an ordered list of statuses, each with an owner (an agent with a brief, a person, or nobody). Items move through those statuses; an agent runs when an item enters a status it owns, and a person finds theirs in their inbox.",
  "Agents are the org's AI workers. Plugins add what the app can't do on its own (a step, a reaction, a rule, a field, a card). Gateways are the org's connections to outside systems, which plugins use by name. Schedules create items or run plugins on a timetable.",
  "",
  "## Acting on it",
  "You can act on the app with the tools on the `factory` MCP server: `flow_ops` lists every operation and `flow_call` calls one; read `plugin_guide` before writing a plugin. What you change is live at once.",
  "Use them when the person asks, or when it is clearly what they want: for example, after talking a feature through, create its items in the right project. Say what you did.",
  "Ask before doing anything large or destructive (deleting or replacing things, many changes at once, anything they didn't mention).",
].join("\n");

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
  const lines = [CHAT_SYSTEM];
  const said = quoteConversation(history);
  if (said.length) lines.push("", "## The conversation so far, oldest first", ...said);
  lines.push(
    "",
    "## Their new message",
    run.brief.trim(),
    "",
    `When you are done, write your reply as JSON to \`${RESULT_FILE}\` in your working directory:`,
    "```",
    '{ "outcome": "done", "summary": "your reply, in Markdown" }',
    "```",
    "The summary is your reply, shown to the person as it is: Markdown, as long as the answer needs. It is your answer to them, not a status report.",
  );
  return lines.join("\n");
}
