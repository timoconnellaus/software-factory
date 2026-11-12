// The door's update_required (spec 40 M4, ADR 0393): the screen's choices, and the throttled check.
import { describe, expect, it } from "vitest";
import { ON_DEMAND_GAP_MS, type UpdaterLike, Updates } from "../src/bun/updates.ts";
import { updateRequiredView } from "../src/mainview/components/update-required.tsx";
import type { UpdateStatus } from "../src/shared/rpc.ts";

const base: UpdateStatus = {
  required: true,
  ready: false,
  version: null,
  error: null,
  needsMove: false,
  jobs: 0,
  downloadUrl: "https://downloads.zerobsai.com/desktop/canary-macos-arm64-Software-Factory.zip",
};
const actions = (u: Partial<UpdateStatus>) =>
  updateRequiredView({ ...base, ...u }).actions.map((a) => a.action);

describe("the Update required screen", () => {
  it("offers the restart when a verified update is staged and the runner is idle", () => {
    expect(actions({ ready: true, version: "0.1.9" })).toEqual(["restart"]);
  });

  it("never offers a plain restart while jobs run, and names what restarting now cancels", () => {
    const v = updateRequiredView({ ...base, ready: true, version: "0.1.9", jobs: 2 });
    expect(v.actions.map((a) => a.action)).toEqual(["restart-when-idle", "restart-anyway"]);
    expect(v.actions[1]?.label).toMatch(/cancels 2 jobs/);
    expect(v.body).toMatch(/unpushed work is lost/);
  });

  it("offers the download (and a retry) when nothing is staged", () => {
    expect(actions({})).toEqual(["download", "retry"]);
    expect(actions({ error: "HTTP 404" })).toEqual(["download", "retry"]);
    expect(actions({ needsMove: true })).toEqual(["download", "retry"]);
  });
});

describe("checkNow", () => {
  it("checks at most once per ON_DEMAND_GAP_MS however often the door refuses", async () => {
    let checks = 0;
    const updater: UpdaterLike = {
      checkForUpdate: async () => {
        checks++;
        return { version: "0.1.4", updateAvailable: false, error: "" };
      },
      downloadUpdate: async () => {},
      updateInfo: () => ({ version: "", updateReady: false, error: "" }),
      applyUpdate: async () => {},
      getLocalInfo: async () => ({ version: "0.1.4", channel: "canary" }),
      appDataFolder: async () => "/data",
    };
    const updates = new Updates(
      {
        updater,
        exec: async () => ({ code: 0, out: "" }),
        appPath: "/Applications/Software Factory.app",
        writable: () => {},
        setInterval: () => 0,
        setTimeout: () => 0,
      },
      () => {},
    );
    await updates.checkNow(1_000);
    await updates.checkNow(2_000);
    await updates.checkNow(1_000 + ON_DEMAND_GAP_MS - 1);
    expect(checks).toBe(1);
    await updates.checkNow(1_000 + ON_DEMAND_GAP_MS);
    expect(checks).toBe(2);
  });
});
