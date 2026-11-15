// Chat's fixtures (migrations 0433, 0437) for the screenshot harness and the behaviour tests: a plain
// conversation with a Markdown reply (nothing made, so no side pane), one where talking a feature
// through ended in items, one that built a workflow and a plugin, one whose run is in flight (its
// steps come from the run's events), and one whose run failed. Sending a message (or starting a
// chat) shows the run's steps as they arrive, then, a moment later, what it did and its reply, as a
// runner would. flow-fixtures.ts imports this file and spreads CHAT_ANSWERS into its answers (and
// reads CHAT_RUN_EVENTS for a chat run's events), so nothing here may read its values at load
// time: the ids are written out.
import type { FlowOpMap, FlowWorkflow } from "@software-factory/client/flow";
import {
  EMPTY_MADE,
  type FlowChat,
  type FlowChatMessage,
  type FlowChatOptions,
  type FlowChatView,
} from "@software-factory/client/flow-chat";
import type { FlowRunEvent } from "@software-factory/client/flow-run";

const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

const ORG = "org_personal";
const ME = "usr_owner";

/** The workflow the launch chat built; flow.workflow.get answers it. */
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

/** The choices flow.chat.options answers, as the engine does (packages/ops models.ts). */
export const CHAT_OPTIONS: FlowChatOptions = {
  models: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
    { id: "fable", label: "Fable" },
  ],
  efforts: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra high" },
    { id: "max", label: "Max" },
  ],
  defaultModel: "opus",
  defaultEffort: "high",
};

let seq = 0;
let runs = 0;
/** A message; a person's starts a run, which the messages after it (until the next) belong to. */
let currentRun = "";
const message = (
  role: FlowChatMessage["role"],
  text: string,
  min: number,
  data: unknown = null,
): FlowChatMessage => {
  if (role === "person") currentRun = `frun_chat_${++runs}`;
  return {
    id: `fmsg_${++seq}`,
    seq,
    role,
    text,
    data,
    runId: currentRun,
    createdAt: ago(min),
  };
};

const chat = (id: string, title: string, min: number, model: string | null): FlowChat => ({
  id,
  orgId: ORG,
  agentId: null,
  title,
  model,
  effort: model ? "high" : null,
  createdBy: ME,
  createdAt: ago(min),
  updatedAt: ago(min),
});

/** A chat run's events (flow.run.events), and whether the run has ended. */
export const CHAT_RUN_EVENTS: Record<string, { events: FlowRunEvent[]; done: boolean }> = {};

let eventSeq = 0;
const at = (min: number) => ago(min);
const note = (text: string, min = 0): FlowRunEvent => ({
  seq: ++eventSeq,
  at: at(min),
  kind: "note",
  text,
});
/** A tool call and its result, as the runner reports them. */
const call = (name: string, input: unknown, min = 0): FlowRunEvent[] => {
  const toolId = `tool_${++eventSeq}`;
  return [
    {
      seq: eventSeq,
      at: at(min),
      kind: "tool",
      name,
      label: "",
      input: JSON.stringify(input),
      toolId,
    },
    { seq: ++eventSeq, at: at(min), kind: "result", toolId, output: "{}", isError: false },
  ];
};
const flow = (op: string, input: unknown = {}, min = 0) =>
  call("mcp__factory__flow_call", { op, input }, min);

const MARKDOWN_REPLY = `Good question. For a small team, I'd keep the workflow short and give each status one clear owner.

### A shape that works

1. **Brief**: you write what the change is for, in a few lines.
2. **Build**: an agent does the work and opens the change.
3. **Review**: a person reads it before it ships.

| Status | Owner | Done when |
| --- | --- | --- |
| Brief | You | The goal is one sentence |
| Build | An agent | The change is ready to read |
| Review | Mia | It's approved or sent back |

A status's brief is what the agent is told when an item arrives, for example:

\`\`\`
Draft the change in under 200 lines. Say what you tried.
\`\`\`

If you want, I can set this up as a workflow and point **API Platform** at it.`;

