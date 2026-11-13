// Mark (or unmark) an item as a repair of its red default branch (spec 53, ADR 0581): while the
// line is stopped, a repair lands ahead of the other approved items. An approver's call, confirmed
// here first, then with Touch ID (`decide()`, the prompt names the item and the red main); shown
// only to approvers while the item's project has a red main, or to unmark one.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@software-factory/ui/components/alert-dialog";
import { Button } from "@software-factory/ui/components/button";
import { useState } from "react";
import { usePolicyDecide } from "../lib/policy-decide.ts";
import { useCanDecide } from "./cannot-approve.tsx";

/** Offered to an approver while the line is red, or to unmark an item that is marked (tested). */
export const repairShown = (red: boolean, repairs: boolean, approver = true) =>
  approver && (red || repairs);

export function RepairToggle({
  workItemId,
  repairs,
  red,
  approver,
  number,
}: {
  workItemId: string;
  repairs: boolean;
  /** Whether the item's project's default branch is red now (inbox.list's `mainRed`). */
  red: boolean;
  approver: boolean;
  number: number;
}) {
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  const [confirm, setConfirm] = useState(false);
  if (!repairShown(red, repairs, approver)) return null;
  return (
    <>
      <Button
        size="md"
        variant="outline"
        disabled={pending !== null || !canDecide}
        data-testid="repair-toggle"
        onClick={() => setConfirm(true)}
      >
        {repairs ? "Not a repair" : "Mark as a repair"}
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {repairs ? `#${number} is no longer a repair?` : `Mark #${number} as a repair?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {repairs
                ? "It waits its turn again behind the other approved items."
                : "While main is red, a repair lands ahead of the other approved items, still through verify and its own merge gate."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void run(
                  "workItem.markRepair",
                  { workItemId, repair: !repairs },
                  repairs ? "No longer a repair" : "Marked as a repair",
                )
              }
            >
              {repairs ? "Not a repair" : "Mark as a repair"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
