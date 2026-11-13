// The window while the app loads (lib/window-shell.ts): index.html draws the same shell as
// WindowSkeleton, with the toolbar strip as the drag region, before any script runs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DRAG } from "../src/mainview/lib/title-bar.ts";
import { SHELL, takeEarlyDoubleClick } from "../src/mainview/lib/window-shell.ts";

const html = readFileSync(new URL("../src/mainview/index.html", import.meta.url), "utf8");

describe("the static shell", () => {
  it("is the window's shell, class for class, so nothing moves when React takes over", () => {
    for (const [part, classes] of Object.entries(SHELL)) {
      expect(html, part).toContain(`class="${classes}"`);
    }
  });

  it("fills the window and has the title-bar drag region at the toolbar's height", () => {
    expect(SHELL.window).toContain("h-dvh");
    expect(SHELL.toolbar).toContain(DRAG);
    expect(SHELL.toolbar).toContain("h-11");
    // The real toolbar's height and inset (shell-toolbar.tsx).
    const toolbar = readFileSync(
      new URL("../src/mainview/components/shell-toolbar.tsx", import.meta.url),
      "utf8",
    );
    expect(toolbar).toContain('"flex h-11 flex-none items-center gap-1 pr-2.5 pl-[84px]"');
  });
});

describe("a double-click before the app's script ran", () => {
  it("is acted on once, and only while it is recent", () => {
    const w: { __sfEarlyDoubleClick?: number } = { __sfEarlyDoubleClick: 1_000 };
    expect(takeEarlyDoubleClick(w, 1_500)).toBe(true);
    expect(takeEarlyDoubleClick(w, 1_600)).toBe(false);
    expect(takeEarlyDoubleClick({ __sfEarlyDoubleClick: 1_000 }, 4_000)).toBe(false);
    expect(takeEarlyDoubleClick({}, 1_000)).toBe(false);
  });
});
