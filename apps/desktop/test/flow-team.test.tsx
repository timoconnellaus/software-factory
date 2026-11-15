// Team, Settings and All orgs through the real router (spec 70, .kim/mockups/team-an-agent.html,
// all-orgs.html), on the fixture door; the reads the server is still adding (`flow.member.list`,
// `flow.inbox.all`, `flow.run.list` by agent) refused as an older server refuses them; and the app
// with the old screens gone. What the agent buttons send is clicked through in screenshots/behave.mjs.
import type { FlowAgent } from "@software-factory/client/flow";
import { personName } from "@software-factory/client/flow";
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { agentUpdate, runnerRows, runOutcome } from "../src/mainview/lib/team.ts";
import { routeTree } from "../src/mainview/router.tsx";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const ORG = "org_personal";
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** A server without the operations being added: each refuses as an unknown operation does. */
const OLDER_SERVER = {
  "flow.member.list": { error: "unknown operation flow.member.list" },
  "flow.inbox.all": { error: "unknown operation flow.inbox.all" },
  "flow.run.list": { error: "invalid input: itemId is required" },
} as const;

describe("Team: Agents", () => {
  it("lists the org's agents with what each is doing now", async () => {
    const html = await renderPage(`/flow/${ORG}/team`);
    const text = textOf(html);
    expect(text).toContain("Team Agents Runners People New agent");
    // Lead, Backend and QA, and Chat's Builder (chat-fixtures.ts).
    expect(count(html, 'data-testid="agent-row"')).toBe(4);
    expect(text).toContain("Lead Working · API-5");
    expect(text).toContain("Backend Working · API-12");
    expect(text).toContain("QA Working · API-11");
  });

  it("shows the chosen agent: instructions to edit, what it runs now, its recent runs", async () => {
    const html = await renderPage(`/flow/${ORG}/team?agent=fagt_backend`);
    const page = textOf(html.slice(html.indexOf('data-testid="agent-page"')));
    expect(page).toContain("Backend Instructions");
    expect(html).toContain("Backend engineer. Take a feature from migration");
    expect(page).toContain("Now Running API-12 Move auth webhooks onto the job queue Open");
    expect(page).toContain("Recent work");
    expect(count(html, 'data-testid="agent-run"')).toBe(4);
    expect(page).toContain("Upgrade the Postgres driver to v5 The run's sandbox ran out of disk");
    expect(page).toContain("Add rate limiting to the public API Succeeded");
  });

  it("has the Plugin editor switch, on for an agent whose mcp has factory, off otherwise", async () => {
    const on = await renderPage(`/flow/${ORG}/team?agent=fagt_backend`);
    expect(textOf(on)).toContain(
      "Tools Plugin editor Lets this agent set up workflows and build plugins.",
    );
    const state = (html: string) =>
      /data-state="(\w+)"/.exec(html.slice(html.indexOf('id="plugin-editor"')))?.[1];
    expect(state(on)).toBe("checked");
    const off = await renderPage(`/flow/${ORG}/team?agent=fagt_qa`);
    expect(state(off)).toBe("unchecked");
  });

  it("on an older server: no 'doing now', no Recent work, and no error", async () => {
    const html = await renderPage(`/flow/${ORG}/team?agent=fagt_backend`, {
      answers: OLDER_SERVER,
    });
    const text = textOf(html);
    expect(text).toContain("Backend Instructions");
    expect(text).not.toContain("Working ·");
    expect(text).not.toContain("Recent work");
    expect(html).not.toContain('data-testid="app-error"');
  });
});

describe("Team: Runners and People", () => {
  it("tells each runner simply: seen, working on, new work, code", async () => {
    const html = await renderPage(`/flow/${ORG}/team?tab=runners`);
    const text = textOf(html);
    expect(count(html, 'data-testid="runner-row"')).toBe(3);
    expect(text).toContain("M5 Online 3 jobs Takes new work Up to date");
    expect(text).toContain("M1 Online Nothing Takes new work Updating");
    expect(text).toContain("Mac mini Last seen 1d ago Nothing Not now: offline Up to date");
    expect(text).not.toMatch(/heavy|light \d/i);
    expect(text).toContain("Settings › This Mac");
  });

  it("lists the org's members by name", async () => {
    const text = textOf(await renderPage(`/flow/${ORG}/team?tab=people`));
    expect(text).toContain("owner You");
    expect(text).toContain("Mia Chen @mia");
  });
});

describe("Settings", () => {
  it("This Mac: the account, the key, the runner in plain words, the app and its updates", async () => {
    const html = await renderPage(`/flow/${ORG}/settings`);
    const text = textOf(html);
    expect(text).toContain("Settings This Mac Members");
    expect(text).toContain("Account Signed in as @owner on this Mac. Sign out");
    expect(text).toContain("This Mac's key");
    expect(text).toContain("Runner on this Mac");
    expect(html).toContain('data-testid="updates"');
    expect(text).toContain("The org's workflows are in Workflows");
    expect(html).toContain('href="/flow/org_personal/workflows"');
  });

  it("Members: the org's people; on an older server, you alone and a line saying so", async () => {
    const text = textOf(await renderPage(`/flow/${ORG}/settings?tab=members`));
    expect(text).toContain("Mia Chen");
    const older = textOf(
      await renderPage(`/flow/${ORG}/settings?tab=members`, { answers: OLDER_SERVER }),
    );
    expect(older).toContain("owner You");
    expect(older).toContain("once the server lists members");
  });
});

