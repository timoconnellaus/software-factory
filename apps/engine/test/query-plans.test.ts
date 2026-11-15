// Every hot path's queries use an index (AGENTS.md, "Cloudflare cost", rule 1): each scenario runs a
// path through the real code against the migrated schema, and fails if any statement it ran plans a
// SCAN of a growing table. To guard another path, add a scenario to HOT_PATHS.
import { env } from "cloudflare:workers";
import { call as callFlow, runDueSchedules } from "@software-factory/ops";
import { httpControlPlane, runnerChannelKey } from "@software-factory/runner-contract";
import {
  addDid,
  agentRuns,
  board,
  chatHistory,
  claimRun,
  createAgent,
  createChat,
  createItem,
  createProject,
  createWorkflow,
  declaredFields,
  enabledPlugins,
  endChatRun,
  expireRuns,
  finishRun,
  gatewayForHost,
  getChat,
  getListedRun,
  getPluginById,
  inbox,
  inboxAll,
  itemRuns,
  listAgents,
  listChats,
  listMembers,
  listProjects,
  listSchedules,
  loadItem,
  pruneRunEvents,
  recentComments,
  renewLease,
  runEventsPage,
  runForToken,
  runView,
  saveSchedule,
  sendMessage,
  storeRunEvents,
  timeline,
} from "@software-factory/store";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { deliverOutbox } from "../src/outbox.ts";
import { pruneExpired } from "../src/retention.ts";
import { MANIFEST, uid, type World, world } from "./helpers.ts";
import { growingScans, type Recorded, recordingEnv } from "./query-plans.ts";

let w: World;

async function channel(e: Env, runnerId: string) {
  return httpControlPlane({
    baseUrl: "https://sf-engine.example",
    runnerId,
    key: await runnerChannelKey("test-channel-secret", runnerId, 1),
    fetch: async (input, init) => worker.fetch(new Request(input, init), e),
  });
}

/** The latest past minute :41, when the hourly prunes run too. */
function minute41(): number {
  const d = new Date();
  d.setUTCMinutes(41, 0, 0);
  return d.getTime() > Date.now() ? d.getTime() - 3_600_000 : d.getTime();
}

