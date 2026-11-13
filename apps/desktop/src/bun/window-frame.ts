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
 * (quit, close, restart to update). While zoomed or full screen the frame it would get back to is
 * kept, with the flag: unzooming after a relaunch then lands where the person had it.
 */
export class FrameKeeper {
  private timer: unknown = null;
  private last: SavedFrame | null;
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

  changed(win: FrameSource | null) {
    if (!win) return;
    if (this.timer !== null) this.d.clearTimeout(this.timer);
    this.timer = this.d.setTimeout(() => {
      this.timer = null;
      this.save(win);
    }, SAVE_DELAY_MS);
  }

  flush(win: FrameSource | null) {
    if (this.timer !== null) {
      this.d.clearTimeout(this.timer);
      this.timer = null;
    }
    if (win) this.save(win);
  }

  private save(win: FrameSource) {
    try {
      const zoomed = win.isMaximized();
      const fullScreen = win.isFullScreen();
      const frame = win.getFrame();
      // Zoomed or full screen: keep the frame it returns to, which was saved before.
      const base = (zoomed || fullScreen) && this.last ? this.last : frame;
      const next: SavedFrame = {
        x: Math.round(base.x),
        y: Math.round(base.y),
        width: Math.round(base.width),
        height: Math.round(base.height),
        zoomed,
        fullScreen,
      };
      const same = this.last && JSON.stringify(this.last) === JSON.stringify(next);
      this.last = next;
      if (!same) this.d.write(JSON.stringify(next));
    } catch {
      // A window already gone, or a full disk: the last saved frame stays.
    }
  }
}