const VIEWS: Record<string, FlowChatView> = {
  fchat_plain: {
    chat: chat("fchat_plain", "How should I shape a workflow for a small team?", 30, "opus"),
    messages: [
      message(
        "person",
        "How should I shape a workflow for a small team? We're three people and a couple of agents.",
        31,
      ),
      message("assistant", MARKDOWN_REPLY, 30, { model: "opus" }),
    ],
    truncated: false,
    working: false,
    workingRunId: null,
    made: EMPTY_MADE,
  },
  fchat_notes: {
    chat: chat("fchat_notes", "Search across notes: let's think it through", 8, "sonnet"),
    messages: [
      message(
        "person",
        "I want search across notes. Can we think through what it needs before building anything?",
        20,
      ),
      message(
        "assistant",
        "Sure. Three things matter most:\n\n- **What's searched**: titles and bodies, or tags too?\n- **How fast it must feel**: results as you type, or on Enter?\n- **Where it lives**: one box at the top, or a page of its own?\n\nMy suggestion: titles and bodies, results as you type, one box at the top.",
        19,
        { model: "sonnet" },
      ),
      message(
        "person",
        "Agreed on all three. Put it in API Platform as items, one per piece of work.",
        9,
      ),
      message("did", "Created the item Index note titles and bodies", 9, {
        kind: "item",
        id: "fitm_chat_index",
        name: "Index note titles and bodies",
        created: true,
        projectId: "fprj_api",
        number: 13,
      }),
      message("did", "Created the item Search box with results as you type", 9, {
        kind: "item",
        id: "fitm_chat_box",
        name: "Search box with results as you type",
        created: true,
        projectId: "fprj_api",
        number: 14,
      }),
      message("did", "Created the item Rank results by match and recency", 8, {
        kind: "item",
        id: "fitm_chat_rank",
        name: "Rank results by match and recency",
        created: true,
        projectId: "fprj_api",
        number: 15,
      }),
      message(
        "assistant",
        "Done. I created three items in **API Platform**, in the order they'd be built:\n\n1. API-13 Index note titles and bodies\n2. API-14 Search box with results as you type\n3. API-15 Rank results by match and recency\n\nEach starts in the project's first status, so the agent that owns it picks it up now.",
        8,
        { model: "sonnet" },
      ),
    ],
    truncated: false,
    working: false,
    workingRunId: null,
    made: {
      ...EMPTY_MADE,
      items: [
        {
          id: "fitm_chat_index",
          name: "Index note titles and bodies",
          projectId: "fprj_api",
          number: 13,
        },
        {
          id: "fitm_chat_box",
          name: "Search box with results as you type",
          projectId: "fprj_api",
          number: 14,
        },
        {
          id: "fitm_chat_rank",
          name: "Rank results by match and recency",
          projectId: "fprj_api",
          number: 15,
        },
      ],
    },
  },
  fchat_launch: {
    chat: chat("fchat_launch", "Set up a workflow for launch content", 12, "opus"),
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
        "assistant",
        "Done. **Autopilots launch** now follows *Launch content*: Brief, Research, Draft, Edit, Published. Lead researches and Backend drafts; Brief is yours and Edit is Mia's.",
        38,
        { model: "opus" },
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
        "assistant",
        "The app can't post to a blog on its own, so I built a plugin for it. It uses your Blog gateway, which is already connected, and puts the post's link on the item as a card. Want me to try it on a test item?",
        12,
        { model: "opus" },
      ),
    ],
    truncated: false,
    working: false,
    workingRunId: null,
    made: {
      ...EMPTY_MADE,
      workflows: [{ id: "fwf_launch", name: "Launch content" }],
      plugins: [{ id: "fplg_blog", name: "Publish to the blog" }],
    },
  },
  fchat_legal: {
    chat: chat(
      "fchat_legal",
      "Add a legal check before Edit for anything that mentions pricing",
      2,
      "opus",
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
    workingRunId: "frun_chat_legal",
    made: { ...EMPTY_MADE, agents: [{ id: "fagt_legal", name: "Legal" }] },
  },
  fchat_slack: {
    chat: chat(
      "fchat_slack",
      "Tell #launch in Slack whenever a launch item changes status",
      300,
      null,
    ),
    messages: [
      message("person", "Tell #launch in Slack whenever a launch item changes status.", 302),
      message(
        "assistant",
        "I couldn't finish that: The runner stopped responding. Send your message again to have me try once more.",
        300,
        { failed: true, error: "The runner stopped responding." },
      ),
    ],
    truncated: false,
    working: false,
    workingRunId: null,
    made: EMPTY_MADE,
  },
};

