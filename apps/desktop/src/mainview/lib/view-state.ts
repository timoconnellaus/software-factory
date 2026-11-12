// This Mac's view state (ADR 0460): the open tabs, pinned work items, the chosen org and whether the
// sidebar shows. It lives in the view (memory, mirrored to localStorage) and never reaches the
// factory. The reducers are pure, so the tests drive them without a DOM.
import { useSyncExternalStore } from "react";

export interface Tab {
  id: string;
  /** A route path with its search, as the router's `location.href` gives it (`/work/x?tab=runs`). */
  path: string;
}

export interface ViewState {
  tabs: Tab[];
  activeTab: string;
  /** Work item ids, in the order they were pinned. */
  pins: string[];
  /** The chosen org, or null for All. Undefined until the shell picks a default. */
  orgId: string | null | undefined;
  sidebar: boolean;
}

const KEY = "sf:view-state:v1";
let nextId = 1;
const newTabId = () => `tab-${Date.now().toString(36)}-${nextId++}`;

export function initialState(): ViewState {
  const id = newTabId();
  return { tabs: [{ id, path: "/" }], activeTab: id, pins: [], orgId: undefined, sidebar: true };
}

// ---- Tabs ---------------------------------------------------------------------------------------

/** The active tab follows navigation: its path becomes where the router now is. */
export function followNavigation(s: ViewState, path: string): ViewState {
  const active = s.tabs.find((t) => t.id === s.activeTab);
  if (!active || active.path === path) return s;
  return { ...s, tabs: s.tabs.map((t) => (t.id === s.activeTab ? { ...t, path } : t)) };
}

/** A new tab after the active one, made active. The caller navigates to `path`. */
export function openTab(s: ViewState, path: string, id = newTabId()): ViewState {
  const at = s.tabs.findIndex((t) => t.id === s.activeTab);
  const tabs = [...s.tabs];
  tabs.splice(at + 1, 0, { id, path });
  return { ...s, tabs, activeTab: id };
}

/**
 * Closes a tab. Closing the active one activates its right neighbour (else its left). The last tab
 * never closes: it goes back to the Inbox instead. Returns the path to navigate to, if any.
 */
export function closeTab(s: ViewState, id: string): { state: ViewState; navigate: string | null } {
  const at = s.tabs.findIndex((t) => t.id === id);
  if (at < 0) return { state: s, navigate: null };
  if (s.tabs.length === 1) {
    const only = { id: s.tabs[0]?.id ?? newTabId(), path: "/" };
    return { state: { ...s, tabs: [only], activeTab: only.id }, navigate: "/" };
  }
  const tabs = s.tabs.filter((t) => t.id !== id);
  if (id !== s.activeTab) return { state: { ...s, tabs }, navigate: null };
  const next = tabs[Math.min(at, tabs.length - 1)] as Tab;
  return { state: { ...s, tabs, activeTab: next.id }, navigate: next.path };
}

/** Switches to a tab. Returns its path to navigate to. */
export function activateTab(s: ViewState, id: string): { state: ViewState; navigate: string | null } {
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return { state: s, navigate: null };
  return { state: { ...s, activeTab: id }, navigate: tab.path };
}

// ---- Pins, org, sidebar -------------------------------------------------------------------------

export function togglePin(s: ViewState, workItemId: string): ViewState {
  return s.pins.includes(workItemId)
    ? { ...s, pins: s.pins.filter((p) => p !== workItemId) }
    : { ...s, pins: [...s.pins, workItemId] };
}

export const chooseOrg = (s: ViewState, orgId: string | null): ViewState => ({ ...s, orgId });
export const toggleSidebar = (s: ViewState): ViewState => ({ ...s, sidebar: !s.sidebar });

// ---- Persistence --------------------------------------------------------------------------------

/** Reads a stored state, dropping anything malformed (an older shape, or someone's edit). */
export function parseStored(raw: string | null): ViewState {
  const base = initialState();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<ViewState>;
    const tabs = Array.isArray(v.tabs)
      ? v.tabs.filter(
          (t): t is Tab =>
            !!t && typeof t.id === "string" && typeof t.path === "string" && t.path.startsWith("/"),
        )
      : [];
    const pins = Array.isArray(v.pins) ? v.pins.filter((p) => typeof p === "string") : [];
    const activeTab = tabs.some((t) => t.id === v.activeTab) ? (v.activeTab as string) : tabs[0]?.id;
    return {
      tabs: tabs.length && activeTab ? tabs : base.tabs,
      activeTab: tabs.length && activeTab ? activeTab : base.activeTab,
      pins,
      orgId: typeof v.orgId === "string" || v.orgId === null ? v.orgId : undefined,
      sidebar: v.sidebar !== false,
    };
  } catch {
    return base;
  }
}

function load(): ViewState {
  try {
    return parseStored(localStorage.getItem(KEY));
  } catch {
    // Storage blocked: the state lives in memory for this window.
    return initialState();
  }
}

let state: ViewState | null = null;
const listeners = new Set<() => void>();

function current(): ViewState {
  state ??= load();
  return state;
}

export function getViewState(): ViewState {
  return current();
}

export function updateViewState(f: (s: ViewState) => ViewState): void {
  const prev = current();
  const next = f(prev);
  if (next === prev) return;
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore: see load()
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useViewState<T>(select: (s: ViewState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(current()),
    () => select(current()),
  );
}
