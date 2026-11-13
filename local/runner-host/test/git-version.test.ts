import { describe, expect, it } from "vitest";
import { gitAtLeast } from "../src/git.ts";

describe("gitAtLeast (sf-runner doctor: the check export needs git 2.40's --attr-source)", () => {
  it("accepts 2.40 and later, Apple's and distro builds included", () => {
    expect(gitAtLeast("git version 2.40.0")).toBe(true);
    expect(gitAtLeast("git version 2.50.1 (Apple Git-155)")).toBe(true);
    expect(gitAtLeast("git version 3.0.0")).toBe(true);
  });
  it("refuses older gits and output it can't read", () => {
    expect(gitAtLeast("git version 2.39.5 (Apple Git-154)")).toBe(false);
    expect(gitAtLeast("git version 2.34.1")).toBe(false);
    expect(gitAtLeast("git version 1.99.0")).toBe(false);
    expect(gitAtLeast("not git")).toBe(false);
  });
});
