// The window comes back where the person left it: its frame (position, size, zoomed or full
// screen) is kept in the app's own data folder (window.json), saved a moment after each move or
// resize and again on quit, and read on every launch, including the relaunch after an update.
// A saved frame is used only if it still fits the displays connected now: one that is off screen
// (a display unplugged) or larger than the display it is on gives the default, centred.
// Nothing here imports Electrobun, so the tests run on Node.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedFrame extends Rect {
  /** Zoomed (the green button, or a title-bar double-click). */
  zoomed: boolean;
  fullScreen: boolean;
}

/** The size a window opens at when there is nothing to restore: Electrobun centres it. */
export const DEFAULT_SIZE = { width: 1200, height: 800 } as const;
/** The smallest window worth restoring; anything smaller was a glitch, not a choice. */
export const MIN_SIZE = { width: 480, height: 320 } as const;
/** How much of the title bar must be on a display for the window to count as on screen. */
const GRAB = { width: 100, height: 28 };
export const SAVE_DELAY_MS = 500;

/** The frame to open with: the saved one when it fits a connected display, else null (centred default). */
export function restoreFrame(saved: SavedFrame | null, displays: Rect[]): SavedFrame | null {
  if (!saved) return null;
  const { x, y, width, height } = saved;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < MIN_SIZE.width || height < MIN_SIZE.height) return null;
  // The display under the title bar: the one it overlaps most.
  let best: Rect | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = overlap({ x, y, width, height: GRAB.height }, d);
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  if (!best) return null;
  // Enough of the title bar to grab it, and not bigger than that display.
  const visibleTitle = overlapWidth({ x, width }, best);
  if (visibleTitle < Math.min(GRAB.width, width) || y < best.y) return null;
  if (width > best.width || height > best.height) return null;
  return { x, y, width, height, zoomed: saved.zoomed, fullScreen: saved.fullScreen };
}

/** The default size (no larger than `on`), centred on `on`: the frame a window opens with. */
export function centred(on: Rect): Rect {
  const width = Math.min(DEFAULT_SIZE.width, on.width);
  const height = Math.min(DEFAULT_SIZE.height, on.height);
  return {
    x: on.x + Math.round((on.width - width) / 2),
    y: on.y + Math.round((on.height - height) / 2),
    width,
    height,
  };
}

function overlapWidth(a: { x: number; width: number }, b: { x: number; width: number }): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
}

function overlap(a: Rect, b: Rect): number {
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapWidth(a, b) * h;
}

/** A saved frame read back from disk, or null when there is none or it isn't one. */
export function parseFrame(text: string | null): SavedFrame | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const n = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : Number.NaN);
    const f = { x: n("x"), y: n("y"), width: n("width"), height: n("height") };
    if (!Object.values(f).every(Number.isFinite)) return null;
    return { ...f, zoomed: v.zoomed === true, fullScreen: v.fullScreen === true };
  } catch {
    return null;
  }
}

/** What the keeper reads of the window (Electrobun's BrowserWindow has these). */
export interface FrameSource {
  getFrame(): Rect;
  isMaximized(): boolean;
  isFullScreen(): boolean;
}

export interface FrameStoreDeps {
  read(): string | null;
  write(text: string): void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

/** The file in the app's data folder; written whole and renamed into place. */
export function fileStore(dataDir: string): Pick<FrameStoreDeps, "read" | "write"> {
  const path = join(dataDir, "window.json");
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    write: (text) => {
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    },
  };
}

/**
 * Saves the window's frame a moment after it stops moving (`changed`), and at once on `flush`
 * (quit, close, restart to update). The window is read when it moves, while it is surely open; only
 * the write waits. While zoomed or full screen the frame it would get back to is kept, with the
 * flag: unzooming after a relaunch then lands where the person had it.
 */
export class FrameKeeper {
  private timer: unknown = null;
  /** The frame on disk (or read from it at start). */
  private last: SavedFrame | null;
  /** A frame read but not written yet. */
  private pending: SavedFrame | null = null;
  private readonly d: Required<FrameStoreDeps>;

  constructor(deps: FrameStoreDeps) {
    this.d = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...deps,
    };
    this.last = parseFrame(this.d.read());
  }

  /** The frame saved last time, if any (before clamping to the displays). */
  saved(): SavedFrame | null {
    return this.last;
  }

  /** The window moved or resized: read it now, write it once it settles. */
  changed(win: FrameSource | null) {
    const snap = this.read(win);
    if (!snap) return;
    this.pending = snap;
    if (this.timer !== null) this.d.clearTimeout(this.timer);
    this.timer = this.d.setTimeout(() => {
      this.timer = null;
      this.write();
    }, SAVE_DELAY_MS);
  }

  /** Write now: from the window if it is still open (quit), else what was read last (closed). */
  flush(win: FrameSource | null = null) {
    if (this.timer !== null) {
      this.d.clearTimeout(this.timer);
      this.timer = null;
    }
    const snap = this.read(win);
    if (snap) this.pending = snap;
    this.write();
  }

  private read(win: FrameSource | null): SavedFrame | null {
    if (!win) return null;
    try {
      const zoomed = win.isMaximized();
      const fullScreen = win.isFullScreen();
      const frame = win.getFrame();
      // Zoomed or full screen: keep the frame it returns to, which was read before. With none (it
      // went full screen before it ever moved), not the full-screen frame: that covers the menu bar,
      // so restoreFrame would refuse it and the flag would be lost. The default size centred on it.
      const base = zoomed || fullScreen ? (this.pending ?? this.last ?? centred(frame)) : frame;
      return {
        x: Math.round(base.x),
        y: Math.round(base.y),
        width: Math.round(base.width),
        height: Math.round(base.height),
        zoomed,
        fullScreen,
      };
    } catch {
      return null;
    }
  }

  private write() {
    const next = this.pending;
    this.pending = null;
    if (!next) return;
    if (this.last && JSON.stringify(this.last) === JSON.stringify(next)) return;
    try {
      this.d.write(JSON.stringify(next));
      this.last = next;
    } catch {
      // A full disk: the last saved frame stays.
    }
  }
}