const HOT_PATHS: { name: string; run: (e: Env) => Promise<unknown> }[] = [
  {
    // The new core (packages/store, ADR 0660): a runner claims the oldest queued run
    // (flow_runs_queue_idx), renews its lease, finishes it (the item's step), and the cron's sweep
    // fails runs whose lease lapsed (flow_runs_lease_idx).
    name: "the new core: claim a run, renew its lease, finish it, and sweep lapsed leases",
    run: async (e) => {
      const orgId = `org_${crypto.randomUUID()}`;
      const agent = await createAgent(e.DB, { orgId, name: "Writer", instructions: "" });
      const wf = await createWorkflow(e.DB, orgId, {
        name: "Draft, done",
        statuses: [
          { id: "draft", name: "Draft", owner: { kind: "agent", agentId: agent.id } },
          { id: "done", name: "Done", owner: { kind: "none" } },
        ],
      });
      if (!wf.ok) throw new Error("workflow refused");
      const project = await createProject(e.DB, {
        orgId,
        name: "P",
        key: "P",
        workflowId: wf.workflow.id,
      });
      // The claiming runner is the item creator's (claimRun serves only its runner's orgs).
      await e.DB.prepare(
        "INSERT OR IGNORE INTO core_runners (id, owner_user_id, name, created_at) VALUES ('runner_qp', 'u_qp', 'qp', ?)",
      )
        .bind(new Date().toISOString())
        .run();
      const item = await createItem(e.DB, {
        orgId,
        projectId: project.id,
        title: "t",
        body: "",
        createdBy: "u_qp",
      });
      const now = Date.now();
      const run = await claimRun(e.DB, "runner_qp", now, 60_000);
      if (!run) throw new Error("nothing to claim");
      await recentComments(e.DB, item.id, 10);
      await renewLease(e.DB, run.id, "runner_qp", now, 60_000);
      // Milestone 2: the MCP server's token check (by primary key), the plugin host's reads around
      // every item event (the item and its workflow, the org's enabled plugins), a gateway by name,
      // and a trigger's plugin.
      await runForToken(e.DB, run.id);
      await loadItem(e.DB, item.id);
      await enabledPlugins(e.DB, orgId);
      await gatewayForHost(e.DB, undefined, orgId, "blog");
      await getPluginById(e.DB, "fplg_qp");
      // The runner's events for the run view (packages/store run-events.ts): its totals by primary
      // key, then the batch's insert and the guarded update.
      const at = new Date(now).toISOString();
      await storeRunEvents(e.DB, run.id, [
        { type: "message", role: "assistant", text: "Plan.", seq: 1, at },
        { type: "tool", name: "Read", input: '{"file_path":"a.ts"}', id: "t1", seq: 2, at },
        { type: "tool.result", toolId: "t1", output: "ok", seq: 3, at },
      ]);
      await finishRun(e.DB, run.id, run.fencingToken, { outcome: "done", summary: "ok" });
      // The run view, polled while a run is live: the run with its names, and its events after a
      // seq (the primary key).
      await runView(e.DB, run.id);
      await runEventsPage(e.DB, run.id, 1);
      // The cron's prune, every minute: the oldest due run (flow_runs_events_due_idx), then a batch
      // of its events by primary key. 40 days on, so this run is due and every statement runs.
      await pruneRunEvents(e.DB, now + 40 * 86_400_000);
      // The desktop app's polled reads: the board, the inbox and the timeline, each capped.
      await board(e.DB, project.id);
      // And the fields the org's plugins declare, read with every board and item.
      await declaredFields(e.DB, orgId);
      // The inbox, with `done`: the person's finishes and decisions (flow_events_person_done_idx).
      await inbox(e.DB, orgId, "u_qp");
      await timeline(e.DB, item.id);
      // Polled too: the inbox across a person's orgs (their memberships, then each list's arm per
      // org on flow_items_inbox_idx), and the project list's open counts (flow_items_open_idx).
      // u_qp_member is a member of this org, so every arm runs.
      const stamp = new Date().toISOString();
      await e.DB.batch([
        e.DB.prepare(
          "INSERT OR IGNORE INTO core_user (id, name, email, created_at, updated_at) VALUES ('u_qp_member', 'M', 'u_qp_member@example.com', ?, ?)",
        ).bind(stamp, stamp),
        e.DB.prepare(
          "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, 'QP', ?, 'team', ?)",
        ).bind(orgId, orgId, stamp),
        e.DB.prepare(
          "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, 'u_qp_member', 'member', ?)",
        ).bind(`mem_${crypto.randomUUID()}`, orgId, stamp),
      ]);
      await inboxAll(e.DB, "u_qp_member");
      await listProjects(e.DB, orgId);
      // On demand, not polled, but checked all the same: members, agents with what each works on
      // (items waiting on a run, then each one's run by flow_runs_item_idx), an agent's runs
      // (flow_runs_agent_idx), an item's runs and one run.
      await listMembers(e.DB, orgId);
      await listAgents(e.DB, orgId);
      await agentRuns(e.DB, orgId, agent.id, 20);
      await itemRuns(e.DB, item.id);
      await getListedRun(e.DB, run.id);
      // The door's org check for a flow.* call (packages/ops scope.ts), with each kind of id named.
      // u_qp is no member, so each is refused after the one check query, which is what is planned.
      const as = { d1: e.DB, actor: { kind: "person" as const, id: "u_qp" } };
      await callFlow("flow.item.get", { orgId, itemId: item.id }, as);
      await callFlow(
        "flow.project.setWorkflow",
        { orgId, projectId: project.id, workflowId: wf.workflow.id },
        as,
      );
      await callFlow(
        "flow.workflow.create",
        {
          orgId,
          name: "x",
          statuses: [{ id: "a", name: "A", owner: { kind: "agent", agentId: agent.id } }],
        },
        as,
      );
      return expireRuns(e.DB, now, 10);
    },
  },
  {
    // Chat (migrations 0433, 0437): the app polls flow.chat.get while a run is in flight (the chat, its
    // newest messages and its `did` rows by the (chat_id, seq) key, its open run by
    // flow_runs_chat_idx) and reads flow.chat.list (flow_chats_org_idx). A runner claims a chat's
    // run (the queue, then the chat by primary key), its prompt reads the conversation, the MCP
    // server's token check and `did` rows, the hand-back's reply, and the sweep.
    name: "the new core's Chat: poll a chat, list chats, claim and end a chat's run",
    run: async (e) => {
      const orgId = `org_${crypto.randomUUID()}`;
      await e.DB.prepare(
        "INSERT OR IGNORE INTO core_runners (id, owner_user_id, name, created_at) VALUES ('runner_qp', 'u_qp', 'qp', ?)",
      )
        .bind(new Date().toISOString())
        .run();
      const chat = await createChat(e.DB, {
        orgId,
        text: "Set up a workflow.",
        createdBy: "u_qp",
        model: "sonnet",
      });
      await getChat(e.DB, chat.id);
      await listChats(e.DB, orgId);
      const now = Date.now();
      const run = await claimRun(e.DB, "runner_qp", now, 60_000);
      if (!run?.chatId) throw new Error("no chat run to claim");
      await chatHistory(e.DB, chat.id, run.stay, 100);
      await runForToken(e.DB, run.id);
      await addDid(e.DB, {
        chatId: chat.id,
        orgId,
        runId: run.id,
        text: "Created the workflow W",
        data: { kind: "workflow", id: "fwf_qp", name: "W" },
      });
      await getChat(e.DB, chat.id);
      await endChatRun(e.DB, run.id, run.fencingToken, {
        status: "done",
        result: { outcome: "done", summary: "Done." },
      });
      await sendMessage(e.DB, chat.id, "And another.");
      return expireRuns(e.DB, now, 10);
    },
  },
  {
    // The new core's schedules (the Auto screen), from the minute cron: the due query
    // (flow_schedules_due_idx), the claim and the record (by primary key), the item it makes; and
    // the Auto screen's list (flow_schedules_org_idx).
    name: "the new core: the cron fires due schedules, and the Auto screen lists them",
    run: async (e) => {
      const orgId = `org_${crypto.randomUUID()}`;
      const wf = await createWorkflow(e.DB, orgId, {
        name: "One",
        statuses: [{ id: "todo", name: "To do", owner: { kind: "none" } }],
      });
      if (!wf.ok) throw new Error("workflow refused");
      const project = await createProject(e.DB, {
        orgId,
        name: "P",
        key: "P",
        workflowId: wf.workflow.id,
      });
      const now = Date.now();
      await saveSchedule(
        e.DB,
        {
          orgId,
          projectId: project.id,
          name: "Nightly",
          title: "t",
          body: "",
          every: "hour",
          atMinute: 0,
          atHour: null,
          onDay: null,
          timeZone: "UTC",
          enabled: true,
          createdBy: "u_qp",
        },
        now - 2 * 3_600_000,
      );
      await runDueSchedules({ DB: e.DB }, now);
      return listSchedules(e.DB, orgId);
    },
  },
  {
    // The minute cron, on the minute that also runs the hourly prunes.
    name: "the minute cron",
    run: (e) => worker.scheduled({ scheduledTime: minute41(), cron: "* * * * *", noRetry() {} }, e),
  },
  {
    name: "the hourly prunes (retention)",
    run: (e) => pruneExpired(e.DB),
  },
  {
    name: "runner heartbeat (signed channel: authenticate, idempotency, operation)",
    run: async (e) =>
      (await channel(e, w.runner.runnerId)).heartbeat({
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true },
        activeJobs: [{ jobId: "frun_qp_gone", fencingToken: 1 }],
      }),
  },
  {
    name: "a claim with nothing to claim",
    run: async (e) =>
      (await channel(e, w.runner.runnerId)).claim({
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true },
      }),
  },
  {
    // A device revoked: its outbox row delivered after commit (core_outbox by primary key).
    name: "outbox delivery after a commit",
    run: async (e) => {
      const id = `ob_${crypto.randomUUID().replaceAll("-", "")}`;
      await e.DB.prepare(
        "INSERT INTO core_outbox (id, at, kind, payload, next_at) VALUES (?, ?, 'notify', ?, ?)",
      )
        .bind(
          id,
          new Date().toISOString(),
          JSON.stringify({ event: "x", title: "x" }),
          new Date().toISOString(),
        )
        .run();
      return deliverOutbox(e, [id]);
    },
  },
  {
    // The door's sign-in for every call: a desktop token, a phone token, a CLI token (each by hash).
    name: "the client door's token lookup and a read",
    run: async (e) =>
      worker.fetch(
        new Request("https://sf-engine.example/client/v1/call", {
          method: "POST",
          headers: { authorization: "Bearer sfc_nope", "content-type": "application/json" },
          body: JSON.stringify({ op: "org.list", input: {} }),
        }),
        e,
      ),
  },
];

