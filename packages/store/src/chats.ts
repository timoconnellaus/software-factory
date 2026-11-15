// Chats (migrations 0433, 0437): a person talks to a model, choosing the model and the effort as in an
// ordinary Claude chat. Each message the person sends queues one run (a flow_runs row with `chat_id`
// and no agent: `agent_id` ''), which starts Claude Code on their runner with the engine's "factory"
// MCP server; its summary comes back as the model's reply (chat-runs.ts). What the model changed
// during a run is written as `did` messages by the MCP server.
import { clearGuards, failedGuard, guardChanged, readBatch } from "@software-factory/db";
import type { ModelChoice } from "./agents.ts";
import { type DidData, type Made, madeOf } from "./chat-made.ts";
import { flowDb, iso, newId, StoreError } from "./db.ts";
import type { FlowChatMessagesTable, FlowChatsTable } from "./schema.ts";

/** The most chats `listChats` returns, newest first. */
export const CHAT_LIST_LIMIT = 50;
/** The most messages `getChat` returns: the newest. */
export const CHAT_MESSAGE_LIMIT = 500;
/** How long a chat's title (its first message) may be. */
export const CHAT_TITLE_MAX = 80;
/** The most `did` rows `getChat` reads for `made`. */
const MADE_LIMIT = 500;

