// The inbox, the workflow editor, the Workflows list, plugins, gateways and plugin fields through
// the real router (spec 70), on the fixture door's flow fixtures (screenshots/flow-fixtures.ts).
// What each button sends is clicked through in screenshots/behave.mjs; the edits' logic is pinned
// in packages/client/test/flow-edit.test.ts.
import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { flowPluginQuery, orEmpty } from "../src/mainview/lib/flow-edit-queries.ts";
import {
  flowItemQuery,
  flowTimelineQuery,
  flowWorkflowQuery,
} from "../src/mainview/lib/flow-queries.ts";
import { OpError } from "../src/mainview/lib/op.ts";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const ORG = "org_personal";
const count = (html: string, needle: string) => html.split(needle).length - 1;

/** The inbox's chosen item loads inside itself; a test reads what it shows once loaded. */
const loaded = (itemId: string) => async (client: QueryClient) => {
  await Promise.all([
    client.prefetchQuery(flowItemQuery(ORG, itemId)),
    client.prefetchQuery(flowTimelineQuery(ORG, itemId)),
    client.prefetchQuery(flowWorkflowQuery(ORG, "fwf_ship")),
  ]);
};

describe("the inbox", () => {
  it("lists what needs the person with its question, key and age, counted in the tab", async () => {
    const html = await renderPage(`/flow/${ORG}/inbox`, { after: loaded("fitm_rate") });
    const text = textOf(html);
    expect(count(html, 'data-testid="inbox-row"')).toBe(3);
    expect(text).toContain("Inbox Needs you · 3 Done");
    expect(text).toContain(
      "Approve: Add rate limiting to the public API API-10 · API Platform just now",
    );
    expect(text).toContain("Decide: Paginate the audit log endpoint API-9 · API Platform 1h");
  });

  it("puts the decision first, then the last few cards that led to it, newest first", async () => {
    const html = await renderPage(`/flow/${ORG}/inbox?item=fitm_rate`, {
      after: loaded("fitm_rate"),
    });
    const detail = html.slice(html.indexOf('data-testid="inbox-item"'));
    const decision = detail.indexOf('data-testid="decision-card"');
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeLessThan(detail.indexOf('data-testid="led-here"'));
    const led = textOf(detail.slice(detail.indexOf('data-testid="led-here"')));
    // Newest first: the person's comment, then the move that brought it to them.
    expect(led.indexOf("I'll check the 429 copy")).toBeLessThan(
      led.indexOf("owner approved it from Review to Approve"),
    );
    expect(led).toContain("Show the whole timeline (6 earlier)");
    expect(textOf(detail)).toContain("Approve is yours Done moves it to Shipped");
  });

  it("is one quiet line when nothing needs the person", async () => {
    const html = await renderPage(`/flow/${ORG}/inbox`, {
      answers: { "flow.inbox.get": { result: { work: [], decisions: [], truncated: false } } },
    });
    expect(textOf(html)).toContain("Needs you · 0 Done Nothing needs you.");
    expect(html).not.toContain('data-testid="inbox-list"');
  });
});

