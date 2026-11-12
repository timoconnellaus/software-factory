// The window's keyboard shortcuts (spec 41): one table, matched from a key event, so the shell and
// the tests agree. None fires while you type in a field, except the ones that make sense there
// (search, New item, close the tab).

export type ShortcutAction =
  | "search"
  | "new-item"
  | "inbox"
  | "work"
  | "settings"
  | "back"
  | "forward"
  | "sidebar"
  | "new-tab"
  | "close-tab"
  | "list-next"
  | "list-prev";

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface Shortcut {
  action: ShortcutAction;
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  /** Fires while focus is in a text field. */
  inFields?: boolean;
  /** Shown in menus and tooltips. */
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { action: "search", key: "k", meta: true, inFields: true, label: "⌘K" },
  { action: "new-item", key: "n", meta: true, inFields: true, label: "⌘N" },
  { action: "new-item", key: "n", label: "N" },
  { action: "inbox", key: "1", meta: true, label: "⌘1" },
  { action: "work", key: "2", meta: true, label: "⌘2" },
  { action: "settings", key: ",", meta: true, label: "⌘," },
  { action: "back", key: "[", meta: true, label: "⌘[" },
  { action: "forward", key: "]", meta: true, label: "⌘]" },
  { action: "sidebar", key: "s", meta: true, ctrl: true, label: "⌃⌘S" },
  { action: "new-tab", key: "t", meta: true, label: "⌘T" },
  { action: "close-tab", key: "w", meta: true, inFields: true, label: "⌘W" },
  { action: "list-next", key: "ArrowDown", label: "↓" },
  { action: "list-prev", key: "ArrowUp", label: "↑" },
];

export function shortcutLabel(action: ShortcutAction): string {
  return SHORTCUTS.find((s) => s.action === action)?.label ?? "";
}

/** The action a key press asks for, or null. `inField`: focus is in an input, textarea or editor. */
export function matchShortcut(e: KeyLike, inField: boolean): ShortcutAction | null {
  if (e.altKey || e.shiftKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const s of SHORTCUTS) {
    if (s.key !== key) continue;
    if (!!s.meta !== e.metaKey || !!s.ctrl !== e.ctrlKey) continue;
    if (inField && !s.inFields) continue;
    return s.action;
  }
  return null;
}

/** Whether an element is somewhere you type. */
export function isTypingTarget(el: Element | null): boolean {
  return !!el?.closest("input, textarea, select, [contenteditable=true], [role=combobox]");
}
