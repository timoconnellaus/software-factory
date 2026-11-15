// flow.chat.*: Chat, a conversation with a model (spec 70, "Chat"). The person picks the model and
// the effort, as in an ordinary Claude chat. Each message queues one run on their runner, which
// starts Claude Code with the engine's "factory" MCP server, so the model can act on the app when
// that is what the person wants; the run's summary comes back as the reply.
import {
  CHAT_LIST_LIMIT,
  CHAT_MESSAGE_LIMIT,
  createChat,
  deleteChat,
  getChat,
  listChats,
  sendMessage,
} from "@software-factory/store";
import { z } from "zod";
import { CHAT_EFFORTS, CHAT_MODELS, chatOptions, effortInput, modelInput } from "./models.ts";
import { defineOperation, id, OpError, orgId, personOf } from "./operation.ts";

const text = z.string().trim().min(1).max(20_000);

const view = async (d1: D1Database, chatId: string) => {
  const found = await getChat(d1, chatId);
  if (!found) throw new OpError("not_found", `No chat ${chatId}.`);
  return found;
};

const chatShape = "{ id, title, model, effort, createdBy, createdAt, updatedAt }";
const chatView = `{ chat: ${chatShape}, messages (oldest first, the newest ${CHAT_MESSAGE_LIMIT}: { seq, role: person | assistant | did, text, data, runId, createdAt }), truncated, working (a run is queued or claimed: the reply hasn't come), workingRunId, made: { items, projects, workflows, plugins, agents, gateways: [{ id, name }] } }`;
const choices = `\`model\` is one of ${CHAT_MODELS.map((m) => m.id).join(", ")} and \`effort\` one of ${CHAT_EFFORTS.map((e) => e.id).join(", ")} (null: the runner's default)`;

export const chatOps = [
  defineOperation({
    name: "flow.chat.options",
    description:
      "The models and effort levels a chat can use (Claude Code's own aliases and levels), with the names the app shows, and what a new chat starts with: { models: [{ id, label }], efforts: [{ id, label }], defaultModel, defaultEffort }.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async () => chatOptions(),
  }),
  defineOperation({
    name: "flow.chat.create",
    description: `Start a chat with a model, with its first message. ${choices}. Queues one run on the person's runner to answer; its summary becomes the reply. Answers ${chatView}.`,
    risk: "write",
    input: z.object({ orgId, text, model: modelInput, effort: effortInput }),
    handler: async (input, ctx) => {
      const chat = await createChat(ctx.d1, {
        orgId: ctx.orgId,
        text: input.text,
        createdBy: personOf(ctx.actor),
        model: input.model ?? null,
        effort: input.effort ?? null,
      });
      return view(ctx.d1, chat.id);
    },
  }),
  defineOperation({
    name: "flow.chat.send",
    description: `Send the next message in a chat. A \`model\` or \`effort\` given changes the chat's from this message on; ${choices}. Queues one run to answer. Refused while the last one is still being answered. Answers ${chatView}.`,
    risk: "write",
    input: z.object({ orgId, chatId: id, text, model: modelInput, effort: effortInput }),
    handler: async (input, ctx) => {
      await sendMessage(ctx.d1, input.chatId, input.text, {
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
      });
      return view(ctx.d1, input.chatId);
    },
  }),
  defineOperation({
    name: "flow.chat.list",
    description: `The org's chats, the most recently active first: { chats: [${chatShape}] }. At most ${CHAT_LIST_LIMIT}.`,
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ chats: await listChats(ctx.d1, ctx.orgId) }),
  }),
  defineOperation({
    name: "flow.chat.get",
    description: `One chat: ${chatView}.`,
    risk: "read",
    input: z.object({ orgId, chatId: id }),
    handler: (input, ctx) => view(ctx.d1, input.chatId),
  }),
  defineOperation({
    name: "flow.chat.delete",
    description:
      "Delete a chat and its messages. A run still answering is cancelled; what the model already made stays.",
    risk: "write",
    input: z.object({ orgId, chatId: id }),
    handler: async (input, ctx) => {
      await deleteChat(ctx.d1, input.chatId);
      return { deleted: true };
    },
  }),
];
