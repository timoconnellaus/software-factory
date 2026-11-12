// The toolbar as the title bar (spec 41): a double-click on its empty space zooms, minimises or
// does nothing as System Settings says; buttons, tabs, fields and no-drag areas keep their clicks.
// No DOM here: a few stand-in elements with what the check reads (classes, parent, `closest`).
import { describe, expect, it } from "vitest";
import { doubleClickAction } from "../src/bun/title-bar.ts";
import {
  DRAG,
  isTitleBarSpace,
  NO_DRAG,
  onTitleBarDoubleClick,
} from "../src/mainview/lib/title-bar.ts";

class El {
  classList: { contains: (c: string) => boolean };
  constructor(
    readonly tag: string,
    readonly parentElement: El | null,
    classes: string[] = [],
    readonly role: string | null = null,
  ) {
    this.classList = { contains: (c) => classes.includes(c) };
  }
  /** Enough of `closest` for the interactive selector: tags and roles. */
  closest(selector: string): El | null {
    const parts = selector.split(",").map((s) => s.trim());
    for (let el: El | null = this; el; el = el.parentElement) {
      if (parts.includes(el.tag)) return el;
      if (el.role && parts.includes(`[role=${el.role}]`)) return el;
    }
    return null;
  }
}

const bar = new El("div", null, [DRAG]);
const gap = new El("span", bar);
const back = new El("button", bar);
const tab = new El("div", bar, [], "tab");
const tabText = new El("span", tab);
const noDrag = new El("div", bar, [NO_DRAG]);
const search = new El("span", noDrag);
const field = new El("input", noDrag);
const page = new El("div", null);
const text = new El("span", page);
const is = (el: El) => isTitleBarSpace(el as unknown as Element);

describe("the title bar's double-click", () => {
  it("counts only the toolbar's empty space", () => {
    expect(is(bar)).toBe(true);
    expect(is(gap)).toBe(true);
    expect(is(back)).toBe(false);
    expect(is(tabText)).toBe(false);
    expect(is(search)).toBe(false);
    expect(is(field)).toBe(false);
    expect(is(text)).toBe(false);
  });

  it("fires on a double-click there and nowhere else", () => {
    let listener: ((e: MouseEvent) => void) | null = null;
    const doc = {
      addEventListener: (_: string, l: (e: MouseEvent) => void) => {
        listener = l;
      },
      removeEventListener: () => {
        listener = null;
      },
    } as unknown as Document;
    let n = 0;
    const off = onTitleBarDoubleClick(doc, () => n++);
    const dbl = (el: El, button = 0) =>
      (listener as ((e: MouseEvent) => void) | null)?.({
        target: el,
        button,
      } as unknown as MouseEvent);
    for (const el of [gap, back, tabText, field, text]) dbl(el);
    dbl(gap, 2);
    expect(n).toBe(1);
    off();
    dbl(gap);
    expect(n).toBe(1);
  });

  it("follows the system setting, zoom when unset", () => {
    expect(doubleClickAction(null, null)).toBe("zoom");
    expect(doubleClickAction("Maximize", null)).toBe("zoom");
    expect(doubleClickAction("Fill", null)).toBe("zoom");
    expect(doubleClickAction("Minimize", null)).toBe("minimize");
    expect(doubleClickAction("None", null)).toBe("none");
    expect(doubleClickAction(null, "1")).toBe("minimize");
    expect(doubleClickAction(null, "0")).toBe("zoom");
  });
});
