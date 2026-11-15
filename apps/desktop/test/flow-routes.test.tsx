// The new core's board and item panel through the real router (spec 70), on the fixture door's flow
// fixtures (screenshots/flow-fixtures.ts): the board's columns and chips, the timeline told as one
// line per move with comments, summaries and rich cards, the decision card last with the right
// buttons, and a stopped item's error with Retry. Which operation each button sends is pinned in
// packages/client/test/flow.test.ts and clicked through in screenshots/behave.mjs.
import type { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import { OwnerMark } from "../src/mainview/components/flow/parts.tsx";
import {
  flowItemQuery,
  flowItemRunsQuery,
  flowRunQuery,
  flowTimelineQuery,
  flowWorkflowQuery,
} from "../src/mainview/lib/flow-queries.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const ORG = "org_personal";
const BOARD = `/flow/${ORG}/p/fprj_api`;

/** The panel loads inside itself; a test reads what it would show once loaded. */
const loaded = (itemId: string) => async (client: QueryClient) => {
  await Promise.all([
    client.prefetchQuery(flowItemQuery(ORG, itemId)),
    client.prefetchQuery(flowTimelineQuery(ORG, itemId)),
    client.prefetchQuery(flowWorkflowQuery(ORG, "fwf_ship")),
  ]);
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the shell", () => {
  it("has the org's sections, its projects and Settings, and no status bar", async () => {
    const html = await renderPage(BOARD);
    const text = textOf(html);
    expect(html).toContain('data-testid="flow-shell"');
    expect(html).not.toContain('data-testid="status-bar"');
    expect(text).toContain("Inbox 3 Work Chat Team Auto Plugins Projects");
    expect(text).toContain("API Platform 12 Autopilots launch");
    expect(text).toContain("Settings");
    expect(text).not.toContain("Old factory");
  });

  it("counts a project's open items once the server gives them", async () => {
    const text = textOf(
      await renderPage(BOARD, {
        answers: {
          "flow.project.list": (input) => ({
            projects: (
              ANSWERS["flow.project.list"]?.(input as { orgId: string })?.projects ?? []
            ).map((p) => ({ ...p, openCount: p.id === "fprj_api" ? 7 : 0 })),
          }),
        },
      }),
    );
    expect(text).toContain("API Platform 7 Autopilots launch");
  });
});

describe("the board", () => {
  it("has a column per status with its count and owner, and the workflow's name", async () => {
    const html = await renderPage(BOARD);
    const text = textOf(html);
    expect(count(html, 'data-testid="board-column"')).toBe(5);
    expect(text).toContain(
      "API Platform Board List Workflow Settings Ship a feature · used by 2 projects acme/api",
    );
    expect(text).toContain("Spec 1 L Lead");
    expect(text).toContain("Build 2 B Backend");
    expect(text).toContain("Approve 2 O owner");
    expect(text).toContain("Shipped 1 Nobody");
  });

  it("shows each card's key, chip, title, owner and time", async () => {
    const html = await renderPage(BOARD);
    const text = textOf(html);
    expect(count(html, 'data-testid="board-card"')).toBe(8);
    expect(text).toContain(
      "API-12 Working Move auth webhooks onto the job queue B Backend 14m ago",
    );
    expect(text).toContain("API-10 Needs you Add rate limiting to the public API O owner just now");
    expect(text).toContain("API-9 Needs you Paginate the audit log endpoint");
    expect(text).toContain("API-8 Stopped Upgrade the Postgres driver to v5");
    expect(count(html, 'data-testid="chip-working"')).toBe(3);
    expect(count(html, 'data-testid="chip-needs-you"')).toBe(3);
  });

  it("lists the same items as a table on List", async () => {
    const html = await renderPage(`${BOARD}?view=list`);
    expect(count(html, 'data-testid="list-row"')).toBe(8);
    expect(html).not.toContain('data-testid="board"');
  });

  it("shows an empty project as one line and the + button", async () => {
    const html = await renderPage(`/flow/${ORG}/p/fprj_launch`);
    expect(textOf(html)).toContain("No items yet. New item");
    expect(html).not.toContain('data-testid="board-column"');
  });
});

