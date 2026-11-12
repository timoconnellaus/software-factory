// Open terminal's pure parts (spec 42): which run's terminal the button opens, what the panel calls
// its stage, and the one line it shows when the terminal can't be reached.
import type { WorkItemDetail } from "@software-factory/client/ops";
import type { TerminalStatus } from "@software-factory/client/web-terminal";

/** The run whose terminal is open: enough to name it and to fall back to its tmux command. */
export interface TerminalRun {
  id: string;
  stage: string;
  runNo: number;
  takeover: { label: string; hint: string } | null;
}

/** How long the relay may wait for the runner before the panel says it may be offline. */
export const RUNNER_WAIT_MS = 20_000;

const STAGE: Record<string, string> = {
  spec: "Planning",
  triage: "Triage",
  build: "Build",
  verify: "Verify",
};
export const stageLabel = (stage: string) => STAGE[stage] ?? stage;

/** The one line under the terminal when something's wrong, or null. */
export function fallbackLine(
  verdict: { allowed: boolean; reason: string | null } | undefined,
  status: TerminalStatus,
  waitedMs: number,
): string | null {
  if (verdict && !verdict.allowed) return verdict.reason ?? "This session has no terminal.";
  if (status.phase === "waiting" && waitedMs >= RUNNER_WAIT_MS) {
    return "The runner hasn't connected: it may be offline or asleep.";
  }
  if (status.phase === "closed" && status.mode === null) {
    return "Couldn't reach the terminal: the runner may be offline, or the session has ended.";
  }
  return null;
}

/** The newest run that is still going (of a stage, when given): the session to open. */
export function terminalOf(runs: WorkItemDetail["runs"], stage?: string): TerminalRun | null {
  const live = [...runs].reverse().find((r) => !r.endedAt && (!stage || r.stage === stage));
  return live
    ? { id: live.id, stage: live.stage, runNo: live.runNo, takeover: live.takeover }
    : null;
}

/** The chord that always closes the terminal, even while the keyboard is in a session you type into. */
export const CLOSE_CHORD_LABEL = "⌘Esc";

/**
 * Whether a key press closes the terminal dock. Esc closes it, except in a terminal you can type into:
 * there Esc is the session's (Claude Code's interrupt) and xterm takes Tab, so ⌘Esc is the
 * keyboard-only way out. ⌘W stays the tab's (shortcuts.ts). A dialog or popover open: theirs.
 */
export function closesDock(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  at: { inTypingTerminal: boolean; overlayOpen: boolean },
): boolean {
  if (e.key !== "Escape" || at.overlayOpen) return false;
  if (e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.metaKey) return true;
  return !at.inTypingTerminal;
}
