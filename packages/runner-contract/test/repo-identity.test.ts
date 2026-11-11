import { describe, expect, it } from "vitest";
import { canonicalKeyFromUrl, canonicalRepoKey } from "../src/index.ts";

describe("repo identity (ADR 0260)", () => {
  it("is github.com/<owner>/<name>, lower-cased", () => {
    expect(canonicalRepoKey({ owner: "TimOConnellAus", name: "Software-Factory" })).toBe(
      "github.com/timoconnellaus/software-factory",
    );
    expect(canonicalRepoKey({ owner: "a", name: "b.git" })).toBe("github.com/a/b");
  });

  it("reads https, ssh and scp-like GitHub remotes, and nothing else", () => {
    for (const url of [
      "https://github.com/acme/app.git",
      "https://github.com/acme/app",
      "https://github.com/acme/app/",
      "https://user@github.com/Acme/App.git",
      "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app.git",
    ]) {
      expect(canonicalKeyFromUrl(url), url).toBe("github.com/acme/app");
    }
    expect(canonicalKeyFromUrl("https://gitlab.com/acme/app.git")).toBeNull();
    expect(canonicalKeyFromUrl("https://github.com.evil.example/acme/app")).toBeNull();
    expect(canonicalKeyFromUrl("/tmp/origin.git")).toBeNull();
  });
});
