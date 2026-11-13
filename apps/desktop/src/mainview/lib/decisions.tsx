// Gate and question decisions, shared by the Inbox, the Planning tab and the review packet (ported
// from sf-app, spec 40 M3). Each action is exactly one gate decision through `decide()`: the main
// process asks for a presence challenge, Touch ID shows the engine's summary of the call, and only
// then is the call sent with the proof (ADR 0381). A repeat decision reports "already decided";
// a cancelled Touch ID decides nothing.
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Textarea } from "@software-factory/ui/components/textarea";
import { useState } from "react";
import { toast } from "sonner";
import { decide as decideOp, OpError, submitKey } from "./op.ts";
import { useRefreshAfterDecision } from "./queries.ts";

export type Decision =
  | {
      kind: "spec.approve";
      workItemId: string;
      /** Spec 24: for a split, the version and work items the person saw (review of #173). */
      specVersion?: number;
      splitDigest?: string;
    }
  | { kind: "spec.requestChanges"; workItemId: string; note: string }
  | {
      kind: "review.merge";
      workItemId: string;
      openedFullDiff: boolean;
      /**
       * The commit the person is looking at (the review packet's head). The approval and its proof
       * are for that commit only: a push in between is refused (spec 40 M4b, spec 60).
       */
      headSha: string;
      /** The person merges without the checks the runner could not run (ADR 0501): recorded. */
      mergeWithoutChecks?: boolean;
    }
  | { kind: "review.sendBack"; workItemId: string; note: string; openedFullDiff: boolean }
  | {
      kind: "question.answer";
      workItemId: string;
      questionId: string;
      answer: string;
      note?: string;
    }
  | { kind: "question.acceptDefaults"; workItemId: string }
  | {
      /** A security, privacy or irreversible planning question: still Touch ID (spec 26). */
      kind: "planning.answer";
      workItemId: string;
      questionId: string;
      /** The question revision the person answered (a newer one is refused). */
      questionRevision?: number;
      answer?: string;
      note?: string;
      skipped?: boolean;
    }
  | {
      kind: "approval.decide";
      workItemId?: string;
      pendingActionId: string;
      decision: "approved" | "rejected";
    }
  | { kind: "workItem.markRepair"; workItemId: string; repair: boolean };

const DONE: Record<Decision["kind"], string> = {
  "spec.approve": "Spec approved",
  "spec.requestChanges": "Sent back to planning",
  "review.merge": "Merging",
  "review.sendBack": "Sent back to build",
  "question.answer": "Answered",
  "question.acceptDefaults": "Accepted the remaining defaults",
  "planning.answer": "Answered",
  "approval.decide": "Decided",
  "workItem.markRepair": "Marked as a repair",
};

