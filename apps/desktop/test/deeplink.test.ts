import { describe, expect, it, vi } from "vitest";
import { parseDeepLink } from "../src/bun/deeplink.ts";

vi.mock("../src/mainview/bridge.ts", () => import("./bridge-stub.ts"));

describe("sf:// links", () => {
  it("reads the sign-in callback", () => {
    expect(parseDeepLink("sf://auth/callback?code=abc&state=xyz")).toEqual({
      kind: "auth",
      code: "abc",
      state: "xyz",
    });
    expect(parseDeepLink("sf://auth/callback?code=abc").kind).toBe("unknown");
  });
  it("routes app paths and refuses the rest", () => {
    expect(parseDeepLink("sf://work/wi_1")).toEqual({ kind: "route", path: "/work/wi_1" });
    expect(parseDeepLink("sf://work/wi_1/review/")).toEqual({
      kind: "route",
      path: "/work/wi_1/review",
    });
    expect(parseDeepLink("sf://attach?repo=o%2Fr&pr=4")).toEqual({
      kind: "route",
      path: "/attach?repo=o%2Fr&pr=4",
    });
    // Dot segments are normalised away by the URL parser before the route check.
    expect(parseDeepLink("sf://work/../../x")).toEqual({ kind: "route", path: "/work/x" });
    expect(parseDeepLink("sf://work/a%2F..%2Fb").kind).toBe("unknown");
    expect(parseDeepLink("https://example.com/work/1").kind).toBe("unknown");
    expect(parseDeepLink("not a url").kind).toBe("unknown");
  });
  it("routes the new core's places: an item on its board, a section, All orgs", () => {
    expect(parseDeepLink("sf://flow/org_a/p/fprj_api?item=fitm_1")).toEqual({
      kind: "route",
      path: "/flow/org_a/p/fprj_api?item=fitm_1",
    });
    expect(parseDeepLink("sf://flow/org_a/p/fprj_api/i/fitm_1").kind).toBe("route");
    expect(parseDeepLink("sf://flow/org_a/team").kind).toBe("route");
    expect(parseDeepLink("sf://flow/orgs").kind).toBe("route");
    expect(parseDeepLink("sf://flow/org_a/p/fprj_api/x/y").kind).toBe("unknown");
  });
});

describe("a link's path in the view", async () => {
  const { routeForLink } = await import("../src/mainview/routes/root.tsx");
  it("goes to the new core's place it names, an item as the board's panel", () => {
    expect(routeForLink("/flow/org_a/p/fprj_api?item=fitm_1")).toBe(
      "/flow/org_a/p/fprj_api?item=fitm_1",
    );
    expect(routeForLink("/flow/org_a/p/fprj_api/i/fitm_1")).toBe("/flow/org_a/p/fprj_api/i/fitm_1");
    expect(routeForLink("/flow/org_a/settings/")).toBe("/flow/org_a/settings");
    expect(routeForLink("/flow/orgs")).toBe("/flow/orgs");
  });
  it("opens the app's start for the old screens' links, and anything else", () => {
    expect(routeForLink("/work/wi_1")).toBe("/");
    expect(routeForLink("/work/wi_1/review")).toBe("/");
    expect(routeForLink("/attach?repo=o%2Fr&pr=4")).toBe("/");
    expect(routeForLink("/inbox")).toBe("/");
    expect(routeForLink("/flow/org_a/nowhere")).toBe("/");
    expect(routeForLink("/flow/org_a/p/fprj_api?item=../x")).toBe("/flow/org_a/p/fprj_api");
  });
});

describe("the live socket's URL", async () => {
  const { liveUrl } = await import("../src/bun/live.ts");
  it("is the door's /live over wss (ws for a local engine), with no token in it", () => {
    expect(liveUrl("https://sf-engine.example/")).toBe("wss://sf-engine.example/client/v1/live");
    expect(liveUrl("http://localhost:8787")).toBe("ws://localhost:8787/client/v1/live");
  });
});
