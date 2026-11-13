// Said before a person tries to decide (ADR 0610, the coordinator's finding of 2026-11-13): every
// released build before the key helper has a software key, whose proofs the engine refuses, so a
// screen that decides something says so plainly, with the way out.
import { Button } from "@software-factory/ui/components/button";
import { checkForUpdates, SOFTWARE_KEY_TEXT } from "../lib/decisions.tsx";
import { useDesktopSession } from "../lib/desktop-session.ts";

/**
 * Whether this Mac can make a presence proof the engine accepts. A software key can't: on the
 * desktop, approving and rejecting a config change both take a proof (the decidability table).
 */
export function useCanDecide(): boolean {
  return useDesktopSession()?.keyStorage !== "software";
}

export function CannotApproveYet() {
  if (useCanDecide()) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg bg-chip-amber px-3 py-2 text-[13px] text-chip-amber-ink"
      data-testid="cannot-approve-yet"
    >
      <span className="min-w-[min(100%,280px)] flex-1">{SOFTWARE_KEY_TEXT}</span>
      <Button size="sm" variant="outline" onClick={() => void checkForUpdates()}>
        Check for updates
      </Button>
    </div>
  );
}
