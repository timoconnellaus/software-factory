// The toolbar is the window's title bar (spec 41): it drags the window, and a double-click on its
// empty space does the system's title-bar action (zoom, minimise or nothing; the main process reads
// the setting). Buttons, tabs, links and fields keep their own clicks, as does anything marked
// no-drag. Electrobun's preload handles the drag; the double-click is ours.

export const DRAG = "electrobun-webkit-app-region-drag";
export const NO_DRAG = "electrobun-webkit-app-region-no-drag";

const INTERACTIVE =
  "button, a, input, textarea, select, label, [role=tab], [role=button], [role=link], [contenteditable=true]";

/** Whether a point is the title bar's empty space: in a drag region, on nothing you can use. */
export function isTitleBarSpace(target: Element | null): boolean {
  if (!target || target.closest(INTERACTIVE)) return false;
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el.classList.contains(NO_DRAG)) return false;
    if (el.classList.contains(DRAG)) return true;
  }
  return false;
}

/** Calls `onDoubleClick` for a double-click on the title bar's empty space. */
export function onTitleBarDoubleClick(doc: Document, onDoubleClick: () => void): () => void {
  const listener = (e: MouseEvent) => {
    if (e.button === 0 && isTitleBarSpace(e.target as Element | null)) onDoubleClick();
  };
  doc.addEventListener("dblclick", listener);
  return () => doc.removeEventListener("dblclick", listener);
}