describe("hot-path query plans (AGENTS.md, Cloudflare cost)", () => {
  beforeAll(async () => {
    w = await world();
  });

  it("catches a scan (the guard itself works)", async () => {
    const seen: Recorded[] = [];
    await recordingEnv(env, seen)
      .DB.prepare("SELECT id FROM core_audit a WHERE a.outcome = ? LIMIT 1")
      .bind("ok")
      .first();
    expect(await growingScans(env.DB, seen)).toEqual([
      expect.objectContaining({ table: "core_audit", detail: "SCAN a" }),
    ]);
  });

  it("the inbox's `done` reads the person's events through its partial index, and the event prune its own", async () => {
    const seen: Recorded[] = [];
    const e = recordingEnv(env, seen);
    await inbox(e.DB, "org_qp_done", "u_qp_done");
    await pruneRunEvents(e.DB, Date.now());
    const plan = async (match: RegExp) => {
      const stmt = seen.find((r) => match.test(r.sql));
      if (!stmt) throw new Error(`no statement matching ${match}`);
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`)
        .bind(...stmt.params)
        .all<{ detail: string }>();
      return results.map((r) => r.detail).join("\n");
    };
    expect(await plan(/FROM flow_events\s+WHERE org_id = \?1/)).toMatch(
      /SEARCH flow_events USING INDEX flow_events_person_done_idx \(org_id=\? AND <expr>=\?\)/,
    );
    expect(await plan(/from "flow_runs" where "event_count" > \?/)).toMatch(
      /flow_runs_events_due_idx \(finished_at<\?\)/,
    );
  });

  for (const path of HOT_PATHS) {
    it(`${path.name}: no SCAN of a growing table`, async () => {
      const seen: Recorded[] = [];
      await path.run(recordingEnv(env, seen));
      expect(seen.length).toBeGreaterThan(0);
      expect(await growingScans(env.DB, seen)).toEqual([]);
    });
  }
});
