// Editing an org agent against a version (review of #159, round 3): typing never re-bases the
// edit, and Keep merges the newer version's changes into the fields this edit didn't touch.
import { describe, expect, it } from "vitest";
import { conflicts, keepOn, latestOf, openAgent, typeIn } from "../src/mainview/lib/agent-edit.ts";

const writer = { name: "Writer", role: "implement", tier: "standard", instructions: "" };

describe("an agent edit's base", () => {
  it("a new agent: typing its name after someone else saved one never re-bases", () => {
    let e = openAgent({ name: "", role: "review", tier: "standard", instructions: "" }, 5);
    e = typeIn(e, { name: "Writ" });
    // Another admin saves "Writer": the org is at v6 now. Typing on keeps v5.
    e = typeIn(e, { name: "Writer" });
    expect(e.base).toBe(5);
    expect(latestOf([{ ...writer, tier: "light" }], e)).toMatchObject({ name: "Writer" });
  });

  it("an existing agent: typing and deleting a character doesn't clear the conflict", () => {
    let e = openAgent(writer, 5);
    e = typeIn(e, { instructions: "a" });
    e = typeIn(e, { instructions: "" });
    expect(e.base).toBe(5);
  });

  it("finds the saved agent whatever the case, as the engine does", () => {
    expect(latestOf([{ ...writer, name: "WRITER" }], openAgent(writer, 5))).not.toBeNull();
  });
});

describe("Keep my changes", () => {
  it("keeps the fields this edit touched and takes the rest from the newer version", () => {
    let e = openAgent(writer, 5);
    e = typeIn(e, { instructions: "Mine" });
    const theirs = { ...writer, tier: "light", instructions: "Theirs" };
    expect(conflicts(e, theirs)).toEqual(["instructions"]);
    const kept = keepOn(e, theirs, 6);
    expect(kept.base).toBe(6);
    expect(kept.draft).toMatchObject({ tier: "light", instructions: "Mine" });
  });
});
