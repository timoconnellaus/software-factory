// Attach and verify (spec 05): attaches an outside PR to a new work item in one click, then opens
// the item. Used by `/attach` and by New work's list of open PRs.
// Ported from sf-app for spec 40 M3, unchanged but for the imports.
import { Button } from "@software-factory/ui/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { OpError, op, submitKey } from "../lib/op.ts";

/** `owner/name` from the link, or null when it isn't one. */
export function parseRepo(repo: string | undefined): { owner: string; name: string } | null {
  const m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(repo?.trim() ?? "");
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null;
}

/** Attach and verify: one click, then the work item. Shared with New work's open PR list. */
export function AttachButton({
  projectId,
  prNumber,
  label = "Attach and verify",
  size,
}: {
  projectId: string;
  prNumber: number;
  label?: string;
  size?: "sm";
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  // One key per page: a double click attaches once.
  const key = useRef(submitKey());
  async function attach() {
    setBusy(true);
    try {
      const attached = await op(
        "workItem.attachPr",
        { projectId, prNumber },
        { idempotencyKey: key.current },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["open-pulls", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["attach"] }),
      ]);
      toast.success(
        attached.outcome === "created"
          ? `Attached as #${attached.number}: verifying it now`
          : "Already attached",
      );
      await navigate({ to: "/work/$id", params: { id: attached.workItemId } });
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't attach it");
      setBusy(false);
    }
  }
  return (
    <Button onClick={attach} disabled={busy} size={size} data-testid="attach-and-verify">
      {busy ? "Attaching…" : label}
    </Button>
  );
}