export async function run(d: Decision): Promise<string> {
  const key = { idempotencyKey: submitKey() };
  switch (d.kind) {
    case "spec.approve": {
      const r = await decideOp(
        "spec.approve",
        {
          workItemId: d.workItemId,
          ...(d.specVersion !== undefined ? { specVersion: d.specVersion } : {}),
          ...(d.splitDigest !== undefined ? { splitDigest: d.splitDigest } : {}),
        },
        key,
      );
      return r.alreadyDecided ? "Already decided" : DONE[d.kind];
    }
    case "spec.requestChanges": {
      const r = await decideOp(
        "spec.requestChanges",
        { workItemId: d.workItemId, note: d.note },
        key,
      );
      return r.alreadyDecided ? "Already decided" : DONE[d.kind];
    }
    case "review.merge": {
      const r = await decideOp(
        "review.merge",
        {
          workItemId: d.workItemId,
          openedFullDiff: d.openedFullDiff,
          headSha: d.headSha,
          ...(d.mergeWithoutChecks ? { mergeWithoutChecks: true } : {}),
        },
        key,
      );
      return r.alreadyDecided ? "Already decided" : DONE[d.kind];
    }
    case "review.sendBack": {
      const r = await decideOp(
        "review.sendBack",
        { workItemId: d.workItemId, note: d.note, openedFullDiff: d.openedFullDiff },
        key,
      );
      if (r.alreadyDecided) return "Already decided";
      return r.incidentId ? `${DONE[d.kind]} · factory incident opened` : DONE[d.kind];
    }
    case "question.answer": {
      const r = await decideOp(
        "question.answer",
        { questionId: d.questionId, answer: d.answer, ...(d.note ? { note: d.note } : {}) },
        key,
      );
      return r.revised ? "Answer changed" : r.answered ? DONE[d.kind] : "Already answered";
    }
    case "planning.answer": {
      const r = await decideOp(
        "planning.answer",
        {
          questionId: d.questionId,
          ...(d.questionRevision !== undefined ? { questionRevision: d.questionRevision } : {}),
          ...(d.answer !== undefined ? { answer: d.answer } : {}),
          ...(d.note ? { note: d.note } : {}),
          ...(d.skipped ? { skipped: true } : {}),
        },
        key,
      );
      return r.revised ? "Answer changed" : d.skipped ? "Skipped" : DONE[d.kind];
    }
    case "question.acceptDefaults": {
      const r = await decideOp("question.acceptDefaults", { workItemId: d.workItemId }, key);
      return r.skipped.length
        ? `Accepted ${r.accepted.length}; ${r.skipped.length} must be answered one by one`
        : `Accepted ${r.accepted.length} default${r.accepted.length === 1 ? "" : "s"}`;
    }
    case "workItem.markRepair": {
      const r = await decideOp(
        "workItem.markRepair",
        { workItemId: d.workItemId, repair: d.repair },
        key,
      );
      return r.repair ? DONE[d.kind] : "No longer a repair";
    }
    case "approval.decide": {
      const r = await decideOp(
        "approval.decide",
        { pendingActionId: d.pendingActionId, decision: d.decision },
        key,
      );
      return r.alreadyDecided
        ? "Already decided"
        : d.decision === "approved"
          ? "Approved"
          : "Rejected";
    }
  }
}

/**
 * Every released build before the key helper has a software key, and the engine refuses its proofs
 * (ADR 0391 decision 4): the person is told plainly what to do, never shown the raw refusal.
 */
export const SOFTWARE_KEY_TEXT =
  "This Mac can't approve yet: its key isn't in the Secure Enclave. Update the app, then sign in again.";

/** The engine's refusal of a proof from a software key (desktop.ts, `presence.redeem`). */
export function isSoftwareKeyRefusal(error: unknown): boolean {
  return (
    error instanceof OpError &&
    error.code === "forbidden" &&
    /isn't in the Secure Enclave/.test(error.message)
  );
}

/** Asks the main process to check for updates (loaded on use: tests import this file in Node). */
export const checkForUpdates = () =>
  import("../bridge.ts").then(({ bun }) => bun.updateAction({ action: "check" }));

/** Runs decisions with a pending state, a toast and a refresh of the inbox and the item. */
export function useDecide() {
  const refresh = useRefreshAfterDecision();
  const [pending, setPending] = useState<string | null>(null);
  async function decide(d: Decision, tag: string = d.kind): Promise<boolean> {
    setPending(tag);
    try {
      toast.success(await run(d));
      return true;
    } catch (error) {
      if (error instanceof OpError && error.code === "cancelled") {
        toast("Cancelled: nothing was decided");
      } else if (isSoftwareKeyRefusal(error)) {
        toast.error(SOFTWARE_KEY_TEXT, {
          duration: 15_000,
          action: { label: "Check for updates", onClick: () => void checkForUpdates() },
        });
      } else {
        toast.error(error instanceof OpError ? error.message : "Something went wrong");
      }
      return false;
    } finally {
      setPending(null);
      await refresh(d.workItemId);
    }
  }
  return { decide, pending };
}

/** A dialog that asks for a required note (request changes, send back, reply). */
export function NoteDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  confirm,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  placeholder?: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: (note: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!note.trim()) return;
    setBusy(true);
    const ok = await onConfirm(note.trim());
    setBusy(false);
    if (ok) {
      setNote("");
      onOpenChange(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={5}
          value={note}
          placeholder={placeholder}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          data-testid="note-input"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!note.trim() || busy}
            onClick={submit}
            data-testid="note-confirm"
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
