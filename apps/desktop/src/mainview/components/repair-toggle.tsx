// Mark (or unmark) an item as a repair of its red default branch (spec 53, ADR 0581): while the
// line is stopped, a repair lands ahead of the other approved items. A person's call, confirmed
// with Touch ID (`decide()`); shown only while the item's project has a red main.
import { Button } from "@software-factory/ui/components/button";
import { usePolicyDecide } from "../lib/policy-decide.ts";
import { useCanDecide } from "./cannot-approve.tsx";

/** Offered while the line is red, or to unmark an item that is marked (tested). */
export const repairShown = (red: boolean, repairs: boolean) => red || repairs;

export function RepairToggle({
  workItemId,
  repairs,
  red,
}: {
  workItemId: string;
  repairs: boolean;
  /** Whether the item's project's default branch is red now (inbox.list's `mainRed`). */
  red: boolean;
}) {
  const { run, pending } = usePolicyDecide();
  const canDecide = useCanDecide();
  if (!repairShown(red, repairs)) return null;
  return (
    <Button
      size="md"
      variant="outline"
      disabled={pending !== null || !canDecide}
      data-testid="repair-toggle"
      onClick={() =>
        void run(
          "workItem.markRepair",
          { workItemId, repair: !repairs },
          repairs ? "No longer a repair" : "Marked as a repair",
        )
      }
    >
      {repairs ? "Not a repair" : "Mark as a repair"}
    </Button>
  );
}
