// The shell's pure logic (spec 41, spec 70): tabs and what this Mac keeps, the shortcuts table, an
// org's square, the tab titles and the search palette's places.

import { describe, expect, it } from "vitest";
import { matchPlaces, placesIn, tabTitle } from "../src/mainview/lib/places.ts";
import { orgInitial } from "../src/mainview/lib/scope.ts";
import { isTypingTarget, matchShortcut } from "../src/mainview/lib/shortcuts.ts";
import {
  activateTab,
  chooseOrg,
  closeTab,
  followNavigation,
  initialState,
  openTab,
  parseStored,
} from "../src/mainview/lib/view-state.ts";

describe("tabs", () => {
  it("the active tab follows navigation; others keep their place", () => {
    let s = initialState();
    s = followNavigation(s, "/flow/org_personal/work");
    s = openTab(s, "/flow/org_personal/team", "t2");
    s = followNavigation(s, "/flow/org_personal/team?tab=runners");
    expect(s.tabs.map((t) => t.path)).toEqual([
      "/flow/org_personal/work",
      "/flow/org_personal/team?tab=runners",
    ]);
    expect(s.activeTab).toBe("t2");
    expect(followNavigation(s, "/flow/org_personal/team?tab=runners")).toBe(s);
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

  it("closing another tab doesn't navigate; the last tab goes back to the start", () => {
    const s = openTab(initialState(), "/a", "a");
    const first = s.tabs[0]?.id as string;
    expect(closeTab(s, first).navigate).toBeNull();
    const only = closeTab(closeTab(s, first).state, "a");
    expect(only.state.tabs).toHaveLength(1);
    expect(only.navigate).toBe("/");
  });

  it("reads back what it stored and drops what's malformed", () => {
    const s = chooseOrg(openTab(initialState(), "/flow/orgs", "w"), null);
    const back = parseStored(JSON.stringify(s));
    expect(back.tabs).toEqual(s.tabs);
    expect(back.orgId).toBeNull();
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

  it("maps search, back and forward, and the tabs", () => {
    expect(matchShortcut(key("k", { meta: true }), false)).toBe("search");
    expect(matchShortcut(key("K", { meta: true }), false)).toBe("search");
    expect(matchShortcut(key("[", { meta: true }), false)).toBe("back");
    expect(matchShortcut(key("]", { meta: true }), false)).toBe("forward");
    expect(matchShortcut(key("t", { meta: true }), false)).toBe("new-tab");
    expect(matchShortcut(key("w", { meta: true }), false)).toBe("close-tab");
    // The old screens' shortcuts are gone with them.
    expect(matchShortcut(key("n"), false)).toBeNull();
    expect(matchShortcut(key("1", { meta: true }), false)).toBeNull();
    expect(matchShortcut(key("ArrowDown"), false)).toBeNull();
  });

  it("only search and close tab fire while typing", () => {
    expect(matchShortcut(key("k", { meta: true }), true)).toBe("search");
    expect(matchShortcut(key("w", { meta: true }), true)).toBe("close-tab");
    expect(matchShortcut(key("t", { meta: true }), true)).toBeNull();
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

describe("places", () => {
  it("names an org's square by its initial", () => {
    expect(orgInitial("client")).toBe("C");
    expect(orgInitial("  ")).toBe("?");
  });

  it("titles tabs by what they show: section, project, item, chat, run and All orgs", () => {
    const names = {
      project: (id: string) => (id === "fprj_api" ? "API Platform" : null),
      item: (id: string) => (id === "fitm_1" ? "API-1 Write the launch post" : null),
      chat: (id: string) => (id === "fcht_1" ? "What's on the board?" : null),
      run: (id: string) => (id === "frun_1" ? "Builder · API-1 Write the launch post" : null),
    };
    expect(tabTitle("/flow/org_personal/team?tab=runners")).toBe("Team");
    expect(tabTitle("/flow/org_personal/settings")).toBe("Settings");
    expect(tabTitle("/flow/org_personal/workflows?workflow=fwf_1")).toBe("Workflows");
    expect(tabTitle("/flow/orgs")).toBe("All orgs");
    expect(tabTitle("/flow/org_personal/p/fprj_api", names)).toBe("API Platform");
    expect(tabTitle("/flow/org_personal/p/fprj_x", names)).toBe("Board");
    expect(tabTitle("/flow/org_personal/p/fprj_api?item=fitm_1", names)).toBe(
      "API-1 Write the launch post",
    );
    expect(tabTitle("/flow/org_personal/p/fprj_api/i/fitm_1", names)).toBe(
      "API-1 Write the launch post",
    );
    expect(tabTitle("/flow/org_personal/inbox?item=fitm_1", names)).toBe(
      "API-1 Write the launch post",
    );
    expect(tabTitle("/flow/org_personal/p/fprj_api/i/fitm_2", names)).toBe("Item");
    expect(tabTitle("/flow/org_personal/chat?chat=fcht_1", names)).toBe("What's on the board?");
    expect(tabTitle("/flow/org_personal/chat?chat=fcht_2", names)).toBe("Chat");
    expect(tabTitle("/flow/org_personal/chat")).toBe("Chat");
    expect(tabTitle("/flow/org_personal/p/fprj_api/i/fitm_1?run=frun_1", names)).toBe(
      "Builder · API-1 Write the launch post",
    );
    expect(tabTitle("/flow/org_personal/team?run=frun_2", names)).toBe("Run");
    expect(tabTitle("/")).toBe("Software Factory");
  });

  it("finds an org's sections and projects by any word", () => {
    const places = placesIn("org_a", [{ id: "fprj_api", name: "API Platform" }]);
    expect(matchPlaces(places, "api").map((p) => p.to)).toEqual(["/flow/org_a/p/fprj_api"]);
    expect(matchPlaces(places, "runner").map((p) => p.label)).toEqual(["Team", "Settings"]);
    expect(matchPlaces(places, "all orgs").map((p) => p.to)).toEqual(["/flow/orgs"]);
    expect(matchPlaces(places, "")).toHaveLength(places.length);
  });
});
