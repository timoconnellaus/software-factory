// Chat on the new core (migration 0433, .kim/mockups/chat-build-a-workflow-and-a-plugin.html): the
// `flow.chat.*` operations' answers as the desktop app reads them, typed by hand from
// @software-factory/store, and the pure logic its screen needs: the conversation told as turns.
import { z } from "zod";
import type { FlowAgent } from "./flow.ts";

type Org = { orgId: string };

// The answers' shapes are zod schemas with their types inferred (see flow.ts).

export const flowChatSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  agentId: z.string(),
  /** The first message, cut to 80 characters. */
  title: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowChat = z.infer<typeof flowChatSchema>;

export const flowChatMessageSchema = z.object({
  id: z.string(),
  seq: z.number(),
  /** `did`: something the agent changed during a run, in one plain sentence. */
  role: z.enum(["person", "agent", "did"]),
  text: z.string(),
  /** A `did` row's { kind, id, name? }; a failed run's agent message's { failed: true, error }. */
  data: z.unknown(),
  runId: z.string().nullable(),
  createdAt: z.string(),
});
export type FlowChatMessage = z.infer<typeof flowChatMessageSchema>;

/** A workflow or plugin the chat's agent created or changed. */
export const flowMadeSchema = z.object({ id: z.string(), name: z.string() });
export type FlowMade = z.infer<typeof flowMadeSchema>;

export const flowChatViewSchema = z.object({
  chat: flowChatSchema,
  messages: z.array(flowChatMessageSchema),
  truncated: z.boolean(),
  /** A run of the chat's agent is queued or claimed: its reply hasn't come yet. */
  working: z.boolean(),
  made: z.object({ workflows: z.array(flowMadeSchema), plugins: z.array(flowMadeSchema) }),
});
export type FlowChatView = z.infer<typeof flowChatViewSchema>;

/** The `flow.chat.*` operations, for packages/client's OpMap (through FlowOpMap). */
export interface FlowChatOpMap {
  "flow.chat.list": { input: Org; output: { chats: FlowChat[] } };
  "flow.chat.get": { input: Org & { chatId: string }; output: FlowChatView };
  "flow.chat.create": { input: Org & { agentId: string; text: string }; output: FlowChatView };
  "flow.chat.send": { input: Org & { chatId: string; text: string }; output: FlowChatView };
  "flow.chat.delete": { input: Org & { chatId: string }; output: { deleted: boolean } };
  "flow.agent.ensureBuilder": { input: Org; output: FlowAgent };
}

/** One thing the conversation shows. */
export type ChatTurn =
  | { kind: "person"; seq: number; text: string }
  | {
      kind: "agent";
      seq: number;
      /** The reply; null while the run is working, or when a run left only what it did. */
      text: string | null;
      /** The run failed: the reply says so, with the error. */
      failed: boolean;
      /** What it did during the run, in order. */
      dids: { seq: number; text: string }[];
      /** Its run is still going: "Builder is working…" shows where the reply will go. */
      working: boolean;
    };

const isFailed = (data: unknown) =>
  !!data && typeof data === "object" && (data as { failed?: unknown }).failed === true;

/**
 * The conversation as turns: each person's message, then the agent's turn for it, with the `did`
 * rows of its run under its reply (as the mockup shows them). While a run is in flight, the last
 * agent turn is `working` (and holds the did rows so far).
 */
export function chatTurns(messages: FlowChatMessage[], working: boolean): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let open: Extract<ChatTurn, { kind: "agent" }> | null = null;
  const agentTurn = (seq: number) => {
    if (!open) {
      open = { kind: "agent", seq, text: null, failed: false, dids: [], working: false };
      turns.push(open);
    }
    return open;
  };
  for (const m of messages) {
    if (m.role === "person") {
      open = null;
      turns.push({ kind: "person", seq: m.seq, text: m.text });
    } else if (m.role === "did") {
      agentTurn(m.seq).dids.push({ seq: m.seq, text: m.text });
    } else {
      const turn = agentTurn(m.seq);
      turn.text = m.text;
      turn.failed = isFailed(m.data);
      open = null;
    }
  }
  if (working) {
    const last = turns.at(-1);
    if (last?.kind === "agent" && last.text === null) last.working = true;
    else
      turns.push({
        kind: "agent",
        seq: (last?.seq ?? 0) + 1,
        text: null,
        failed: false,
        dids: [],
        working: true,
      });
  }
  return turns;
}

/** How many `did` rows a chat has: when it changes, what the live pane shows is read again. */
export const didCount = (messages: FlowChatMessage[] | undefined) =>
  messages?.filter((m) => m.role === "did").length ?? 0;
