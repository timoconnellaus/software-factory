// Which work items have their terminal open (spec 42, spec 41 slice 7). Held here rather than in
// the Open terminal button, so the terminal stays open when the item side panel expands to the
// item's page (the button and its dock remount there), and so the panel can close its item's
// terminal, releasing the socket, when it closes or shows another item.
import { useSyncExternalStore } from "react";
import type { TerminalRun } from "./terminal.ts";

let open = new Map<string, TerminalRun>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function openTerminal(workItemId: string, run: TerminalRun): void {
  open = new Map(open).set(workItemId, run);
  emit();
}

export function closeTerminal(workItemId: string): void {
  if (!open.has(workItemId)) return;
  open = new Map(open);
  open.delete(workItemId);
  emit();
}

/** Every terminal closed (another account signed in: they were the previous account's runs). */
export function closeAllTerminals(): void {
  if (open.size === 0) return;
  open = new Map();
  emit();
}

export function terminalFor(workItemId: string): TerminalRun | null {
  return open.get(workItemId) ?? null;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The item's open terminal, or null; re-renders when it opens or closes. */
export function useOpenTerminal(workItemId: string): TerminalRun | null {
  return useSyncExternalStore(subscribe, () => open.get(workItemId) ?? null);
}
