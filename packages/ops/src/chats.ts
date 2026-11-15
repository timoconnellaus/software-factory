// flow.chat.*: Chat, where a person builds workflows and plugins by talking to an agent with the
// engine's "factory" MCP server. Each message queues one run of the chat's agent; its summary comes
// back as the agent's reply. And flow.agent.ensureBuilder, so Chat works in a fresh org.
import {
  CHAT_LIST_LIMIT,
  CHAT_MESSAGE_LIMIT,
  createAgent,
  createChat,
  deleteChat,
  findBuilder,
  getAgent,
  getChat,
  listChats,
  sendMessage,
} from "@software-factory/store";
import { z } from "zod";
import { defineOperation, id, OpError, orgId, personOf } from "./operation.ts";

/** The engine's own MCP server: what a chat's agent builds with. */
const FACTORY = "factory";

const text = z.string().trim().min(1).max(20_000);

/** What the Builder that ensureBuilder creates is told. */
export const BUILDER_INSTRUCTIONS = [
  "You set up how this org works when a person asks you to: workflows and their statuses, projects,",
  "agents, gateways, and plugins for what the app can't do on its own. Do what was asked with the",
  "factory tools, check that it worked, and keep it as simple as the request allows. Ask before",
  "deleting or replacing anything the person didn't mention.",
].join(" ");

const view = async (d1: D1Database, chatId: string) => {
  const found = await getChat(d1, chatId);
  if (!found) throw new OpError("not_found", `No chat ${chatId}.`);
  return found;
};

const chatView = `{ chat: { id, agentId, title, createdBy, createdAt, updatedAt }, messages (oldest first, the newest ${CHAT_MESSAGE_LIMIT}: { seq, role: person | agent | did, text, data, runId, createdAt }), truncated, working (a run is queued or claimed: the reply hasn't come), made: { workflows: [{ id, name }], plugins: [{ id, name }] } }`;

export const chatOps = [
  defineOperation({
    name: "flow.chat.create",
    description: `Start a chat with an agent that has the "factory" MCP server (the Plugin editor), with its first message. Queues one run of the agent to answer; its summary becomes the reply. Answers ${chatView}.`,
    risk: "write",
    input: z.object({ orgId, agentId: id, text }),
    handler: async (input, ctx) => {
      const agent = await getAgent(ctx.d1, input.agentId);
      if (!agent) throw new OpError("not_found", `No agent ${input.agentId}.`);
      if (!agent.mcp.includes(FACTORY)) {
        throw new OpError(
          "invalid_input",
          `${agent.name} can't build workflows or plugins. Turn on "Plugin editor" for ${agent.name} in Team, then start the chat again.`,
        );
      }
      const chat = await createChat(ctx.d1, {
        orgId: ctx.orgId,
        agentId: agent.id,
        text: input.text,
        createdBy: personOf(ctx.actor),
      });
      return view(ctx.d1, chat.id);
    },
  }),
  defineOperation({
    name: "flow.chat.send",
    description: `Send the next message in a chat. Queues one run of its agent to answer. Refused while the agent is still answering the last one. Answers ${chatView}.`,
    risk: "write",
    input: z.object({ orgId, chatId: id, text }),
    handler: async (input, ctx) => {
      await sendMessage(ctx.d1, input.chatId, input.text);
      return view(ctx.d1, input.chatId);
    },
  }),
  defineOperation({
    name: "flow.chat.list",
    description: `The org's chats, the most recently active first: { chats: [{ id, agentId, title, createdBy, createdAt, updatedAt }] }. At most ${CHAT_LIST_LIMIT}.`,
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
      "Delete a chat and its messages. A run still answering is cancelled; what the agent already built stays.",
    risk: "write",
    input: z.object({ orgId, chatId: id }),
    handler: async (input, ctx) => {
      await deleteChat(ctx.d1, input.chatId);
      return { deleted: true };
    },
  }),
  defineOperation({
    name: "flow.agent.ensureBuilder",
    description:
      'The org\'s agent for Chat: one with the "factory" MCP server (named "Builder" if there is one). Creates "Builder" with it if no agent has it.',
    risk: "write",
    input: z.object({ orgId }),
    handler: async (_input, ctx) =>
      (await findBuilder(ctx.d1, ctx.orgId)) ??
      createAgent(ctx.d1, {
        orgId: ctx.orgId,
        name: "Builder",
        instructions: BUILDER_INSTRUCTIONS,
        mcp: [FACTORY],
      }),
  }),
];