// The working chat's run: what it has done so far, still going.
const legalRun = VIEWS.fchat_legal?.messages[0]?.runId ?? "";
if (VIEWS.fchat_legal) VIEWS.fchat_legal.workingRunId = legalRun;
CHAT_RUN_EVENTS[legalRun] = {
  done: false,
  events: [
    ...flow("flow.workflow.list", {}, 2),
    ...flow("flow.workflow.get", { workflowId: "fwf_launch" }, 2),
    note("Launch content has no legal step yet. I'll add a Legal agent, then a status for it.", 2),
    ...flow("flow.agent.create", { name: "Legal" }, 1),
    ...flow("flow.workflow.update", { workflowId: "fwf_launch" }, 1),
  ],
};
// The finished chats' runs: what they did, for "Did N things".
const launch = VIEWS.fchat_launch?.messages ?? [];
CHAT_RUN_EVENTS[launch[0]?.runId ?? ""] = {
  done: true,
  events: [
    ...flow("flow.workflow.list", {}, 39),
    ...flow("flow.agent.list", {}, 39),
    ...flow("flow.workflow.create", { name: "Launch content" }, 39),
    ...flow("flow.project.setWorkflow", { projectId: "fprj_launch" }, 39),
  ],
};
CHAT_RUN_EVENTS[launch[4]?.runId ?? ""] = {
  done: true,
  events: [
    ...flow("flow.gateway.list", {}, 13),
    ...call("mcp__factory__plugin_guide", {}, 13),
    ...call("mcp__factory__plugin_save", { name: "Publish to the blog" }, 13),
  ],
};
const notesRun = VIEWS.fchat_notes?.messages[2]?.runId ?? "";
CHAT_RUN_EVENTS[notesRun] = {
  done: true,
  events: [
    ...flow("flow.project.list", {}, 9),
    ...flow(
      "flow.item.create",
      { projectId: "fprj_api", title: "Index note titles and bodies" },
      9,
    ),
    ...flow("flow.item.create", { projectId: "fprj_api", title: "Search box" }, 9),
    ...flow("flow.item.create", { projectId: "fprj_api", title: "Rank results" }, 8),
  ],
};

/** What the run "does" after a message: its steps arrive, then a did row and its reply. */
function answerLater(view: FlowChatView, runId: string) {
  const run = { done: false, events: [] as FlowRunEvent[] };
  CHAT_RUN_EVENTS[runId] = run;
  view.workingRunId = runId;
  setTimeout(() => {
    run.events.push(...flow("flow.workflow.get", { workflowId: "fwf_launch" }));
  }, 300);
  setTimeout(() => {
    run.events.push(...flow("flow.workflow.update", { workflowId: "fwf_launch" }));
  }, 1200);
  setTimeout(() => {
    view.messages.push(
      message("did", "Changed the workflow Launch content (6 statuses)", 0, {
        kind: "workflow",
        id: "fwf_launch",
        name: "Launch content",
      }),
      message("assistant", "Done. Launch content now has a **Legal** check before Edit.", 0, {
        model: view.chat.model,
      }),
    );
    run.done = true;
    view.working = false;
    view.workingRunId = null;
    view.made = { ...view.made, workflows: [{ id: "fwf_launch", name: "Launch content" }] };
    view.chat.updatedAt = ago(0);
  }, 2500);
}

/** The door answers with a copy, as JSON over the wire would: the app never holds this state. */
const copy = <T>(value: T): T => structuredClone(value);

const say = (
  view: FlowChatView,
  input: { text: string; model?: string | null; effort?: string | null },
): FlowChatView => {
  if (input.model !== undefined) view.chat.model = input.model;
  if (input.effort !== undefined) view.chat.effort = input.effort;
  const sent = message("person", input.text, 0);
  view.messages.push(sent);
  view.working = true;
  view.chat.updatedAt = ago(0);
  answerLater(view, sent.runId ?? "");
  return copy(view);
};

type ChatAnswers = {
  [N in keyof FlowOpMap]?: (input: FlowOpMap[N]["input"]) => FlowOpMap[N]["output"];
};

export const CHAT_ANSWERS: ChatAnswers = {
  "flow.chat.options": () => copy(CHAT_OPTIONS),
  "flow.chat.list": (input) => ({
    chats: Object.values(VIEWS)
      .filter((v) => v.chat.orgId === input.orgId)
      .map((v) => copy(v.chat))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }),
  "flow.chat.get": (input) => copy(VIEWS[input.chatId] ?? (VIEWS.fchat_launch as FlowChatView)),
  "flow.chat.create": (input) => {
    const view: FlowChatView = {
      chat: chat("fchat_new", input.text.slice(0, 80), 0, input.model ?? null),
      messages: [],
      truncated: false,
      working: false,
      workingRunId: null,
      made: copy(EMPTY_MADE),
    };
    view.chat.effort = input.effort ?? null;
    VIEWS.fchat_new = view;
    return say(view, { text: input.text });
  },
  "flow.chat.send": (input) => say(VIEWS[input.chatId] as FlowChatView, input),
  "flow.chat.delete": (input) => {
    delete VIEWS[input.chatId];
    return { deleted: true };
  },
};
