// Chat's fixtures (migration 0433, .kim/mockups/chat-build-a-workflow-and-a-plugin.html) for the
// screenshot harness and the behaviour tests: a conversation where the agent built a workflow and a
// plugin, one whose run is in flight, and one whose run failed. Sending a message (or starting a
// chat) shows the agent working, then, a moment later, what it did and its reply, as a runner would.
// flow-fixtures.ts imports this file and spreads CHAT_ANSWERS into its answers, so nothing here may
// read its values at load time: the ids are written out.
import type { FlowOpMap, FlowWorkflow } from "@software-factory/client/flow";
import type { FlowChat, FlowChatMessage, FlowChatView } from "@software-factory/client/flow-chat";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const ORG = "org_personal";
const ME = "usr_owner";
const BUILDER = "fagt_chat";

/** The workflow the first chat built; flow.workflow.get answers it. */
export const CHAT_WORKFLOWS: FlowWorkflow[] = [
  {
    id: "fwf_launch",
    orgId: ORG,
    workflow: {
      id: "fwf_launch",
      name: "Launch content",
      statuses: [
        { id: "brief", name: "Brief", owner: { kind: "person", userId: ME } },
        {
          id: "research",
          name: "Research",
          owner: { kind: "agent", agentId: "fagt_lead" },
          brief: "Find what the launch needs to say.",
        },
        {
          id: "draft",
          name: "Draft",
          owner: { kind: "agent", agentId: "fagt_backend" },
          brief: "Draft the post.",
        },
        { id: "edit", name: "Edit", owner: { kind: "person", userId: "usr_mia" } },
        { id: "published", name: "Published", owner: { kind: "none" } },
      ],
    },
    createdAt: ago(40),
    updatedAt: ago(12),
  },
];

let seq = 0;
const message = (
  role: FlowChatMessage["role"],
  text: string,
  min: number,
  data: unknown = null,
): FlowChatMessage => ({
  id: `fmsg_${++seq}`,
  seq,
  role,
  text,
  data,
  runId: role === "person" ? null : `frun_chat_${seq}`,
  createdAt: ago(min),
});

const chat = (id: string, title: string, min: number): FlowChat => ({
  id,
  orgId: ORG,
  agentId: BUILDER,
  title,
  createdBy: ME,
  createdAt: ago(min),
  updatedAt: ago(min),
});

const VIEWS: Record<string, FlowChatView> = {
  fchat_launch: {
    chat: chat("fchat_launch", "Set up a workflow for launch content", 12),
    messages: [
      message(
        "person",
        "Set up a workflow for launch content: I write a brief, an agent researches, another drafts, Mia edits, then it's published.",
        40,
      ),
      message("did", "Created the workflow Launch content (5 statuses)", 39, {
        kind: "workflow",
        id: "fwf_launch",
        name: "Launch content",
      }),
      message("did", "Put the project Autopilots launch on another workflow", 39, {
        kind: "project",
        id: "fprj_launch",
        name: "Autopilots launch",
      }),
      message(
        "agent",
        "Done. Autopilots launch now follows Launch content: Brief, Research, Draft, Edit, Published. Lead researches and Backend drafts; Brief is yours and Edit is Mia's.",
        38,
      ),
      message(
        "person",
        "When it gets to Published, actually post it to our blog and put the link on the item.",
        14,
      ),
      message("did", "Built the plugin Publish to the blog", 13, {
        kind: "plugin",
        id: "fplg_blog",
        name: "Publish to the blog",
      }),
      message(
        "agent",
        "The app can't post to a blog on its own, so I built a plugin for it. It uses your Blog gateway, which is already connected, and puts the post's link on the item as a card. Want me to try it on a test item?",
        12,
      ),
    ],
    truncated: false,
    working: false,
    made: {
      workflows: [{ id: "fwf_launch", name: "Launch content" }],
      plugins: [{ id: "fplg_blog", name: "Publish to the blog" }],
    },
  },
  fchat_legal: {
    chat: chat(
      "fchat_legal",
      "Add a legal check before Edit for anything that mentions pricing",
      2,
    ),
    messages: [
      message(
        "person",
        "Add a legal check before Edit for anything that mentions pricing, owned by a new Legal agent.",
        2,
      ),
      message("did", "Added the agent Legal", 1, {
        kind: "agent",
        id: "fagt_legal",
        name: "Legal",
      }),
    ],
    truncated: false,
    working: true,
    made: { workflows: [], plugins: [] },
  },
  fchat_slack: {
    chat: chat("fchat_slack", "Tell #launch in Slack whenever a launch item changes status", 300),
    messages: [
      message("person", "Tell #launch in Slack whenever a launch item changes status.", 302),
      message(
        "agent",
        "I couldn't finish that: The runner stopped responding. Send your message again to have me try once more.",
        300,
        { failed: true, error: "The runner stopped responding." },
      ),
    ],
    truncated: false,
    working: false,
    made: { workflows: [], plugins: [] },
  },
};

/** What the agent "does" a moment after a message: a did row, then its reply. */
function answerLater(view: FlowChatView) {
  setTimeout(() => {
    view.messages.push(
      message("did", "Changed the workflow Launch content (6 statuses)", 0, {
        kind: "workflow",
        id: "fwf_launch",
        name: "Launch content",
      }),
      message("agent", "Done. Launch content now has a Legal check before Edit.", 0),
    );
    view.working = false;
    view.made.workflows = [{ id: "fwf_launch", name: "Launch content" }];
    view.chat.updatedAt = ago(0);
  }, 1500);
}

/** The door answers with a copy, as JSON over the wire would: the app never holds this state. */
const copy = <T>(value: T): T => structuredClone(value);

const say = (view: FlowChatView, text: string): FlowChatView => {
  view.messages.push(message("person", text, 0));
  view.working = true;
  view.chat.updatedAt = ago(0);
  answerLater(view);
  return copy(view);
};

type ChatAnswers = {
  [N in keyof FlowOpMap]?: (input: FlowOpMap[N]["input"]) => FlowOpMap[N]["output"];
};

export const CHAT_ANSWERS: ChatAnswers = {
  "flow.chat.list": (input) => ({
    chats: Object.values(VIEWS)
      .filter((v) => v.chat.orgId === input.orgId)
      .map((v) => copy(v.chat))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }),
  "flow.chat.get": (input) => copy(VIEWS[input.chatId] ?? (VIEWS.fchat_launch as FlowChatView)),
  "flow.chat.create": (input) => {
    const view: FlowChatView = {
      chat: { ...chat("fchat_new", input.text.slice(0, 80), 0), agentId: input.agentId },
      messages: [],
      truncated: false,
      working: false,
      made: { workflows: [], plugins: [] },
    };
    VIEWS.fchat_new = view;
    return say(view, input.text);
  },
  "flow.chat.send": (input) => say(VIEWS[input.chatId] as FlowChatView, input.text),
  "flow.chat.delete": (input) => {
    delete VIEWS[input.chatId];
    return { deleted: true };
  },
  "flow.agent.ensureBuilder": () => ({
    id: BUILDER,
    orgId: ORG,
    name: "Builder",
    instructions: "Set up how this org works when a person asks you to.",
    mcp: ["factory"],
    createdAt: ago(9000),
  }),
};
