// The shared web terminal's handling of what the pane writes (spec 42, ADR 0530): OSC 8 links go
// only to http(s) and only through the app's opener; OSC 52 (the clipboard) and the window title stay
// off.
import { describe, expect, it } from "vitest";
import { linkTarget } from "../src/web-terminal.ts";
import viewSource from "../src/web-terminal-view.tsx?raw";

describe("links in the pane's output", () => {
  it("opens http(s) only", () => {
    expect(linkTarget("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(linkTarget("http://localhost:3000/")).toBe("http://localhost:3000/");
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "sf://work/wi_1",
      "data:text/html,<script>x</script>",
      "vscode://file/x",
      "not a url",
      "",
    ]) {
      expect(linkTarget(bad)).toBeNull();
    }
  });

  it("goes through the app's opener, with the clipboard and title escapes off", () => {
    const code = viewSource.replace(/\/\/.*$/gm, "");
    expect(code).toContain("linkHandler");
    expect(code).toMatch(/allowNonHttpProtocols:\s*false/);
    expect(code).toContain("linkTarget(text)");
    expect(code).not.toMatch(/window\.open|confirm\(/);
    expect(code).not.toMatch(/addon-clipboard|ClipboardAddon/);
    expect(code).not.toMatch(/onTitleChange/);
  });
});
