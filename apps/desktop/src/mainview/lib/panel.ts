// The item side panel's width (spec 41 slice 7, design WorkActivePanel): about 520px, never more
// than half the content area so the list beside it stays readable, as the person dragged it
// (remembered in this browser only: a convenience), and the whole page area when that is too
// narrow to share. Pure apart from the storage, so the tests pin it.
/** The panel's width: about 520px, at most half the content area, as dragged (remembered). */
export const PANEL_DEFAULT = 520;
export const PANEL_MIN = 360;
const PANEL_KEY = "sf.itemPanel.width";
/** Below this the page beside the list is too narrow to share: the panel takes all of it. */
export const PANEL_FULL_BELOW = 720;

export function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(PANEL_KEY));
    return Number.isFinite(n) && n >= PANEL_MIN ? n : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

/**
 * The panel's width in a page area this wide, beside a list this wide: the wanted width, never
 * under 360px nor over half the content area (list and page), or the whole page area when it is
 * too narrow to share. Pure, so the tests pin it.
 */
export function panelWidth(wanted: number, page: number, list: number): number {
  if (page < PANEL_FULL_BELOW) return page;
  const half = Math.floor((page + list) / 2);
  return Math.max(PANEL_MIN, Math.min(wanted, half));
}

export function rememberWidth(w: number): void {
  try {
    localStorage.setItem(PANEL_KEY, String(w));
  } catch {
    // Not remembered: the width still applies until the panel closes.
  }
}
