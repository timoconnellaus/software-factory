// The Factory section's pure logic (spec 41, slice 5): the queue's order, the runner rows (state,
// slots, load and the update from two reads), incidents from work items, and where the section sits
// in the shell. Fixtures come from the screenshot harness's door.
import type { Inbox, OpOutput } from "@software-factory/client/ops";
import { describe, expect, it } from "vitest";
import { ANSWERS, FACTORY_ITEMS, ITEMS } from "../screenshots/fixtures.ts";
import {
  fixText,
  incidentRows,
  queued,
  runnerRows,
  runnersOnline,
  runningNow,
} from "../src/mainview/lib/factory.ts";
import { PLACE_COMMANDS, sectionOf, tabTitle } from "../src/mainview/lib/places.ts";

type Health = Inbox["runners"][number];
type Listed = OpOutput<"runner.list">["runners"][number];

const clock = (iso: string) => iso.slice(11, 16);
const items = [...ITEMS, ...FACTORY_ITEMS];

function health(extra: Partial<Health> = {}): Health {
  return {
    id: "rnr_1",
    name: "M5",
    state: "online",
    inUse: 1,
    max: 2,
    light: { inUse: 2, max: 6 },
    rateLimitedUntil: null,
    lastSeenAt: "2026-11-12T09:58:00.000Z",
    paused: null,
    update: null,
    ...extra,
  };
}

function listed(extra: Partial<Listed> = {}): Listed {
  return {
    id: "rnr_1",
    name: "M5",
    ownerUserId: "usr_1",
    keyVersion: 1,
    manifest: {
      contractVersion: "1",
      runnerKind: "local",
      harnesses: ["claude-code"],
      capabilities: [],
    },
    capacityMax: 2,
    light: { max: 6, inUse: 2 },
    accepting: true,
    rateLimitedUntil: null,
    lastSeenAt: "2026-11-12T09:58:00.000Z",
    version: "5da89881234",
    desiredVersion: "5da89881234",
    autoUpdate: true,
    update: { state: "current", target: null, reason: null },
    accounts: null,
    ...extra,
  };
}

describe("the overview", () => {
  it("counts what runs and lists the queue in pull order", () => {
    expect(runningNow(items).map((i) => i.number)).toEqual([26, 25, 9, 3]);
    const q = queued([
      ...FACTORY_ITEMS,
      {
        ...(FACTORY_ITEMS.at(-1) as (typeof items)[number]),
        id: "wi_31",
        number: 31,
        priority: "urgent",
      },
    ]);
    expect(q.map((i) => i.number)).toEqual([31, 30]);
  });

  it("counts runners online", () => {
    expect(runnersOnline([health(), health({ id: "b", state: "offline" })])).toEqual({
      online: 1,
      total: 2,
    });
  });
});

describe("runner rows", () => {
  it("joins the health line's state and slots with the runner's version", () => {
    const [r] = runnerRows([health()], [listed()], clock);
    expect(r).toMatchObject({
      stateText: "Online",
      heavy: "1 of 2",
      light: "2 of 6",
      version: "5da8988",
      versionText: "up to date",
      updatePending: false,
      harnesses: ["Claude Code"],
      kind: "local",
    });
  });

  it("says when an update waits, runs or needs a person", () => {
    const behind = runnerRows([health()], [listed({ version: "c4db47e000", update: null })], clock);
    expect(behind[0]).toMatchObject({
      versionText: "update to 5da8988 waits until it's idle",
      updatePending: true,
      updateNeedsYou: false,
    });
    const blocked = runnerRows(
      [health()],
      [listed({ update: { state: "blocked", target: null, reason: "local changes" } })],
      clock,
    );
    expect(blocked[0]).toMatchObject({
      versionText: "can't update: local changes",
      updateNeedsYou: true,
    });
    const updating = runnerRows(
      [health()],
      [listed({ update: { state: "updating", target: "abcdef0123", reason: null } })],
      clock,
    );
    expect(updating[0]?.versionText).toBe("updating to abcdef0");
  });

  it("shows load, offline and unknown runners without slots in use", () => {
    const load = runnerRows(
      [health({ paused: { reason: "load", pools: ["heavy", "light"], load1: 19.27, cores: 10 } })],
      [listed()],
      clock,
    );
    expect(load[0]?.stateText).toBe("Paused: load 19.3 on 10 cores");
    const off = runnerRows([health({ state: "offline" })], [listed()], clock);
    expect(off[0]).toMatchObject({
      stateText: "Offline since 09:58",
      heavy: "0 of 2",
      light: "0 of 6",
    });
    const unknown = runnerRows([], [listed()], clock);
    expect(unknown[0]).toMatchObject({ state: "unknown", stateText: "Not reported" });
  });

  it("matches the fixture door's runner", () => {
    const inbox = ANSWERS["inbox.list"]?.({}) as Inbox;
    const list = ANSWERS["runner.list"]?.({}) as OpOutput<"runner.list">;
    expect(runnerRows(inbox.runners, list.runners, clock).map((r) => r.name)).toEqual(["M5"]);
  });
});

describe("incidents", () => {
  it("are the incident work items, open until the fix lands", () => {
    const rows = incidentRows(items);
    expect(rows.map((r) => [r.number, r.fromNumber, r.what, r.open])).toEqual([
      [28, 8, "Had a run that failed", true],
      [21, 4, "Was sent back at review", false],
    ]);
    expect(fixText(rows[0] as (typeof rows)[number])).toBe("Waiting: Packet ready");
    expect(fixText(rows[1] as (typeof rows)[number])).toBe("Fixed");
  });

  it("keeps an incident open while its fix failed", () => {
    const failed = incidentRows([
      { ...(FACTORY_ITEMS[0] as (typeof items)[number]), status: "failed" },
    ]);
    expect(failed[0]?.open).toBe(true);
  });
});

describe("the section in the shell", () => {
  it("has its own sidebar section, tab titles and palette commands", () => {
    expect(sectionOf("/factory")).toBe("factory");
    expect(sectionOf("/factory/runners")).toBe("factory");
    expect(sectionOf("/factoryx")).toBe("work");
    expect(tabTitle("/factory/runners?runner=x", () => null)).toBe("Runners");
    expect(tabTitle("/factory/incidents", () => null)).toBe("Checks and incidents");
    expect(PLACE_COMMANDS.filter((c) => c.to.startsWith("/factory")).map((c) => c.id)).toEqual([
      "factory",
      "runners",
      "incidents",
    ]);
  });
});