describe("the workflow editor", () => {
  const TAB = `/flow/${ORG}/p/fprj_api?view=workflow`;

  it("is the project's third tab: the statuses as boxes in order, with + at the end", async () => {
    const html = await renderPage(TAB);
    const text = textOf(html);
    expect(text).toContain(
      "API Platform Board List Workflow Settings Ship a feature · used by 2 projects",
    );
    expect(text).toContain("All workflows");
    expect(count(html, 'data-testid="status-box"')).toBe(5);
    expect(text).toContain("Review Q QA Needs a decision");
    expect(html).toContain('data-testid="add-status"');
    expect(html).not.toContain('data-testid="board"');
  });

  it("opens the first status's editor, and says plainly what else the workflow changes", async () => {
    const html = await renderPage(TAB);
    const text = textOf(html);
    // The selects' values draw once mounted (Radix), so a rendered page shows their labels.
    expect(text).toContain(
      "Spec Name On entering, hand to Brief When done, move to If rejected, send back to Needs a person's decision Move left Move right Remove",
    );
    expect(text).toContain("Also changes: Autopilots launch Make a copy for this project");
    // Status ids are never shown.
    expect(text).not.toContain("fwf_ship");
  });

  it("lists every workflow with its statuses as dots and the projects on it", async () => {
    const html = await renderPage(`/flow/${ORG}/workflows`);
    const text = textOf(html);
    expect(count(html, 'data-testid="workflow-row"')).toBe(1);
    expect(text).toContain("Ship a feature 5 statuses API Platform, Autopilots launch");
    expect(text).toContain("New workflow");
  });

  it("opens one from the list in the same editor, with its name", async () => {
    const html = await renderPage(`/flow/${ORG}/workflows?workflow=fwf_ship`);
    expect(textOf(html)).toContain("Workflows › Ship a feature");
    expect(html).toContain('data-testid="workflow-editor"');
    expect(html).toContain('id="workflow-name"');
    expect(textOf(html)).toContain("Used by API Platform, Autopilots launch.");
  });
});

describe("plugins and gateways", () => {
  it("lists each plugin with the request in the person's words, its switch and last error", async () => {
    const html = await renderPage(`/flow/${ORG}/plugins`);
    const text = textOf(html);
    expect(count(html, 'data-testid="plugin-row"')).toBe(3);
    expect(count(html, 'data-testid="plugin-switch"')).toBe(3);
    expect(text).toContain("“Tell #launch in Slack whenever a launch item changes status.”");
    expect(text).toContain("Slack said the channel #launch wasn't found");
    // The ask box isn't wired yet: plugins are built in Chat.
    expect(text).toContain("Plugins are built in Chat");
  });

  it("opens a plugin's code read-only, with Delete", async () => {
    const html = await renderPage(`/flow/${ORG}/plugins?plugin=fplg_slack`, {
      after: async (client) => {
        await client.prefetchQuery(flowPluginQuery(ORG, "Slack updates"));
      },
    });
    expect(html).toContain('data-testid="plugin-code"');
    expect(textOf(html)).toContain("export default definePlugin");
    expect(html).toContain('data-testid="delete-plugin"');
    expect(html).not.toContain("<textarea");
  });

  it("lists gateways with their base URL, auth and whether they are connected", async () => {
    const html = await renderPage(`/flow/${ORG}/plugins?tab=gateways`);
    const text = textOf(html);
    expect(count(html, 'data-testid="gateway-row"')).toBe(4);
    expect(text).toContain("GitHub https://api.github.com Bearer token Connected");
    expect(text).toContain("Blog https://acme.example/blog/api Header X-Api-Key Connected");
    expect(text).toContain("Stripe https://api.stripe.com Bearer token Needs a secret");
  });

  it("treats an engine without the plugin operations as having none", async () => {
    await expect(
      orEmpty(Promise.reject(new OpError("unknown_operation", "No operation")), { plugins: [] }),
    ).resolves.toEqual({ plugins: [] });
    await expect(
      orEmpty(Promise.reject(new OpError("unavailable", "down")), { plugins: [] }),
    ).rejects.toThrow("down");
  });
});

describe("plugin fields", () => {
  it("shows an item's fields on its card as quiet chips under the title", async () => {
    const text = textOf(await renderPage(`/flow/${ORG}/p/fprj_api`));
    expect(text).toContain("Paginate the audit log endpoint Customer: Northwind Priority: High");
    expect(text).toContain("Per-key usage page Customer: Acme");
  });

  it("shows them among the panel's property pills", async () => {
    const html = await renderPage(`/flow/${ORG}/p/fprj_api?item=fitm_audit`, {
      after: loaded("fitm_audit"),
    });
    const props = textOf(html.slice(html.indexOf('data-testid="item-props"')));
    expect(props).toContain("Review Q QA API Platform Customer: Northwind Priority: High");
  });
});
