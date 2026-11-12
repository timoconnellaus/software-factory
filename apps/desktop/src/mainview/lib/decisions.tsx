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
  | { kind: "spec.approve"; workItemId: string }
  | { kind: "spec.requestChanges"; workItemId: string; note: string }
  | { kind: "review.merge"; workItemId: string; openedFullDiff: boolean }
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
      kind: "approval.decide";
      workItemId?: string;
      pendingActionId: string;
      decision: "approved" | "rejected";
    };

const DONE: Record<Decision["kind"], string> = {
  "spec.approve": "Spec approved",
  "spec.requestChanges": "Sent back to planning",
  "review.merge": "Merging",
  "review.sendBack": "Sent back to build",
  "question.answer": "Answered",
  "question.acceptDefaults": "Accepted the remaining defaults",
  "approval.decide": "Decided",
};

export async function run(d: Decision): Promise<string> {
  const key = { idempotencyKey: submitKey() };
  switch (d.kind) {
    case "spec.approve": {
      const r = await decideOp("spec.approve", { workItemId: d.workItemId }, key);
      return r.alreadyDecided ? "Already decided" : DONE[d.kind];
    }
    case "spec.requestChanges": {
      const r = await decideOp("spec.requestChanges", { workItemId: d.workItemId, note: d.note }, key);
      return r.alreadyDecided ? "Already decided" : DONE[d.kind];
    }
    case "review.merge": {
      const r = await decideOp(
        "review.merge",
        { workItemId: d.workItemId, openedFullDiff: d.openedFullDiff },
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
    case "question.acceptDefaults": {
      const r = await decideOp("question.acceptDefaults", { workItemId: d.workItemId }, key);
      return r.skipped.length
        ? `Accepted ${r.accepted.length}; ${r.skipped.length} must be answered one by one`
        : `Accepted ${r.accepted.length} default${r.accepted.length === 1 ? "" : "s"}`;
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
