// Chat on the new core (migrations 0433, 0437): a conversation with a model, where the person picks
// the model and the effort. The `flow.chat.*` operations' answers as the desktop app reads them,
// typed by hand from @software-factory/store, and the pure logic its screen needs: the conversation
// told as turns, and what the model is doing told in plain words (flow-chat-steps.ts).

type Org = { orgId: string };

export interface FlowChat {
  id: string;
  orgId: string;
  /** Only on chats from before migration 0437, which talked to an agent; unused. */
  agentId: string | null;
  /** The first message, cut to 80 characters. */
  title: string;
  /** The Claude Code model alias its runs use; null = the runner's default. */
  model: string | null;
  /** The Claude Code effort level its runs use; null = the runner's default. */
  effort: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowChatMessage {
  id: string;
  seq: number;
  /** `assistant`: the model's reply. `did`: something it changed during a run, in one sentence. */
  role: "person" | "assistant" | "did";
  text: string;
  /**
   * A `did` row's { kind, id, name?, created?, projectId?, number? }; a reply's { model } (the alias
   * that wrote it), with { failed: true, error } when its run failed.
   */
  data: unknown;
  runId: string | null;
  createdAt: string;
}

/** Something the chat's model created or changed. An item carries its project and number. */
export interface FlowMade {
  id: string;
  name: string;
  projectId?: string;
  number?: number;
}

export interface FlowChatMade {
  items: FlowMade[];
  projects: FlowMade[];
  workflows: FlowMade[];
  plugins: FlowMade[];
  agents: FlowMade[];
  gateways: FlowMade[];
}

export interface FlowChatView {
  chat: FlowChat;
  messages: FlowChatMessage[];
  truncated: boolean;
  /** A run is queued or claimed: the reply hasn't come yet. */
  working: boolean;
  /** That run's id (its events show what the model is doing), or null. */
  workingRunId: string | null;
  made: FlowChatMade;
}

/** A choice in a picker: the CLI's id and the name the app shows. */
export interface FlowChoice {
  id: string;
  label: string;
}

export interface FlowChatOptions {
  models: FlowChoice[];
  efforts: FlowChoice[];
  defaultModel: string;
  defaultEffort: string;
}

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
