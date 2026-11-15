// Chat on the new core (migrations 0433, 0437): a conversation with a model, where the person picks
// the model and the effort. The `flow.chat.*` operations' answers as the desktop app reads them
// (zod schemas with their types inferred, as in flow.ts, checked by flow-contract.ts), and the pure
// logic its screen needs: the conversation told as turns, and what the model is doing told in plain
// words (flow-chat-steps.ts).
import { z } from "zod";

type Org = { orgId: string };

export const flowChatSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  /** Only on chats from before migration 0437, which talked to an agent; unused. */
  agentId: z.string().nullable(),
  /** The first message, cut to 80 characters. */
  title: z.string(),
  /** The Claude Code model alias its runs use; null = the runner's default. */
  model: z.string().nullable(),
  /** The Claude Code effort level its runs use; null = the runner's default. */
  effort: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowChat = z.infer<typeof flowChatSchema>;

export const flowChatMessageSchema = z.object({
  id: z.string(),
  seq: z.number(),
  /** `assistant`: the model's reply. `did`: something it changed during a run, in one sentence. */
  role: z.enum(["person", "assistant", "did"]),
  text: z.string(),
  /**
   * A `did` row's { kind, id, name?, created?, projectId?, number? }; a reply's { model } (the alias
   * that wrote it), with { failed: true, error } when its run failed.
   */
  data: z.unknown(),
  runId: z.string().nullable(),
  createdAt: z.string(),
});
export type FlowChatMessage = z.infer<typeof flowChatMessageSchema>;

/** Something the chat's model created or changed. */
export const flowMadeSchema = z.object({ id: z.string(), name: z.string() });
export type FlowMade = z.infer<typeof flowMadeSchema>;

/** An item the chat's model created, with its project and number (the app shows `KEY-12`). */
export const flowMadeItemSchema = flowMadeSchema.extend({
  projectId: z.string(),
  number: z.number(),
});
export type FlowMadeItem = z.infer<typeof flowMadeItemSchema>;

export const flowChatMadeSchema = z.object({
  items: z.array(flowMadeItemSchema),
  projects: z.array(flowMadeSchema),
  workflows: z.array(flowMadeSchema),
  plugins: z.array(flowMadeSchema),
  agents: z.array(flowMadeSchema),
  gateways: z.array(flowMadeSchema),
});
export type FlowChatMade = z.infer<typeof flowChatMadeSchema>;

export const flowChatViewSchema = z.object({
  chat: flowChatSchema,
  messages: z.array(flowChatMessageSchema),
  truncated: z.boolean(),
  /** A run is queued or claimed: the reply hasn't come yet. */
  working: z.boolean(),
  /** That run's id (its events show what the model is doing), or null. */
  workingRunId: z.string().nullable(),
  made: flowChatMadeSchema,
});
export type FlowChatView = z.infer<typeof flowChatViewSchema>;

/** A choice in a picker: the CLI's id and the name the app shows. */
export const flowChoiceSchema = z.object({ id: z.string(), label: z.string() });
export type FlowChoice = z.infer<typeof flowChoiceSchema>;

export const flowChatOptionsSchema = z.object({
  models: z.array(flowChoiceSchema),
  efforts: z.array(flowChoiceSchema),
  defaultModel: z.string(),
  defaultEffort: z.string(),
});
export type FlowChatOptions = z.infer<typeof flowChatOptionsSchema>;

/** A model and effort sent with a message: left out, the chat's stays. */
type Choice = { model?: string | null; effort?: string | null };

/** The `flow.chat.*` operations, for packages/client's OpMap (through FlowOpMap). */
export interface FlowChatOpMap {
  "flow.chat.options": { input: Org; output: FlowChatOptions };
  "flow.chat.list": { input: Org; output: { chats: FlowChat[] } };
  "flow.chat.get": { input: Org & { chatId: string }; output: FlowChatView };
  "flow.chat.create": { input: Org & { text: string } & Choice; output: FlowChatView };
  "flow.chat.send": {
    input: Org & { chatId: string; text: string } & Choice;
    output: FlowChatView;
  };
  "flow.chat.delete": { input: Org & { chatId: string }; output: { deleted: boolean } };
}

export const EMPTY_MADE: FlowChatMade = {
  items: [],
  projects: [],
  workflows: [],
  plugins: [],
  agents: [],
  gateways: [],
};

/** Whether the chat made anything: the side pane shows only then. */
export const madeAnything = (made: FlowChatMade | undefined) =>
  !!made && Object.values(made).some((list) => list.length > 0);

/** One thing the conversation shows. */
export type ChatTurn =
  | { kind: "person"; seq: number; text: string }
  | {
      kind: "assistant";
      seq: number;
      /** The run that answers (the person's message's run): its events are the steps. */
      runId: string | null;
      /** The reply; null while the run is working, or when a run left only what it did. */
      text: string | null;
      /** The alias that wrote it (null: the runner's default, or not known). */
      model: string | null;
      /** The run failed: the reply says so, with the error. */
      failed: boolean;
      /** What it did during the run, in order. */
      dids: { seq: number; text: string }[];
      /** Its run is still going. */
      working: boolean;
    };

type Data = { failed?: unknown; model?: unknown };
const dataOf = (data: unknown): Data => (data && typeof data === "object" ? (data as Data) : {});

/**
 * The conversation as turns: each person's message, then the model's turn for it, with the `did`
 * rows of its run. While a run is in flight, the last turn is `working` (and holds the did rows so
 * far). A turn's run is its person's message's run.
 */
export function chatTurns(messages: FlowChatMessage[], working: boolean): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let open: Extract<ChatTurn, { kind: "assistant" }> | null = null;
  let runId: string | null = null;
  const reply = (seq: number) => {
    if (!open) {
      open = {
        kind: "assistant",
        seq,
        runId,
        text: null,
        model: null,
        failed: false,
        dids: [],
        working: false,
      };
      turns.push(open);
    }
    return open;
  };
  for (const m of messages) {
    if (m.role === "person") {
      open = null;
      runId = m.runId;
      turns.push({ kind: "person", seq: m.seq, text: m.text });
    } else if (m.role === "did") {
      reply(m.seq).dids.push({ seq: m.seq, text: m.text });
    } else {
      const turn = reply(m.seq);
      const data = dataOf(m.data);
      turn.text = m.text;
      turn.runId = m.runId ?? turn.runId;
      turn.failed = data.failed === true;
      turn.model = typeof data.model === "string" ? data.model : null;
      open = null;
    }
  }
  if (working) {
    const last = turns.at(-1);
    if (last?.kind === "assistant" && last.text === null) last.working = true;
    else
      turns.push({
        kind: "assistant",
        seq: (last?.seq ?? 0) + 1,
        runId,
        text: null,
        model: null,
        failed: false,
        dids: [],
        working: true,
      });
  }
  return turns;
}

/** How many `did` rows a chat has: when it changes, what the side pane shows is read again. */
export const didCount = (messages: FlowChatMessage[] | undefined) =>
  messages?.filter((m) => m.role === "did").length ?? 0;

/** A model's or effort's name for the app: its label, else "Claude" for the runner's default. */
export function choiceLabel(list: FlowChoice[] | undefined, id: string | null): string {
  if (!id) return "Claude";
  return list?.find((c) => c.id === id)?.label ?? id;
}
