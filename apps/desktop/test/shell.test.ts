// The shell's pure logic (spec 41, criteria 4–7, 9, 12): tabs, pins and focus, the shortcuts table,
// org scoping, the status bar's wording, the Inbox's list and selection, the tab titles and search,
// the Work views and board, and how the merge gate words a packet. Fixtures come from the
// screenshot harness's door, so the screens and the tests see the same data.

import { STAGE_LABEL } from "@software-factory/client/format";
import type { Inbox } from "@software-factory/client/ops";
import { parsePacket } from "@software-factory/client/packet";
import { describe, expect, it } from "vitest";
import { ANSWERS, ITEMS } from "../screenshots/fixtures.ts";
import { entryText, inboxEntries, selectedEntry } from "../src/mainview/lib/inbox-list.ts";
import { matchItems, sectionOf, tabTitle } from "../src/mainview/lib/places.ts";
import { verdictChips, verdictHeadline } from "../src/mainview/lib/review.ts";
import {
  orgInitial,
  orgOfProject,
  orgsWaiting,
  scopeInbox,
  waitingCount,
} from "../src/mainview/lib/scope.ts";
import { isTypingTarget, matchShortcut } from "../src/mainview/lib/shortcuts.ts";
import { runnerItems, runningCount, slots, syncText } from "../src/mainview/lib/status-bar.ts";
import {
  activateTab,
  chooseOrg,
  closeTab,
  followNavigation,
  initialState,
  openTab,
  parseStored,
  setFocus,
  togglePin,
} from "../src/mainview/lib/view-state.ts";
import {
  boardLanes,
  cardState,
  countsByView,
  outcomeOf,
  viewOf,
  waitingOn,
  workItemsFor,
} from "../src/mainview/lib/work-board.ts";

// biome-ignore lint/style/noNonNullAssertion: the fixtures define these answers.
const inbox = ANSWERS["inbox.list"]!({}) as Inbox;
const projects = [
  { id: "prj_factory", orgId: "org_personal" },
  { id: "prj_crm", orgId: "org_client" },
];
const orgOf = orgOfProject(projects);

describe("tabs", () => {
  it("the active tab follows navigation; others keep their place", () => {
    let s = initialState();
    s = followNavigation(s, "/work");
    s = openTab(s, "/work/wi_13", "t2");
    s = followNavigation(s, "/work/wi_13?tab=review");
    expect(s.tabs.map((t) => t.path)).toEqual(["/work", "/work/wi_13?tab=review"]);
    expect(s.activeTab).toBe("t2");
    expect(followNavigation(s, "/work/wi_13?tab=review")).toBe(s);
  });

  it("opens a new tab after the active one", () => {
    let s = openTab(initialState(), "/a", "a");
    s = openTab(s, "/b", "b");
    s = activateTab(s, "a").state;
    s = openTab(s, "/c", "c");
    expect(s.tabs.map((t) => t.path)).toEqual(["/", "/a", "/c", "/b"]);
  });

  it("closing the active tab goes to its right neighbour, else its left", () => {
    let s = openTab(initialState(), "/a", "a");
    s = openTab(s, "/b", "b");
    s = activateTab(s, "a").state;
    const r = closeTab(s, "a");
    expect(r.state.activeTab).toBe("b");
    expect(r.navigate).toBe("/b");
    const last = closeTab(r.state, "b");
    expect(last.navigate).toBe("/");
  });

  it("closing another tab doesn't navigate; the last tab goes back to the Inbox", () => {
    const s = openTab(initialState(), "/a", "a");
    const first = s.tabs[0]?.id as string;
    expect(closeTab(s, first).navigate).toBeNull();
    const only = closeTab(closeTab(s, first).state, "a");
    expect(only.state.tabs).toHaveLength(1);
    expect(only.navigate).toBe("/");
  });
});

describe("pins, org, focus and storage", () => {
  it("pins toggle in order", () => {
    let s = togglePin(initialState(), "wi_9");
    s = togglePin(s, "wi_13");
    expect(s.pins).toEqual(["wi_9", "wi_13"]);
    expect(togglePin(s, "wi_9").pins).toEqual(["wi_13"]);
  });

  it("reads back what it stored, drops what's malformed, and never restores focus", () => {
    let s = chooseOrg(togglePin(openTab(initialState(), "/work", "w"), "wi_9"), null);
    s = setFocus(s, "wi_12");
    const back = parseStored(JSON.stringify(s));
    expect(back.tabs).toEqual(s.tabs);
    expect(back.pins).toEqual(["wi_9"]);
    expect(back.orgId).toBeNull();
    expect(back.focus).toBeNull();
    expect(parseStored("{nope").tabs).toHaveLength(1);
    expect(parseStored(JSON.stringify({ tabs: [{ id: 1, path: "x" }] })).tabs[0]?.path).toBe("/");
  });
});