export interface Chat {
  id: string;
  orgId: string;
  /** Only on chats from before migration 0437, which talked to an agent; unused now. */
  agentId: string | null;
  title: string;
  /** The Claude Code model alias its runs use; null = the runner's default. */
  model: string | null;
  /** The Claude Code effort level its runs use; null = the runner's default. */
  effort: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A message's role in the API: the person's, the model's reply, or something the model did. */
export type ChatMessageRole = "person" | "assistant" | "did";

export interface ChatMessage {
  id: string;
  seq: number;
  role: ChatMessageRole;
  text: string;
  /** A `did` row's DidData; a failed run's reply's { failed: true, error }. */
  data: unknown;
  runId: string | null;
  createdAt: string;
}

export interface ChatView {
  chat: Chat;
  /** In order, oldest first: the newest CHAT_MESSAGE_LIMIT. */
  messages: ChatMessage[];
  truncated: boolean;
  /** Whether a run of the chat is queued or claimed: its reply hasn't come yet. */
  working: boolean;
  /** The id of that run (for its live events), or null. */
  workingRunId: string | null;
  /** What this chat's model made (from its `did` rows). */
  made: Made;
}

const BUSY = "Still answering your last message. Send this once the reply has come back.";

function toChat(row: FlowChatsTable): Chat {
  return {
    id: row.id,
    orgId: row.org_id,
    agentId: row.agent_id ?? null,
    title: row.title,
    model: row.model ?? null,
    effort: row.effort ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toChatMessage(row: FlowChatMessagesTable): ChatMessage {
  return {
    id: row.id,
    seq: row.seq,
    // Stored as `agent` (migration 0433); it is the model's reply.
    role: row.role === "agent" ? "assistant" : row.role,
    text: row.text,
    data: row.data === null ? null : (JSON.parse(row.data) as unknown),
    runId: row.run_id,
    createdAt: row.created_at,
  };
}

/** A title from the first message: one line, at most CHAT_TITLE_MAX characters. */
export function chatTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= CHAT_TITLE_MAX ? line : `${line.slice(0, CHAT_TITLE_MAX - 1).trimEnd()}…`;
}

/** Appends a message to a chat, numbered after its last (one statement, so the seq is taken atomically). */
export function appendMessage(
  d1: D1Database,
  m: {
    chatId: string;
    orgId: string;
    role: FlowChatMessagesTable["role"];
    text: string;
    data?: unknown;
    runId?: string | null;
    at: string;
  },
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO flow_chat_messages (id, chat_id, org_id, seq, role, text, data, run_id, created_at)
        SELECT ?1, ?2, ?3, COALESCE(MAX(seq), 0) + 1, ?4, ?5, ?6, ?7, ?8
        FROM flow_chat_messages WHERE chat_id = ?2`,
    )
    .bind(
      newId("fmsg_"),
      m.chatId,
      m.orgId,
      m.role,
      m.text,
      m.data === undefined ? null : JSON.stringify(m.data),
      m.runId ?? null,
      m.at,
    );
}

/** Whether a D1 error is two appends taking the same seq. */
const seqTaken = (error: unknown) =>
  /UNIQUE constraint failed: flow_chat_messages\./.test(
    String(error instanceof Error ? error.message : error),
  );

/**
 * Runs a batch that appends to a chat, ending with the guard cleanup. Two appends taking the same
 * seq is retried (twice); a failed guard is `busy`.
 */
export async function chatBatch(
  d1: D1Database,
  statements: () => D1PreparedStatement[],
  busy: StoreError,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await d1.batch([...statements(), clearGuards(d1)]);
      return;
    } catch (error) {
      if (failedGuard(error)) throw busy;
      if (seqTaken(error) && attempt < 2) continue;
      throw error;
    }
  }
}

/**
 * The person's message and the run that answers it, refused (as one batch) while the chat has a run
 * queued or claimed. The run's `stay` is the message's seq; its `brief` is the message. A chat's run
 * has no agent (`agent_id` ''); it uses the chat's model and effort when it is claimed.
 */
function messageAndRun(
  d1: D1Database,
  chat: { id: string; orgId: string },
  text: string,
  at: string,
): D1PreparedStatement[] {
  const runId = newId("frun_");
  return [
    d1
      .prepare(
        `INSERT INTO flow_runs (id, org_id, item_id, chat_id, agent_id, status_id, stay, brief,
            status, fencing_token, created_at)
          SELECT ?1, ?2, NULL, ?3, '', '',
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM flow_chat_messages WHERE chat_id = ?3),
            ?4, 'queued', 0, ?5
          WHERE NOT EXISTS (SELECT 1 FROM flow_runs
            WHERE chat_id = ?3 AND status IN ('queued', 'claimed'))`,
      )
      .bind(runId, chat.orgId, chat.id, text, at),
    guardChanged(d1, "flow_chats.idle"),
    appendMessage(d1, { chatId: chat.id, orgId: chat.orgId, role: "person", text, runId, at }),
    d1.prepare("UPDATE flow_chats SET updated_at = ? WHERE id = ?").bind(at, chat.id),
  ];
}

/** Starts a chat with its first message, and queues the run that answers it. */
export async function createChat(
  d1: D1Database,
  input: { orgId: string; text: string; createdBy: string } & ModelChoice,
): Promise<Chat> {
  const at = iso();
  const chat: Chat = {
    id: newId("fchat_"),
    orgId: input.orgId,
    agentId: null,
    title: chatTitle(input.text),
    model: input.model ?? null,
    effort: input.effort ?? null,
    createdBy: input.createdBy,
    createdAt: at,
    updatedAt: at,
  };
  await chatBatch(
    d1,
    () => [
      d1
        .prepare(
          `INSERT INTO flow_chats (id, org_id, agent_id, title, model, effort, created_by,
              created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(chat.id, chat.orgId, chat.title, chat.model, chat.effort, chat.createdBy, at, at),
      ...messageAndRun(d1, chat, input.text, at),
    ],
    new StoreError("conflict", BUSY),
  );
  return chat;
}

export async function getChatRow(d1: D1Database, chatId: string): Promise<Chat | null> {
  const row = await flowDb(d1)
    .selectFrom("flow_chats")
    .selectAll()
    .where("id", "=", chatId)
    .executeTakeFirst();
  return row ? toChat(row) : null;
}

/**
 * Adds the person's next message and queues the run that answers it; refused while one is open. A
 * model or effort given changes the chat's, from this message on (null: the runner's default).
 */
export async function sendMessage(
  d1: D1Database,
  chatId: string,
  text: string,
  choice: ModelChoice = {},
): Promise<void> {
  const chat = await getChatRow(d1, chatId);
  if (!chat) throw new StoreError("not_found", `No chat ${chatId}.`);
  const model = choice.model !== undefined ? choice.model : chat.model;
  const effort = choice.effort !== undefined ? choice.effort : chat.effort;
  await chatBatch(
    d1,
    () => {
      const at = iso();
      // After the run's insert, whose NOT EXISTS guard refuses the whole batch while one is open.
      const [run, ...rest] = messageAndRun(d1, chat, text, at);
      return [
        run as D1PreparedStatement,
        ...rest,
        d1
          .prepare("UPDATE flow_chats SET model = ?, effort = ? WHERE id = ?")
          .bind(model, effort, chat.id),
      ];
    },
    new StoreError("conflict", BUSY),
  );
}

