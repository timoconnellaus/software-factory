// Auto through the real router (spec 70, .kim/mockups/auto-schedules.html), on the fixture door's
// schedules (screenshots/flow-auto-fixtures.ts). What each button sends is clicked through in
// screenshots/behave.mjs; the plain words are pinned in packages/client/test/flow-auto.test.ts.
import { describe, expect, it, vi } from "vitest";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Auto", () => {
  it("lists the schedules: when, project, what it makes, next, last, and a switch", async () => {
    const html = await renderPage("/flow/org_personal/auto");
    const text = textOf(html);
    expect(text).toContain("Auto Schedules Triggers New");
    expect(text).toContain("Name When Project Makes Next Last");
    expect(count(html, 'data-testid="schedule-row"')).toBe(5);
    expect(count(html, 'data-testid="schedule-switch"')).toBe(5);
    expect(text).toContain("Nightly triage Every day at 02:00 API Platform");
    expect(text).toContain("Flaky tests Every hour at :15 API Platform Look for flaky tests");
    expect(text).toContain("Dependency bumps Mondays at 09:00");
    expect(text).toContain("Made API-5");
    expect(text).toContain(
      "Weekly digest Fridays at 17:00 A deleted project Write the weekly digest",
    );
    expect(text).toContain("Failed: Its project no longer exists.");
    expect(text).toContain("Launch checklist Weekdays at 08:30 Autopilots launch");
    expect(text).toMatch(/Run the launch checklist Off Not run yet/);
    expect(html).toContain('data-enabled="false"');
  });

  it("is one quiet explanation when the org has no schedules", async () => {
    const html = await renderPage("/flow/org_client/auto");
    expect(html).toContain('data-testid="schedules-empty"');
    expect(textOf(html)).toContain("No schedules yet.");
    expect(html).not.toContain('data-testid="schedule-table"');
  });

  it("reads an engine without schedules as none, and a failed read as an error", async () => {
    const none = await renderPage("/flow/org_personal/auto", {
      answers: { "flow.schedule.list": { result: { schedules: [] } } },
    });
    expect(none).toContain('data-testid="schedules-empty"');
    const failed = await renderPage("/flow/org_personal/auto", {
      answers: { "flow.schedule.list": { error: "The engine is down." } },
    });
    expect(textOf(failed)).toContain("Couldn't load the schedules.");
  });

  it("Triggers lists each plugin's trigger URL to copy, and points at Plugins", async () => {
    const html = await renderPage("/flow/org_personal/auto?tab=triggers");
    expect(textOf(html)).toContain("Triggers come from plugins");
    // Only the plugin that defines a trigger, its URL on the engine this app talks to.
    expect(html.split('data-testid="trigger-row"').length - 1).toBe(1);
    expect(textOf(html).replaceAll("&lt;", "<").replaceAll("&gt;", ">")).toContain(
      "Customers on feedback https://sf-engine.example/flow/triggers/fplg_customer/<name>?key=5f1c9a0e",
    );
    expect(html).toContain('data-testid="copy-trigger"');
    expect(html).toContain('href="/flow/org_personal/plugins"');
    expect(html).not.toContain('data-testid="new-schedule"');
  });

  it("Triggers is one line when no plugin defines a trigger", async () => {
    const html = await renderPage("/flow/org_personal/auto?tab=triggers", {
      answers: { "flow.plugin.list": { result: { plugins: [] } } },
    });
    expect(html).not.toContain('data-testid="trigger-list"');
    expect(textOf(html)).toContain("None of yours has one yet.");
  });
});
