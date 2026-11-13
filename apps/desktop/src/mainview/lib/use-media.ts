// Whether a CSS media query matches, kept current as the window resizes (review of #130: the
// planning panes fit a narrow window by folding the chat and the write-back list).
import { useSyncExternalStore } from "react";

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

/** Wide enough for the questions, the workspace and the chat side by side. */
export const WIDE_PLANNING = "(min-width: 1100px)";
/** Tall enough to open the write-back list under the panes without crowding them. */
export const TALL_PLANNING = "(min-height: 860px)";
