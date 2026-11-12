// The trampoline (ADR 0392, spec 40 M1 criterion 9): website links hand off to sf:// in the app.
import { describe, expect, it } from "vitest";
import { appLink } from "#/lib/open-link";

describe("the /open/* trampoline", () => {
  it("maps app paths to sf:// links, keeping the query", () => {
    expect(appLink("work/123", "")).toBe("sf://work/123");
    expect(appLink("/work/wi_abc/review/", "")).toBe("sf://work/wi_abc/review");
    expect(appLink("attach", "?repo=o%2Fr&pr=4")).toBe("sf://attach?repo=o%2Fr&pr=4");
  });
  it("refuses anything the app doesn't route", () => {
    expect(appLink("work/../../etc", "")).toBeNull();
    expect(appLink("javascript:alert(1)", "")).toBeNull();
    expect(appLink("", "")).toBeNull();
  });
});
