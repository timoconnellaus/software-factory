// Settings' Repositories, Connections and Devices through the real router (spec 41, slice 6): a
// skeleton while a read is out, the error with Retry when it failed, the empty message only on a
// successful empty read; and Devices offers Revoke only once it knows which row is this Mac.
import { describe, expect, it, vi } from "vitest";
import { renderPage, textOf } from "./route-harness.tsx";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

const PENDING = 'data-testid="read-pending"';
const ERROR = 'data-testid="read-error"';
const failed = { error: "the factory isn't reachable" };
const noSetup = (input: unknown) => ({
  complete: false,
  steps: [],
  installations: [],
  projects: [],
  missingEvents: [],
  runners: { total: 0, online: 0 },
  orgId: (input as { orgId: string }).orgId,
});

describe("Repositories", () => {
  it("shows a skeleton while Setup's check loads", async () => {
    const html = await renderPage("/settings/repositories", { pending: [["setup"]] });
    expect(html).toContain(PENDING);
    expect(textOf(html)).not.toContain("No repositories yet");
  });

  it("shows the error with Retry when a read failed", async () => {
    const html = await renderPage("/settings/repositories", {
      answers: { "setup.status": failed },
    });
    expect(html).toContain(ERROR);
    expect(textOf(html)).toContain("Couldn't load the repositories.");
    expect(textOf(html)).not.toContain("No repositories yet");
  });

  it("says there are none only when the projects have none", async () => {
    const text = textOf(
      await renderPage("/settings/repositories", {
        answers: { "project.list": { result: { projects: [] } } },
      }),
    );
    expect(text).toContain("No repositories yet.");
  });

  it("names the branch in the protection header and shows the check's result", async () => {
    const text = textOf(await renderPage("/settings/repositories"));
    expect(text).toContain("Protection on main");
    expect(text).toContain("example/software-factory main Not protected");
  });
});

describe("Connections", () => {
  it("shows a skeleton, not 'GitHub isn't connected', while Setup's status loads", async () => {
    const html = await renderPage("/settings/connections", { pending: [["setup"]] });
    expect(html).toContain(PENDING);
    expect(textOf(html)).not.toContain("GitHub isn't connected");
  });

  it("shows the error with Retry when the read failed", async () => {
    const html = await renderPage("/settings/connections", { answers: { "setup.status": failed } });
    expect(html).toContain(ERROR);
    expect(textOf(html)).not.toContain("GitHub isn't connected");
  });

  it("says GitHub isn't connected only when Setup said so", async () => {
    const text = textOf(
      await renderPage("/settings/connections", { answers: { "setup.status": noSetup } }),
    );
    expect(text).toContain("GitHub isn't connected. Connect it in Setup");
  });

  it("counts the installation's own repositories", async () => {
    const text = textOf(await renderPage("/settings/connections"));
    expect(text).toContain("1 repository is in the factory.");
  });
});

describe("Devices", () => {
  it("shows a skeleton while the devices load", async () => {
    const html = await renderPage("/settings/devices", { pending: [["devices"]] });
    expect(html).toContain(PENDING);
    expect(textOf(html)).not.toContain("No devices");
  });

  it("shows the error with Retry when the read failed", async () => {
    const html = await renderPage("/settings/devices", { answers: { "cliToken.list": failed } });
    expect(html).toContain(ERROR);
    expect(textOf(html)).toContain("Couldn't load your devices.");
  });

  it("says there are none only when the reads answered empty", async () => {
    const text = textOf(
      await renderPage("/settings/devices", {
        answers: {
          "desktopDevice.list": { result: { devices: [] } },
          "cliToken.list": { result: { tokens: [] } },
        },
      }),
    );
    expect(text).toContain("No devices.");
  });

  it("lists each Mac once and never offers to revoke this one", async () => {
    const html = await renderPage("/settings/devices");
    const text = textOf(html);
    expect(text.match(/Desktop app on M5/g)).toHaveLength(1);
    expect(text).not.toMatch(/sf CLI: M5(?! terminal)/);
    expect(text).toContain("sf CLI: M5 terminal");
    expect(text).toContain("Proves it is you");
    // This Mac signs out; the Mac mini and the CLI token can be revoked.
    expect(html.match(/data-testid="revoke"/g)).toHaveLength(2);
    expect(html).toMatch(/data-testid="device-dev_m5"[\s\S]*?Sign out/);
  });

  it("offers no Revoke until it knows which device is this Mac", async () => {
    const html = await renderPage("/settings/devices", { session: { deviceId: null } });
    expect(textOf(html)).toContain("Desktop app on M5");
    expect(html).not.toContain('data-testid="revoke"');
  });
});