describe("runs", () => {
  it("shows the run line under an agent's summary: time, steps and Open run", async () => {
    const html = await renderPage(`${BOARD}?item=fitm_rate`, {
      after: async (client) => {
        await loaded("fitm_rate")(client);
        await client.prefetchQuery(flowItemRunsQuery(ORG, "fitm_rate"));
      },
    });
    // Lead's, Backend's and QA's summaries each carry their run.
    expect(count(html, 'data-testid="run-line"')).toBe(3);
    const text = textOf(html);
    expect(text).toContain("Limiter and tests are in.");
    expect(text).toContain("15m 3s 13 steps Open run");
    // No runner reports cost: none is shown, never made up.
    expect(text).not.toContain("$");
    expect(html).toContain("run=frun_fitm_rate");
  });

  it("opens a run over the page from ?run=: its status, agent, item and summary", async () => {
    const html = await renderPage(`${BOARD}?run=frun_fitm_rate`, {
      after: (client) => client.prefetchQuery(flowRunQuery(ORG, "frun_fitm_rate")).then(() => {}),
    });
    expect(html).toContain('data-testid="run-modal"');
    expect(html).toContain('data-testid="board"');
    const text = textOf(html);
    expect(text).toContain("Finished B Backend on API-10 Add rate limiting to the public API");
    expect(text).toContain("Started by entering Build Took 15m 3s Runner M5 Steps 13");
    expect(text).not.toContain("Cost");
  });

  it("shows a failed run's error at the top", async () => {
    const html = await renderPage(`/flow/${ORG}/team?run=frun_fitm_postgres`, {
      after: (client) =>
        client.prefetchQuery(flowRunQuery(ORG, "frun_fitm_postgres")).then(() => {}),
    });
    expect(textOf(html)).toContain("Failed B Backend on API-8");
    expect(html).toContain('data-testid="run-error"');
    expect(textOf(html)).toContain("ENOSPC");
  });

  it("a summary whose run isn't among the item's runs keeps just Open run", async () => {
    // The item's runs aren't read: as for a chat's run, or one the list doesn't have.
    const html = await renderPage(`${BOARD}?item=fitm_rate`, { after: loaded("fitm_rate") });
    expect(count(html, 'data-testid="run-line"')).toBe(3);
    expect(textOf(html)).not.toContain("steps Open run");
    expect(count(html, ">Open run<")).toBe(3);
  });

  it("a run that can't be read says so in the run view", async () => {
    const html = await renderPage(`${BOARD}?run=frun_gone`, {
      after: (client) => client.prefetchQuery(flowRunQuery(ORG, "frun_gone")).then(() => {}),
    });
    expect(html).toContain('data-testid="run-modal"');
    expect(textOf(html)).toContain("Couldn't load this run. No run frun_gone in this org.");
  });
});

describe("the item panel", () => {
  it("tells each move as one line, then comments, summaries and rich cards", async () => {
    const html = await renderPage(`${BOARD}?item=fitm_rate`, { after: loaded("fitm_rate") });
    const text = textOf(html);
    expect(text).toContain("API Platform › API-10");
    expect(text).toContain("owner created this item ↳ Handed to Lead, who started a run");
    expect(text).toContain(
      "Lead moved it from Spec to Build ↳ Handed to Backend, who started a run",
    );
    expect(text).toContain("owner approved it from Review to Approve ↳ Waiting on you");
    // Five moves, each one line: the kernel's events and effects are never shown apart.
    expect(count(html, 'data-testid="timeline-line"')).toBe(5);
    for (const raw of ["run.start", "run.ended", "entered", "inbox.add", "decision.ask"])
      expect(text).not.toContain(raw);
    // The summary and its card, from the agent; a person's comment; the rich cards' parts.
    expect(text).toContain("Lead 2h ago Here is the plan. Build plan 3 steps");
    expect(text).toContain("I'll check the 429 copy before this ships.");
    expect(count(html, 'data-testid="rich-card"')).toBe(3);
    expect(count(html, 'data-testid="rich-check"')).toBe(3);
    expect(count(html, 'data-testid="rich-bar"')).toBe(3);
  });

  it("marks a plugin's entry with the plugin mark, not a letter", () => {
    const html = renderToStaticMarkup(<OwnerMark name="software" kind="plugin" />);
    expect(html).toContain('data-kind="plugin"');
    expect(html).toContain("lucide-puzzle");
    expect(textOf(html)).toBe("");
  });

  it("ends with the decision card for a status the person owns: Done and Send back", async () => {
    const html = await renderPage(`${BOARD}?item=fitm_rate`, { after: loaded("fitm_rate") });
    expect(html).toContain('data-testid="waiting-on-you"');
    const timeline = html.slice(html.indexOf('data-testid="timeline"'));
    const lastEntry = Math.max(
      timeline.lastIndexOf('data-testid="timeline-line"'),
      timeline.lastIndexOf('data-testid="timeline-comment"'),
      timeline.lastIndexOf('data-testid="timeline-agent"'),
    );
    expect(timeline.indexOf('data-testid="decision-card"')).toBeGreaterThan(lastEntry);
    expect(textOf(timeline)).toContain(
      "Approve is yours Done moves it to Shipped; Send back moves it to Review. Done Send back",
    );
  });

  it("ends with Approve and Reject for an item waiting on a decision", async () => {
    const html = await renderPage(`${BOARD}?item=fitm_audit`, { after: loaded("fitm_audit") });
    expect(html).toContain('data-kind="decision"');
    expect(textOf(html)).toContain(
      "Approve Review? Approve moves it to Approve; Reject moves it to Build. Approve Reject",
    );
  });

  it("shows a stopped item's error once, with Retry, and no decision", async () => {
    const html = await renderPage(`${BOARD}?item=fitm_postgres`, {
      after: loaded("fitm_postgres"),
    });
    const text = textOf(html);
    expect(html).toContain('data-testid="item-stopped"');
    expect(count(text, "ran out of disk")).toBe(1);
    expect(text).toContain("Backend couldn't finish Build ↳ Stopped until someone retries it");
    expect(text).toContain("Retry");
    expect(html).not.toContain('data-testid="decision-card"');
    expect(html).not.toContain('data-testid="waiting-on-you"');
  });

  it("opens as a full page with its properties", async () => {
    const html = await renderPage(`/flow/${ORG}/p/fprj_api/i/fitm_rate`, {
      after: loaded("fitm_rate"),
    });
    const text = textOf(html);
    expect(html).toContain('data-testid="item-page"');
    expect(text).toContain(
      "Properties Status Approve Owner owner Project API Platform Workflow Ship a feature",
    );
    expect(html).toContain('data-testid="decision-card"');
  });
});
