import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../src/bun/deeplink.ts";

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
});

describe("the live socket's URL", async () => {
  const { liveUrl } = await import("../src/bun/live.ts");
  it("is the door's /live over wss (ws for a local engine), with no token in it", () => {
    expect(liveUrl("https://sf-engine.example/")).toBe("wss://sf-engine.example/client/v1/live");
    expect(liveUrl("http://localhost:8787")).toBe("ws://localhost:8787/client/v1/live");
  });
});
