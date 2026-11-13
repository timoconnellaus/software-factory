// The window comes back where it was (window-frame.ts): the clamp to the connected displays, and
// when the frame is saved.
import { describe, expect, it } from "vitest";
import {
  FrameKeeper,
  parseFrame,
  type Rect,
  restoreFrame,
  SAVE_DELAY_MS,
  type SavedFrame,
} from "../src/bun/window-frame.ts";

/** A MacBook's work area (below the menu bar), and a second display to its right. */
const LAPTOP: Rect = { x: 0, y: 25, width: 1512, height: 920 };
const EXTERNAL: Rect = { x: 1512, y: 0, width: 2560, height: 1415 };
const frame = (over: Partial<SavedFrame> = {}): SavedFrame => ({
  x: 120,
  y: 80,
  width: 1200,
  height: 800,
  zoomed: false,
  fullScreen: false,
  ...over,
});

describe("restoreFrame", () => {
  it("restores a frame that fits the display it is on", () => {
    expect(restoreFrame(frame(), [LAPTOP])).toEqual(frame());
    expect(restoreFrame(frame({ zoomed: true }), [LAPTOP])?.zoomed).toBe(true);
    const onExternal = frame({ x: 2000, y: 200, width: 1800, height: 1100 });
    expect(restoreFrame(onExternal, [LAPTOP, EXTERNAL])).toEqual(onExternal);
  });

  it("falls back to the default when there is nothing saved or no display", () => {
    expect(restoreFrame(null, [LAPTOP])).toBeNull();
    expect(restoreFrame(frame(), [])).toBeNull();
  });

  it("falls back when the display it was on is gone (off screen)", () => {
    const onExternal = frame({ x: 2000, y: 200, width: 1800, height: 1100 });
    expect(restoreFrame(onExternal, [LAPTOP])).toBeNull();
    expect(restoreFrame(frame({ x: -5000 }), [LAPTOP])).toBeNull();
    expect(restoreFrame(frame({ y: 5000 }), [LAPTOP])).toBeNull();
  });

  it("falls back when it is larger than the display it is on", () => {
    // Saved on the big display, now only the laptop's: too tall and too wide for it.
    expect(restoreFrame(frame({ x: 0, y: 25, width: 2400, height: 1300 }), [LAPTOP])).toBeNull();
    expect(restoreFrame(frame({ x: 0, y: 25, width: 1200, height: 1000 }), [LAPTOP])).toBeNull();
    // Exactly the work area (a window dragged to fill it) is fine.
    const filled = frame({ ...LAPTOP });
    expect(restoreFrame(filled, [LAPTOP])).toEqual(filled);
  });

  it("needs enough of the title bar on screen to grab, and not under the menu bar", () => {
    // Only 40px of the title bar left on the laptop's right edge.
    expect(restoreFrame(frame({ x: 1472 }), [LAPTOP])).toBeNull();
    // Mostly off the left edge but 300px still showing: kept.
    expect(restoreFrame(frame({ x: -900 }), [LAPTOP])).toEqual(frame({ x: -900 }));
    expect(restoreFrame(frame({ y: 0 }), [LAPTOP])).toBeNull();
  });

  it("ignores a frame too small to be a choice, or not numbers", () => {
    expect(restoreFrame(frame({ width: 100, height: 50 }), [LAPTOP])).toBeNull();
    expect(restoreFrame(frame({ x: Number.NaN }), [LAPTOP])).toBeNull();
  });
});

describe("parseFrame", () => {
  it("reads what the keeper writes, and nothing else", () => {
    expect(parseFrame(JSON.stringify(frame({ zoomed: true })))).toEqual(frame({ zoomed: true }));
    expect(parseFrame(null)).toBeNull();
    expect(parseFrame("{")).toBeNull();
    expect(parseFrame(JSON.stringify({ x: 1, y: 2, width: "wide", height: 4 }))).toBeNull();
  });
});

describe("FrameKeeper", () => {
  function setup(saved: SavedFrame | null = null) {
    const writes: SavedFrame[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const keeper = new FrameKeeper({
      read: () => (saved ? JSON.stringify(saved) : null),
      write: (t) => writes.push(JSON.parse(t) as SavedFrame),
      setTimeout: (fn, ms) => timers.push({ fn, ms }) - 1,
      clearTimeout: (t) => {
        const i = t as number;
        if (timers[i]) timers[i].fn = () => undefined;
      },
    });
    let state = { frame: { x: 10, y: 40, width: 900, height: 600 }, zoomed: false, full: false };
    const win = {
      getFrame: () => state.frame,
      isMaximized: () => state.zoomed,
      isFullScreen: () => state.full,
    };
    const set = (s: Partial<typeof state>) => {
      state = { ...state, ...s };
    };
    const runTimers = () => {
      for (const t of timers.splice(0)) t.fn();
    };
    return { keeper, writes, timers, win, set, runTimers };
  }

  it("reads the saved frame at start", () => {
    expect(setup(frame()).keeper.saved()).toEqual(frame());
  });

  it("writes once a move settles, not on every step", () => {
    const { keeper, writes, timers, win, set, runTimers } = setup();
    keeper.changed(win);
    set({ frame: { x: 20, y: 40, width: 900, height: 600 } });
    keeper.changed(win);
    expect(writes).toEqual([]);
    expect(timers.at(-1)?.ms).toBe(SAVE_DELAY_MS);
    runTimers();
    expect(writes).toEqual([
      { x: 20, y: 40, width: 900, height: 600, zoomed: false, fullScreen: false },
    ]);
  });

  it("writes at once on quit, and after a close from what it read last", () => {
    const a = setup();
    a.keeper.flush(a.win);
    expect(a.writes).toHaveLength(1);
    const b = setup();
    b.keeper.changed(b.win);
    // Closed: the window can't be asked; what was read when it moved is written.
    b.keeper.flush();
    expect(b.writes).toEqual([
      { x: 10, y: 40, width: 900, height: 600, zoomed: false, fullScreen: false },
    ]);
  });

  it("keeps the frame to return to while zoomed or full screen, with the flag", () => {
    const { keeper, writes, win, set } = setup();
    keeper.flush(win);
    set({ frame: { x: 0, y: 25, width: 1512, height: 920 }, zoomed: true });
    keeper.flush(win);
    expect(writes.at(-1)).toEqual({
      x: 10,
      y: 40,
      width: 900,
      height: 600,
      zoomed: true,
      fullScreen: false,
    });
    set({ full: true, zoomed: false, frame: { x: 0, y: 0, width: 1512, height: 982 } });
    keeper.flush(win);
    expect(writes.at(-1)).toMatchObject({ width: 900, fullScreen: true });
  });

  it("doesn't write what is already saved, and survives a window that throws", () => {
    const { keeper, writes, win } = setup({
      x: 10,
      y: 40,
      width: 900,
      height: 600,
      zoomed: false,
      fullScreen: false,
    });
    keeper.flush(win);
    expect(writes).toEqual([]);
    keeper.flush({
      getFrame: () => {
        throw new Error("gone");
      },
      isMaximized: () => false,
      isFullScreen: () => false,
    });
    expect(writes).toEqual([]);
  });
});
