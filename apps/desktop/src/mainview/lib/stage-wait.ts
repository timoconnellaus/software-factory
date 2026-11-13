// What a stage is waiting on (the owner's report, 2026-11-13): an item in verify showed "1 running"
// while every runner slot was free. It was waiting on GitHub's CI after the runner handed back,
// which read as a stall. The server says what each running or waiting item waits on
// (`waitingOn`, core's waiting-on.ts) in the reads the app already polls (`workItem.board`,
// `workItem.list`, `workItem.get`), from the item's gates, questions, jobs, review packet and merge
// queue entry. This only puts it in words. A fact the server doesn't give (null) is left unsaid,
// and so is a read that failed: the last answer may no longer be true.
// Pure, for the tests.
import type { BoardItem } from "@software-factory/client/ops";

export type WaitingOn = BoardItem["waitingOn"];

const stageName = (stage: string) => `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;

/**
 * "Verify: waiting on CI", "Merge: in the queue (position 2)", …, or null: an agent is working on
 * it (the card says Working), the item isn't moving on its own, or the server doesn't say.
 */
export function stageWait(item: {
  stage: string;
  status: string;
  waitingOn?: WaitingOn | undefined;
}): string | null {
  const w = item.waitingOn;
  if (!w || (item.status !== "running" && item.status !== "waiting")) return null;
  const at = stageName(item.stage);
  switch (w.kind) {
    case "agent":
      return null;
    case "person":
      return w.on === "question"
        ? `${at}: waiting for an answer`
        : `${at}: waiting for an approval`;
    case "runner":
      return `${at}: waiting for a runner`;
    case "ci":
      return w.position === 1 ? `${at}: waiting on CI (next to land)` : `${at}: waiting on CI`;
    case "updating":
      return `${at}: updating from the default branch (next to land)`;
    case "queue":
      if (w.held) return `${at}: held, the default branch is red`;
      if (w.merging) return `${at}: merging`;
      if (w.position === undefined) return null;
      return w.position === 1
        ? `${at}: in the queue (position 1, next to land)`
        : `${at}: in the queue (position ${w.position})`;
  }
  return null;
}

/** An agent holds a job for it on a runner now: what "Agent working" counts. */
export const agentWorking = (item: { waitingOn?: WaitingOn | undefined }) =>
  item.waitingOn?.kind === "agent";