/** The org's newest CHAT_LIST_LIMIT chats, by when they last changed (flow_chats_org_idx). */
export async function listChats(d1: D1Database, orgId: string): Promise<Chat[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_chats")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("updated_at", "desc")
    .orderBy("id", "desc")
    .limit(CHAT_LIST_LIMIT)
    .execute();
  return rows.map(toChat);
}

/**
 * A chat as the app shows it, in one D1 request: the chat by primary key, its newest messages, its
 * `did` rows for `made`, and whether a run is open (flow_runs_chat_idx).
 */
export async function getChat(d1: D1Database, chatId: string): Promise<ChatView | null> {
  const db = flowDb(d1);
  const [chats, rows, dids, open] = await readBatch(d1, [
    db.selectFrom("flow_chats").selectAll().where("id", "=", chatId),
    db
      .selectFrom("flow_chat_messages")
      .selectAll()
      .where("chat_id", "=", chatId)
      .orderBy("seq", "desc")
      .limit(CHAT_MESSAGE_LIMIT + 1),
    db
      .selectFrom("flow_chat_messages")
      .select("data")
      .where("chat_id", "=", chatId)
      .where("role", "=", "did")
      .orderBy("seq")
      .limit(MADE_LIMIT),
    db
      .selectFrom("flow_runs")
      .select("id")
      .where("chat_id", "=", chatId)
      .where("status", "in", ["queued", "claimed"])
      .limit(1),
  ] as const);
  const chat = chats[0];
  if (!chat) return null;
  const data = dids
    .map((d) => (d.data === null ? null : (JSON.parse(d.data) as DidData)))
    .filter((d): d is DidData => d !== null && typeof d.id === "string");
  return {
    chat: toChat(chat),
    messages: rows.slice(0, CHAT_MESSAGE_LIMIT).reverse().map(toChatMessage),
    truncated: rows.length > CHAT_MESSAGE_LIMIT,
    working: open.length > 0,
    workingRunId: open[0]?.id ?? null,
    made: madeOf(data),
  };
}

/** Deletes a chat and its messages; a run still queued or claimed is cancelled (its runs stay). */
export async function deleteChat(d1: D1Database, chatId: string): Promise<void> {
  const at = iso();
  await d1.batch([
    d1
      .prepare(
        "UPDATE flow_runs SET status = 'cancelled', finished_at = ? WHERE chat_id = ? AND status IN ('queued', 'claimed')",
      )
      .bind(at, chatId),
    d1.prepare("DELETE FROM flow_chat_messages WHERE chat_id = ?").bind(chatId),
    d1.prepare("DELETE FROM flow_chats WHERE id = ?").bind(chatId),
  ]);
}

/** Adds a `did` row: something the model of chat run `runId` changed, in plain words. */
export async function addDid(
  d1: D1Database,
  did: { chatId: string; orgId: string; runId: string; text: string; data: DidData },
): Promise<void> {
  await chatBatch(
    d1,
    () => [appendMessage(d1, { ...did, role: "did", at: iso() })],
    new StoreError("conflict", "The chat changed; try again."),
  );
}

/**
 * The conversation before the message a run answers (`beforeSeq`): its newest `limit` messages
 * (what the person said, the model's replies, what it did), oldest first. A run's prompt quotes them.
 */
export async function chatHistory(
  d1: D1Database,
  chatId: string,
  beforeSeq: number,
  limit: number,
): Promise<ChatMessage[]> {
  const rows = await flowDb(d1)
    .selectFrom("flow_chat_messages")
    .selectAll()
    .where("chat_id", "=", chatId)
    .where("seq", "<", beforeSeq)
    .orderBy("seq", "desc")
    .limit(limit)
    .execute();
  return rows.reverse().map(toChatMessage);
}
