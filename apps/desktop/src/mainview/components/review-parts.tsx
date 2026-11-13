// The merge gate's parts (spec 41, design InboxMerge/ItemReview), shared by the Inbox and the work
// item's Review tab: the verdict, the criteria met or not, and Your decision. Merge and Send
// back go through `decide()`, so each asks for Touch ID once (ADR 0391); only the look changed.
import type { WorkItemDetail } from "@software-factory/client/ops";
import {
  keptOnRunner,
  type ParsedPacket,
  packetExecuted,
  packetProof,
} from "@software-factory/client/packet";
import { Button } from "@software-factory/ui/components/button";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { useEffect, useState } from "react";
import { useDecide } from "../lib/decisions.tsx";
import { verdictChips, verdictHeadline } from "../lib/review.ts";
import {
  CriterionProofNote,
  criterionMark,
  NoChecksNotice,
  noChecksSetUp,
} from "./factory-checks.tsx";
import { Chip, Field, Panel } from "./shell-list.tsx";

const OPENED_KEY = (id: string) => `sf:opened-diff:${id}`;

/** Whether the approver opened the full diff (or the GitHub PR) for this head SHA. */
export function useOpenedFullDiff(workItemId: string, headSha: string | undefined) {
  const key = `${OPENED_KEY(workItemId)}:${headSha ?? ""}`;
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    try {
      setOpened(sessionStorage.getItem(key) === "1");
    } catch {
      // Storage blocked: the flag lives in memory for this page only.
    }
  }, [key]);
  const mark = () => {
    setOpened(true);
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      // ignore
    }
  };
  return [opened, mark] as const;
}

export function VerdictPanel({
  packet,
  children,
}: {
  packet: ParsedPacket;
  children?: React.ReactNode;
}) {
  const head = verdictHeadline(packet);
  return (
    <Panel data-testid="section-verdict">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot status={head.status} className="!size-2.5" />
        <span className="font-semibold text-[17px]">{head.text}</span>
      </div>
      {children}
      <div className="flex flex-wrap items-center gap-2">
        {verdictChips(packet).map((c) => (
          <Chip key={c.label}>
            <StatusDot status={c.status} />
            {c.label}
          </Chip>
        ))}
      </div>
    </Panel>
  );
}

/**
 * The acceptance criteria as the verify run reported them, with its evidence. From Workflow v8 a
 * met criterion is marked Proven or Not proven by the factory's own checks (spec 51 PR B, ADR 0501);
 * a packet from before shows the run's own claim (`met`).
 */
export function CriteriaList({ packet }: { packet: ParsedPacket }) {
  const noChecks = noChecksSetUp(packet);
  // No checks set up: no per-criterion "Not proven", one notice instead (the owner's decision).
  const proofs = noChecks ? null : packetProof(packet);
  if (packet.criteria.length === 0) {
    return <Panel className="text-ink-muted">The packet has no criteria.</Panel>;
  }
  const list = (
    <div className="overflow-hidden rounded-[10px] bg-panel shadow-panel" data-testid="criteria">
      {packet.criteria.map((c) => {
        const runner = keptOnRunner(c.evidence);
        // Spec 51 PR B (ADR 0501): Proven only by a check the approved spec links; else opinion.
        const proof = proofs?.get(c.criterion);
        const mark = criterionMark(c.met, proof, noChecks);
        return (
          <div
            key={c.criterion}
            className="flex gap-3 border-line-soft border-t px-3.5 py-3 first:border-t-0"
            data-met={c.met}
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium">{c.criterion}</div>
              {proof && !runner && <CriterionProofNote proof={proof} />}
              <div className="mt-0.5 font-mono text-[12.5px] text-ink-3 leading-normal">
                {(proof || noChecks) && !runner ? "Reviewer's opinion: " : ""}
                {runner ? `kept on runner · ${runner}` : c.evidence || "no evidence"}
              </div>
            </div>
            <span className="flex flex-none items-center gap-1.5 self-start font-medium">
              <StatusDot status={mark.status} />
              {mark.label}
            </span>
          </div>
        );
      })}
    </div>
  );
  if (!noChecks) return list;
  return (
    <div className="flex flex-col gap-2">
      <NoChecksNotice />
      {list}
    </div>
  );
}

/** Your decision: a note (required to send back), Merge <sha>, Send back. */
export function MergeDecision({
  detail,
  packet,
  opened,
}: {
  detail: WorkItemDetail;
  packet: ParsedPacket;
  opened: boolean;
}) {
  const { item } = detail;
  const mergeGate = detail.gates.find((g) => g.kind === "merge" && g.status === "pending");
  const canDecide = !!mergeGate && detail.viewer.isApprover;
  const { decide, pending } = useDecide();
  const [note, setNote] = useState("");
  const sha = packet.headSha.slice(0, 7);
  // Declared checks the runner could not run (ADR 0501, fourth review): merging is an explicit
  // decision to merge without them, recorded with the merge.
  const executed = packetExecuted(packet);
  const without = executed && !executed.waived ? executed.notRun.map((n) => n.name) : [];
  if (!mergeGate) return null;
  return (
    <Panel needsYou className="gap-2.5" data-testid="decision">
      <h2 className="m-0 font-semibold text-[13px]">Your decision</h2>
      <Field htmlFor="merge-note" label="Note, required when sending back">
        <Textarea
          id="merge-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="min-h-[68px] resize-y"
          data-testid="note-input"
        />
      </Field>
      <Button
        disabled={!canDecide || pending !== null}
        title={
          detail.viewer.isApprover
            ? "Asks for Touch ID"
            : "Only an approver on this project can merge"
        }
        onClick={() =>
          decide({
            kind: "review.merge",
            workItemId: item.id,
            openedFullDiff: opened,
            headSha: packet.headSha,
            ...(without.length > 0 ? { mergeWithoutChecks: true } : {}),
          })
        }
        data-testid="merge"
      >
        {pending === "review.merge"
          ? "Merging…"
          : without.length > 0
            ? `Merge ${sha} without these checks`
            : `Merge ${sha}`}
      </Button>
      {without.length > 0 && (
        <p className="m-0 text-amber-700 text-xs leading-normal dark:text-amber-400">
          {without.length === 1 ? "1 declared check" : `${without.length} declared checks`} could
          not be run on the runner ({without.join(", ")}). Merging means merging without them;
          that's recorded.
        </p>
      )}
      <Button
        variant="outline"
        disabled={!canDecide || pending !== null || !note.trim()}
        title={note.trim() ? "Asks for Touch ID" : "Write a note first: it goes back to the build"}
        onClick={async () => {
          const ok = await decide({
            kind: "review.sendBack",
            workItemId: item.id,
            note: note.trim(),
            openedFullDiff: opened,
          });
          if (ok) setNote("");
        }}
        data-testid="send-back"
      >
        Send back
      </Button>
      <p className="m-0 text-ink-3 leading-normal">
        The approval is for this commit only. It then waits its turn in the merge queue.
      </p>
      <p className="m-0 text-ink-muted text-xs">
        {opened ? "You opened the full diff." : "You haven't opened the full diff."} That's recorded
        with your decision.
      </p>
    </Panel>
  );
}