describe("All orgs", () => {
  it("lists what needs you across orgs with Open, what is working, and each org's counts", async () => {
    const html = await renderPage("/flow/orgs");
    const text = textOf(html);
    expect(text).toContain("Everything 4 working 4 need you");
    expect(count(html, 'data-testid="need-row"')).toBe(4);
    expect(count(html, 'data-testid="open-item"')).toBe(4);
    // Each reads as the Inbox's question (flow-edit's inboxQuestion).
    expect(text).toContain(
      "Approve: Add rate limiting to the public API Personal · API Platform · API-10 Open",
    );
    expect(text).toContain(
      "Decide: Paginate the audit log endpoint Personal · API Platform · API-9",
    );
    expect(text).toContain(
      "Approve: Invoice footer shows the old address Client · Website · WEB-31",
    );
    expect(html).toContain('href="/flow/org_client/p/fprj_site?item=fitm_footer"');
    expect(count(html, 'data-testid="working-row"')).toBe(4);
    expect(text).toContain(
      "Booking page loads slowly on phones Client · Website · Build · Builder",
    );
    expect(text).toContain("Personal 2 projects");
    expect(text).toContain("3 working · 3 need you");
    expect(text).toContain("Client 1 project");
    expect(text).toContain("1 working · 1 needs you");
  });

  it("on an older server: the empty lines and the orgs, never an error", async () => {
    const html = await renderPage("/flow/orgs", { answers: OLDER_SERVER });
    const text = textOf(html);
    expect(text).toContain("Nothing needs you in any org.");
    expect(text).toContain("No agent is working right now.");
    expect(text).toContain("Personal 2 projects");
    expect(html).not.toContain('data-testid="app-error"');
  });
});

describe("the app is the new shell", () => {
  it("has no old routes left", () => {
    const paths = Object.keys(routeTree.children ?? {});
    const all: string[] = [];
    const walk = (r: { fullPath?: string; children?: unknown }) => {
      if (r.fullPath) all.push(r.fullPath);
      const kids = r.children as Record<string, typeof r> | (typeof r)[] | undefined;
      for (const k of Array.isArray(kids) ? kids : Object.values(kids ?? {})) walk(k);
    };
    walk(routeTree as unknown as { children?: unknown });
    expect(paths.length).toBeGreaterThan(0);
    for (const p of all) expect(p === "/" || p.startsWith("/flow"), p).toBe(true);
    for (const old of ["/work", "/factory", "/settings", "/setup", "/new", "/attach"])
      expect(
        all.some((p) => p === old || p.startsWith(`${old}/`)),
        old,
      ).toBe(false);
  });

  it("names people by the member list, and anyone it doesn't list as a teammate", () => {
    const names = {
      me: { id: "usr_owner", name: "owner" },
      agents: [],
      members: [{ userId: "usr_mia", name: "Mia Chen" }],
    };
    expect(personName(names, "usr_mia")).toBe("Mia Chen");
    expect(personName(names, "usr_owner")).toBe("owner");
    expect(personName(names, "usr_gone")).toBe("A teammate");
  });
});

describe("Team's wording", () => {
  const agent: Pick<FlowAgent, "id" | "name" | "instructions" | "mcp"> = {
    id: "fagt_qa",
    name: "QA",
    instructions: "Check it.",
  };

  it("sends the whole agent to flow.agent.update, with mcp for the Plugin editor", () => {
    expect(agentUpdate("org_a", agent, { pluginEditor: true })).toEqual({
      orgId: "org_a",
      agentId: "fagt_qa",
      name: "QA",
      instructions: "Check it.",
      mcp: ["factory"],
    });
    expect(
      agentUpdate("org_a", { ...agent, mcp: ["factory"] }, { pluginEditor: false }).mcp,
    ).toEqual([]);
    // A missing mcp reads as off, and an instructions edit keeps the tools as they are.
    expect(agentUpdate("org_a", agent, { instructions: "New." })).toMatchObject({
      instructions: "New.",
      mcp: [],
    });
    expect(
      agentUpdate("org_a", { ...agent, mcp: ["factory"] }, { instructions: "New." }).mcp,
    ).toEqual(["factory"]);
  });

  it("words a run's outcome", () => {
    const base = { itemId: "i", claimedAt: null, finishedAt: null, error: null };
    expect(runOutcome({ ...base, status: "claimed" }).text).toBe("Running");
    expect(runOutcome({ ...base, status: "done" })).toEqual({ ok: true, text: "Succeeded" });
    expect(runOutcome({ ...base, status: "done", result: { outcome: "rejected" } }).text).toBe(
      "Sent back",
    );
    expect(runOutcome({ ...base, status: "failed", error: "boom" })).toEqual({
      ok: false,
      text: "boom",
    });
  });

  it("tells a runner online from its last report when the health line is missing", () => {
    const listed = ANSWERS["runner.list"]?.({})?.runners ?? [];
    const rows = runnerRows(listed, []);
    expect(rows.map((r) => r.online)).toEqual([true, true, false]);
    expect(rows[2]?.takesWork).toEqual({ yes: false, why: "offline" });
    expect(rows[1]?.code).toEqual({ current: false, text: "Updating" });
  });
});
