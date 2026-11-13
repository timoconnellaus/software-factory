// The window's frame while the app loads: the same layout as the signed-in window (routes/_app.tsx)
// with its toolbar as the title-bar drag region, filling the window at any size. index.html draws
// it before any script runs (the preload makes the strip draggable), and WindowSkeleton draws it
// again from React until the shell's first read lands, so nothing moves when the app takes over.
// The classes live here so the two can't drift (test/window-shell.test.ts reads index.html).
import { DRAG } from "./title-bar.ts";

export const SHELL = {
  window: "flex h-dvh select-none flex-col bg-window text-ink",
  /** The toolbar's own height and inset (shell-toolbar.tsx): the traffic lights sit in it. */
  toolbar: `${DRAG} flex h-11 flex-none items-center gap-1 pr-2.5 pl-[84px]`,
  body: "flex min-h-0 flex-1 pr-2",
  rail: "flex w-[52px] flex-none flex-col items-center gap-2 pt-1 pb-2.5",
  sidebar: "flex w-[196px] flex-none flex-col gap-2 pt-1.5 pr-2 pb-2.5 pl-3",
  panel: "flex min-w-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl bg-panel p-6 shadow-panel",
  status: "h-7 flex-none",
} as const;

/**
 * A double-click on the title bar before the app's script ran (index.html queues it as
 * `window.__sfEarlyDoubleClick`): main.tsx acts on it once it can reach the main process, if it is
 * recent enough that the person is still waiting for it.
 */
export const EARLY_DOUBLE_CLICK_MS = 1_500;
export function takeEarlyDoubleClick(win: { __sfEarlyDoubleClick?: number }, now: number): boolean {
  const at = win.__sfEarlyDoubleClick;
  win.__sfEarlyDoubleClick = undefined;
  return typeof at === "number" && now - at >= 0 && now - at < EARLY_DOUBLE_CLICK_MS;
}
