// An approval that was withdrawn (spec 53, decision 1; ADR 0587): the reopened merge gate says so,
// plainly, with why. From the item's own gates (workItem.get): while a merge gate is open, the most
// recently decided merge gate before it, when that one was withdrawn.
interface GateRow {
  kind: string;
  status: string;
  decision: string | null;
  createdAt: string;
  decidedAt: string | null;
  note: string | null;
}

export interface Withdrawal {
  /** When the approval was withdrawn. */
  at: string;
  /** Why, as the factory recorded it (without its `withdrawn: ` prefix). */
  reason: string;
}

export function withdrawnBefore(gates: readonly GateRow[]): Withdrawal | null {
  const open = gates.find((g) => g.kind === "merge" && g.status === "pending");
  if (!open) return null;
  const decided = gates
    .filter((g) => g.kind === "merge" && g.status !== "pending" && g.decidedAt)
    .filter((g) => (g.decidedAt ?? "") <= open.createdAt)
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
  const last = decided[0];
  if (last?.decision !== "withdrawn" || !last.decidedAt) return null;
  return {
    at: last.decidedAt,
    reason: (last.note ?? "it was withdrawn").replace(/^withdrawn: /, ""),
  };
}

/** The line the reopened gate shows. */
export const withdrawnText = (w: Withdrawal, ago: (iso: string) => string) =>
  `Your approval was withdrawn ${ago(w.at)} because ${w.reason}; it has been verified again.`;
