// Whether a CSS media query matches, kept current as the window resizes (review of #130: the
// planning panes fit a narrow window by folding the chat and the write-back list).
import { useSyncExternalStore } from "react";

/** The store behind `useMedia`: subscribe to the query's changes, and read it now. */
export function mediaStore(query: string) {
  return {
    subscribe(onChange: () => void) {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    read: () => window.matchMedia(query).matches,
  };
}

export function useMedia(query: string): boolean {
  const store = mediaStore(query);
  return useSyncExternalStore(store.subscribe, store.read, () => true);
}

/** Wide enough for the questions, the workspace and the chat side by side. */
export const WIDE_PLANNING = "(min-width: 1100px)";

/**
 * How the planning panes sit in the window (review of #130): in a narrow one the chat folds to its
 * strip even in focus, the side panes narrow, and the write-back list starts folded.
 */
export function planningLayout(focus: boolean, wide: boolean) {
  return {
    chatPinned: focus && wide,
    questionsWidth: wide ? (focus ? "w-[336px]" : "w-[300px]") : "w-[268px]",
    chatWidth: wide ? "w-[330px]" : "w-[300px]",
    writeBackOpen: wide,
  };
}
