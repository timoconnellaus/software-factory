// Review of #130 and #160: the planning panes fit the window. A narrow window folds the chat (even
// in focus) and the write-back list; the default window (1200×800) keeps both open.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mediaStore, planningLayout, WIDE_PLANNING } from "../src/mainview/lib/use-media.ts";

/** A window whose width can change, with matchMedia for `(min-width: Npx)`. */
function fakeWindow(width: number) {
  const listeners = new Set<() => void>();
  const win = {
    width,
    matchMedia: (q: string) => ({
      matches: win.width >= Number(/min-width:\s*(\d+)px/.exec(q)?.[1] ?? 0),
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    }),
    resize(w: number) {
      win.width = w;
      for (const f of listeners) f();
    },
    listeners,
  };
  vi.stubGlobal("window", win);
  return win;
}

afterEach(() => vi.unstubAllGlobals());

describe("the planning layout in a narrow window (review of #130)", () => {
  it("follows the window's width as it resizes, and stops listening when unsubscribed", () => {
    const win = fakeWindow(1200);
    const store = mediaStore(WIDE_PLANNING);
    expect(store.read()).toBe(true);
    const changed = vi.fn();
    const stop = store.subscribe(changed);
    win.resize(900);
    expect(changed).toHaveBeenCalledOnce();
    expect(store.read()).toBe(false);
    stop();
    expect(win.listeners.size).toBe(0);
  });

  it("keeps the chat and the write-back list open at the default window, folds them when narrow", () => {
    expect(planningLayout(true, true)).toMatchObject({ chatPinned: true, writeBackOpen: true });
    expect(planningLayout(true, false)).toMatchObject({ chatPinned: false, writeBackOpen: false });
    expect(planningLayout(false, true).chatPinned).toBe(false);
    // The default window (1200 wide) is wide.
    const win = fakeWindow(1200);
    expect(planningLayout(true, win.matchMedia(WIDE_PLANNING).matches).writeBackOpen).toBe(true);
  });
});
