// What a stage is waiting on when no job is running for it (the owner's report, 2026-11-13): an
// item in verify showed "1 running" while every runner slot was free. It was waiting on GitHub's CI
// after the runner handed back, which read as a stall. So wherever a stage is shown, a stage with
// no job running says what it waits on, from facts the app already reads:
// - `workItem.get`: the stage history (when this attempt began), the runs (a verify run active, or
//   ended), the review packet (recorded once CI has answered) and `mergeQueue` (the position);
// - `delivery.status`: the item's place in the merge queue and whether main being red holds it.
// What neither read says is left unsaid rather than guessed: whether the queue's head is updating
// from main or waiting on CI there (no server read exposes the queue head's step yet).
// Pure, for the tests.

/** A run that holds a runner slot (core's ACTIVE_RUN_STATUSES). */
const ACTIVE_RUN = new Set(["claimed", "preparing", "running", "collecting"]);

export interface StageFacts {
  item: { stage: string; status: string };
  /** `workItem.get`'s stage history. */
  stages?: { stage: string; startedAt: string; endedAt: string | null }[];
  runs?: { stage: string; status: string; startedAt: string; endedAt: string | null }[];
  reviewPacket?: { createdAt: string } | null;
  mergeQueue?: { position: number } | null;
  /** The item's entry in `delivery.status`, with its repository's default branch. */
  delivery?: { position: number; state: "merging" | "waiting" | "held"; branch: string } | null;
}

const at = (s: string) => Date.parse(s);

/**
 * "Verify: waiting on CI", "Verify: waiting for a runner", "Merge: in the queue (position N)", …,
 * or null: a job is running for the stage, the item isn't moving on its own (paused, done, needs
 * a person), or the facts don't say.
 */
export function stageWait(f: StageFacts): string | null {
  const { stage, status } = f.item;
  if (status !== "running" && status !== "waiting") return null;
  const runs = (f.runs ?? []).filter((r) => r.stage === stage);
  if (runs.some((r) => ACTIVE_RUN.has(r.status))) return null;
  if (stage === "verify") {
    if (!f.stages) return null;
    // This attempt at verify: the latest one still open.
    const attempt = [...f.stages].reverse().find((s) => s.stage === "verify" && !s.endedAt);
    if (!attempt) return null;
    const since = at(attempt.startedAt);
    const mine = runs
      .filter((r) => at(r.startedAt) >= since)
      .sort((a, b) => at(b.startedAt) - at(a.startedAt));
    const last = mine[0];
    if (!last) return "Verify: waiting for a runner";
    if (!last.endedAt) return null;
    // The runner handed back; the packet is recorded once GitHub's CI has answered.
    const packet = f.reviewPacket ? at(f.reviewPacket.createdAt) : null;
    if (packet === null || packet < at(last.endedAt)) return "Verify: waiting on CI";
    return null;
  }
  if (stage === "merge") {
    const d = f.delivery;
    if (d?.state === "held") return `Merge: held, ${d.branch} is red`;
    const position = d?.position ?? f.mergeQueue?.position ?? null;
    if (position === null) return null;
    return position === 1
      ? "Merge: in the queue (position 1, next to land)"
      : `Merge: in the queue (position ${position})`;
  }
  return null;
}
