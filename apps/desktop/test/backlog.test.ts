// Backlog and Ready (spec 50, design WorkBacklog/WorkReady/ItemBacklog): the lists per state, the
// nested list's counts from `workItem.board`, which row is current, why an item can't be released,
// and quick add. Fixtures come from the screenshot harness's door, so the screens and the tests
// see the same data.
import type { Project } from "@software-factory/client/ops";
import { describe, expect, it } from "vitest";
import { ANSWERS } from "../screenshots/fixtures.ts";
import {
  age,
  type BacklogItem,
  bulkReport,
  fieldNames,
  itemsIn,
  quickAddLines,
  refusalText,
  releasable,
  releaseBlocker,
  waitsText,
} from "../src/mainview/lib/backlog.ts";
import { openCount, viewCounts, workPlace } from "../src/mainview/lib/work-board.ts";

// biome-ignore lint/style/noNonNullAssertion: the fixtures define these answers.
const boardOf = ANSWERS["workItem.board"]!;
// biome-ignore lint/style/noNonNullAssertion: the fixtures define these answers.
const projectList = ANSWERS["project.list"]!;
const ORGS = ["org_personal", "org_client"];
const items: BacklogItem[] = ORGS.flatMap((orgId) =>
  boardOf({ orgId }).items.map((i) => ({ ...i, orgId })),
);
const counts = ORGS.flatMap((orgId) => boardOf({ orgId }).counts.map((c) => ({ ...c, orgId })));
const projects: Project[] = ORGS.flatMap((orgId) => projectList({ orgId }).projects);
const projectOf = (id: string) => projects.find((p) => p.id === id);

describe("the lists before release", () => {
  it("shows a state's items in pull order, within the org and project", () => {
    // Priority first, then rank: a new item goes after what is already there.
    expect(itemsIn(items, ["backlog"], { orgId: "org_personal" }).map((i) => i.number)).toEqual([
      21, 22, 20, 15, 17,
    ]);
    expect(itemsIn(items, ["backlog"], { orgId: null }).map((i) => i.number)).toContain(5);
    expect(
      itemsIn(items, ["ready"], { orgId: "org_personal", projectId: "prj_factory" }).map(
        (i) => i.number,
      ),
    ).toEqual([14, 16]);
  });

  it("carries what an item waits for, and what of it isn't done", () => {
    const wi14 = items.find((i) => i.id === "wi_14");
    expect(wi14?.waitsFor.map((w) => w.number)).toEqual([26]);
    expect(wi14?.blockedBy.map((w) => w.number)).toEqual([26]);
    expect(waitsText(wi14?.blockedBy ?? [])).toBe("#26");
    expect(waitsText([{ number: 1 }, { number: 2 }, { number: 3 }])).toBe("#1, #2 and #3");
    expect(waitsText([])).toBeNull();
  });

  it("counts every view and each project's open work from the board's counts", () => {
    expect(viewCounts(counts, { orgId: "org_personal" })).toEqual({
      backlog: 5,
      planning: 0,
      ready: 3,
      active: 6,
      done: 5,
    });
    expect(viewCounts(counts, { orgId: null }).backlog).toBe(6);
    expect(viewCounts(counts, { orgId: null, projectId: "prj_site" }).ready).toBe(1);
    expect(openCount(counts, "prj_factory")).toBe(13);
  });
});

describe("why an item can't be released yet", () => {
  it("names the missing repository or config, and nothing else", () => {
    const ready = (id: string) => items.find((i) => i.id === id) as BacklogItem;
    expect(releaseBlocker(ready("wi_16"), projectOf("prj_factory"))).toBeNull();
    // Waiting for another item doesn't stop a release: it waits in Queued.
    expect(releaseBlocker(ready("wi_14"), projectOf("prj_factory"))).toBeNull();
    expect(releaseBlocker(ready("wi_site_2"), projectOf("prj_site"))).toBe(
      "Its project has no repository yet: add one in Setup",
    );
    const factory = projectOf("prj_factory") as Project;
    expect(
      releaseBlocker(
        { status: "ready", repositoryId: "repo_x" },
        { ...factory, policy: { state: "invalid", error: "bad", prUrl: null } },
      ),
    ).toMatch(/config isn't valid/);
    expect(releaseBlocker({ status: "ready", repositoryId: null }, factory)).toBe(
      "Choose which repository it changes",
    );
    expect(releaseBlocker({ status: "running", repositoryId: null }, factory)).toBeNull();
  });

  it("releases in priority order only what has nothing stopping it", () => {
    const ready = itemsIn(items, ["ready"], { orgId: "org_personal" });
    expect(releasable(ready, projectOf).map((i) => i.number)).toEqual([14, 16]);
  });
});

describe("the Work list's current row", () => {
  const none = () => null;
  it("selects the view, or the project on its page and its board", () => {
    expect(workPlace("/work", {}, none)).toEqual({ view: "active", projectId: null });
    expect(workPlace("/work", { view: "backlog", project: "prj_factory" }, none)).toEqual({
      view: "backlog",
      projectId: null,
    });
    expect(workPlace("/work", { project: "prj_factory" }, none)).toEqual({
      view: null,
      projectId: "prj_factory",
    });
    expect(workPlace("/work", { view: "active", project: "prj_factory" }, none)).toEqual({
      view: null,
      projectId: "prj_factory",
    });
    expect(workPlace("/work/wi_21", {}, () => "prj_factory")).toEqual({
      view: null,
      projectId: "prj_factory",
    });
  });
});

describe("quick add", () => {
  it("adds one item per non-empty line", () => {
    expect(quickAddLines("  one \n\n two\r\nthree  ")).toEqual(["one", "two", "three"]);
    expect(quickAddLines("x".repeat(250))[0]).toHaveLength(200);
    expect(quickAddLines("\n \n")).toEqual([]);
  });

  it("writes ages short", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(age("2026-11-12T11:30:00Z", now)).toBe("30 min");
    expect(age("2026-11-12T09:00:00Z", now)).toBe("3 h");
    expect(age("2026-11-09T12:00:00Z", now)).toBe("3 d");
  });
});

describe("bulk reports and edits", () => {
  const words = { done: (n: number) => `Released ${n} items`, not: "Not released" };
  it("reports how many went through and every refusal, each with its item", () => {
    const refused = [
      refusalText(20, "work item #20 needs a repository"),
      refusalText(22, "the project's config isn't valid"),
    ];
    expect(bulkReport(3, refused, words)).toBe(
      "Released 3 items. Not released: work item #20 needs a repository; #22: the project's config isn't valid",
    );
    expect(bulkReport(0, refused.slice(0, 1), words)).toBe(
      "Not released: work item #20 needs a repository",
    );
    expect(bulkReport(2, [], words)).toBe("Released 2 items.");
  });

  it("names the fields a save changed", () => {
    expect(fieldNames(["title"])).toBe("title");
    expect(fieldNames(["title", "body", "repositoryId"])).toBe("title, description and repository");
  });
});