describe("shortcuts", () => {
  const key = (k: string, m: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {}) => ({
    key: k,
    metaKey: !!m.meta,
    ctrlKey: !!m.ctrl,
    altKey: !!m.alt,
    shiftKey: !!m.shift,
  });

  it("maps every shortcut in spec 41", () => {
    expect(matchShortcut(key("k", { meta: true }), false)).toBe("search");
    expect(matchShortcut(key("n", { meta: true }), false)).toBe("new-item");
    expect(matchShortcut(key("n"), false)).toBe("new-item");
    expect(matchShortcut(key("1", { meta: true }), false)).toBe("inbox");
    expect(matchShortcut(key("2", { meta: true }), false)).toBe("work");
    expect(matchShortcut(key(",", { meta: true }), false)).toBe("settings");
    expect(matchShortcut(key("[", { meta: true }), false)).toBe("back");
    expect(matchShortcut(key("]", { meta: true }), false)).toBe("forward");
    expect(matchShortcut(key("s", { meta: true, ctrl: true }), false)).toBe("sidebar");
    expect(matchShortcut(key("t", { meta: true }), false)).toBe("new-tab");
    expect(matchShortcut(key("w", { meta: true }), false)).toBe("close-tab");
    expect(matchShortcut(key("ArrowDown"), false)).toBe("list-next");
    expect(matchShortcut(key("ArrowUp"), false)).toBe("list-prev");
    expect(matchShortcut(key("K", { meta: true }), false)).toBe("search");
  });

  it("only search, New item and close tab fire while typing", () => {
    expect(matchShortcut(key("k", { meta: true }), true)).toBe("search");
    expect(matchShortcut(key("n", { meta: true }), true)).toBe("new-item");
    expect(matchShortcut(key("w", { meta: true }), true)).toBe("close-tab");
    expect(matchShortcut(key("n"), true)).toBeNull();
    expect(matchShortcut(key("ArrowDown"), true)).toBeNull();
    expect(matchShortcut(key("1", { meta: true }), true)).toBeNull();
  });

  it("ignores other modifiers and keys", () => {
    expect(matchShortcut(key("k", { meta: true, shift: true }), false)).toBeNull();
    expect(matchShortcut(key("s", { meta: true }), false)).toBeNull();
    expect(matchShortcut(key("x"), false)).toBeNull();
  });

  it("knows a typing target", () => {
    const el = (tag: string) => ({ closest: (sel: string) => (sel.includes(tag) ? {} : null) });
    expect(isTypingTarget(el("textarea") as unknown as Element)).toBe(true);
    expect(isTypingTarget({ closest: () => null } as unknown as Element)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("org scope", () => {
  it("All shows everything; an org shows its own and factory-wide gates", () => {
    expect(scopeInbox(inbox, orgOf, null)).toBe(inbox);
    const client = scopeInbox(inbox, orgOf, "org_client");
    expect(waitingCount(client)).toBe(0);
    expect(client.running.map((i) => i.number)).toEqual([3]);
    const personal = scopeInbox(inbox, orgOf, "org_personal");
    expect(waitingCount(personal)).toBe(3);
    const global = {
      ...inbox,
      gates: [{ ...(inbox.gates[0] as Inbox["gates"][number]), projectId: null }],
    };
    expect(scopeInbox(global, orgOf, "org_client").gates).toHaveLength(1);
  });

  it("dots the orgs with something waiting, and names a square by its initial", () => {
    expect([...orgsWaiting(inbox, orgOf)]).toEqual(["org_personal"]);
    expect(orgInitial("client")).toBe("C");
    expect(orgInitial("  ")).toBe("?");
  });
});

describe("status bar", () => {
  it("words runners and slots from the inbox read", () => {
    expect(runnerItems(inbox.runners)).toEqual([
      { id: "rnr_m5", text: "M5 online", status: "done" },
    ]);
    expect(slots(inbox.runners)).toEqual({ heavy: "Heavy 1 of 2", light: "Light 2 of 6" });
    const offline = inbox.runners.map((r) => ({ ...r, state: "offline" as const }));
    expect(slots(offline)).toEqual({ heavy: null, light: null });
    const noLight = inbox.runners.map((r) => ({ ...r, light: null }));
    expect(slots(noLight).light).toBeNull();
  });

  it("counts only running items as running", () => {
    expect(runningCount(inbox)).toBe(3);
  });

  it("says when it last heard from the factory, or that it can't", () => {
    const now = 1_000_000_000;
    expect(
      syncText({ dataUpdatedAt: now - 5_000, isError: false, errorUpdatedAt: 0 }, now).text,
    ).toBe("Synced just now");
    expect(
      syncText({ dataUpdatedAt: now - 180_000, isError: false, errorUpdatedAt: 0 }, now).text,
    ).toBe("Synced 3 min ago");
    expect(syncText({ dataUpdatedAt: 0, isError: false, errorUpdatedAt: 0 }, now).text).toBe(
      "Syncing…",
    );
    const down = syncText({ dataUpdatedAt: now - 60_000, isError: true, errorUpdatedAt: now }, now);
    expect(down).toEqual({ text: "Can't reach the factory", ok: false });
  });
});

describe("the Inbox list", () => {
  const setup = ANSWERS["setup.status"]?.({ orgId: "org_personal" }) ?? null;
  const entries = inboxEntries(inbox, setup);

  it("groups merges, specs, questions, then notices", () => {
    expect(entries.map((e) => `${e.group}:${e.key}`)).toEqual([
      "Merges:wi_13",
      "Specs:wi_12",
      "Questions:wi_11",
      "Notices:protection-prj_factory",
      "Notices:setup",
    ]);
    expect(
      inboxEntries(inbox, { ...(setup as NonNullable<typeof setup>), complete: true }),
    ).toHaveLength(4);
  });

  it("selects ?item=, else the first; nothing when empty", () => {
    expect(selectedEntry(entries, "wi_11")?.kind).toBe("question");
    expect(selectedEntry(entries, "gone")?.key).toBe("wi_13");
    expect(selectedEntry([], undefined)).toBeNull();
  });

  it("names rows with the item's number", () => {
    const n = (id: string) => ITEMS.find((i) => i.id === id)?.number ?? null;
    expect(entryText(entries[0] as (typeof entries)[number], n)).toEqual({
      title: "#13 Guard the tests in verify",
      sub: "Ready to merge",
      status: "waiting",
    });
    expect(entryText(entries[2] as (typeof entries)[number], n).title).toMatch(
      /^#11 Which address/,
    );
  });

  it("gives a second question on one item its own key", () => {
    const q = inbox.questions[0] as Inbox["questions"][number];
    const two = inboxEntries({ ...inbox, gates: [], questions: [q, { ...q, id: "q_2" }] }, null);
    expect(two.filter((e) => e.kind === "question").map((e) => e.key)).toEqual(["wi_11", "q_2"]);
  });
});

describe("places and search", () => {
  const find = (id: string) => ITEMS.find((i) => i.id === id) ?? null;
  it("titles tabs", () => {
    expect(tabTitle("/", find)).toBe("Inbox");
    expect(tabTitle("/work?view=done", find)).toBe("Done");
    expect(tabTitle("/work?view=backlog&project=prj_factory", find)).toBe("Backlog");
    expect(tabTitle("/work?project=prj_factory", find)).toBe("A project");
    expect(tabTitle("/work", find)).toBe("In the factory");
    expect(tabTitle("/work/wi_13?tab=review", find)).toBe("#13 Guard the tests in verify");
    expect(tabTitle("/work/unknown", find)).toBe("Work item");
    expect(tabTitle("/settings", find)).toBe("This Mac");
  });

  it("puts paths in sections", () => {
    expect(sectionOf("/")).toBe("inbox");
    expect(sectionOf("/work/wi_1")).toBe("work");
    expect(sectionOf("/new")).toBe("work");
    expect(sectionOf("/setup")).toBe("settings");
  });

  it("finds by number first, else by every word of the title", () => {
    expect(matchItems(ITEMS, "#1").map((i) => i.number)).toEqual([1, 13, 11, 12, 17, 15, 16, 14]);
    expect(matchItems(ITEMS, "13").map((i) => i.number)).toEqual([13]);
    expect(matchItems(ITEMS, "guard verify").map((i) => i.number)).toEqual([13]);
    expect(matchItems(ITEMS, "nothing like this")).toEqual([]);
    expect(matchItems(ITEMS, "", 2)).toHaveLength(2);
  });
});

describe("Work views and the board", () => {
  it("sorts statuses into views", () => {
    expect(viewOf("waiting")).toBe("active");
    expect(viewOf("done")).toBe("done");
    // Done shows every way out of the factory, with its outcome.
    expect(viewOf("cancelled")).toBe("done");
    expect(viewOf("backlog")).toBe("backlog");
    expect(viewOf("shaping")).toBe("planning");
    expect(viewOf("ready")).toBe("ready");
    // Released work is in the factory, waiting in its first lane.
    expect(viewOf("queued")).toBe("active");
  });

  it("filters by view, project and org, and counts per view", () => {
    expect(
      workItemsFor(ITEMS, { view: "active", orgId: "org_personal" }).map((i) => i.number),
    ).toEqual([13, 9, 11, 12, 26, 28]);
    expect(workItemsFor(ITEMS, { view: "active", orgId: null, projectId: "prj_crm" })).toHaveLength(
      1,
    );
    expect(countsByView(ITEMS, null)).toEqual({
      backlog: 6,
      planning: 0,
      ready: 3,
      active: 7,
      done: 5,
    });
  });

  it("puts each item in the factory in its stage's lane, Queued first, shaping before delivery", () => {
    const items = (ANSWERS["workItem.board"]?.({ orgId: "org_personal" }).items ?? [])
      .filter((i) => ["queued", "running", "waiting", "paused"].includes(i.status))
      .map((i) => ({ ...i, orgId: "org_personal" }));
    const board = boardLanes(items, STAGE_LABEL);
    expect(
      board.map((l) => `${l.key}/${l.phase}:${l.items.map((i) => i.number).join(",")}`),
    ).toEqual([
      "queued/queued:28",
      "spec/shaping:12",
      "build/delivery:9,11",
      "verify/delivery:26",
      "merge/delivery:13",
    ]);
    // A stage the view has no label for still gets its lane, after the ones it knows.
    const odd = boardLanes(
      [{ ...(items[1] as (typeof items)[number]), stage: "publish", phase: "delivery" }],
      STAGE_LABEL,
    );
    expect(odd.map((l) => l.label)).toEqual(["Queued", "Publish"]);
  });

  it("says who an item waits on, and words its outcome", () => {
    const needs = new Set(["wi_13"]);
    expect(waitingOn({ id: "wi_13", status: "waiting", blockedBy: [] }, needs).label).toBe(
      "Waiting on you",
    );
    expect(waitingOn({ id: "x", status: "running", blockedBy: [] }, needs).label).toBe(
      "Agent working",
    );
    expect(
      waitingOn({ id: "x", status: "queued", blockedBy: [{ number: 26 } as never] }, needs).label,
    ).toBe("Waiting for #26");
    expect(waitingOn({ id: "x", status: "queued", blockedBy: [] }, needs).label).toBe(
      "Waiting for a slot",
    );
    expect(outcomeOf({ status: "done", statusReason: null })).toEqual({
      label: "Done",
      status: "done",
    });
    expect(outcomeOf({ status: "cancelled", statusReason: "cancelled from the app" }).label).toBe(
      "Cancelled: cancelled from the app",
    );
  });

  it("marks a card that needs you", () => {
    const needs = new Set(["wi_13"]);
    expect(cardState({ id: "wi_13", status: "waiting" }, needs)).toEqual({
      label: "Needs you",
      tone: "amber",
      needsYou: true,
    });
    expect(cardState({ id: "wi_9", status: "running" }, needs).label).toBe("Working");
    expect(cardState({ id: "wi_8", status: "failed" }, needs).label).toBe("Failed");
  });
});

describe("the merge gate's words", () => {
  const stored = ANSWERS["workItem.get"]?.({ workItemId: "wi_13" }).reviewPacket;
  if (!stored) throw new Error("wi_13 carries a packet in the fixtures");
  const packet = parsePacket(stored);

  it("heads the packet by what's met", () => {
    expect(verdictHeadline(packet)).toEqual({ text: "Passed", status: "done" });
    const one = {
      ...packet,
      criteria: packet.criteria.map((c, i) => ({ ...c, met: i !== 3 })),
    };
    expect(verdictHeadline(one)).toEqual({
      text: "Passed, with one criterion not met",
      status: "waiting",
    });
    expect(verdictHeadline({ ...packet, verdict: "fail" }).status).toBe("failed");
  });

  it("chips the checks, criteria, reviewer and risk", () => {
    expect(verdictChips(packet).map((c) => c.label)).toEqual([
      "Checks 1 of 1",
      "Criteria 4 met",
      "Reviewer approves",
      "No risk flags",
    ]);
  });
});
