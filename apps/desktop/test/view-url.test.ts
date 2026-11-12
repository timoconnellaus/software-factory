// The window's view URL (spec 41): the bundled view, except a dev build pointed at a local view.
import { describe, expect, it } from "vitest";
import { BUNDLED_VIEW, viewUrl } from "../src/bun/view-url.ts";

describe("the window's view", () => {
  it("is the bundled view unless a dev build is pointed at a local one", () => {
    expect(viewUrl("dev", undefined)).toBe(BUNDLED_VIEW);
    expect(viewUrl("dev", "http://localhost:5741/#/work")).toBe("http://localhost:5741/#/work");
    expect(viewUrl("stable", "http://localhost:5741/")).toBe(BUNDLED_VIEW);
    expect(viewUrl("canary", "http://localhost:5741/")).toBe(BUNDLED_VIEW);
    expect(viewUrl("dev", "https://example.com/")).toBe(BUNDLED_VIEW);
  });
});
