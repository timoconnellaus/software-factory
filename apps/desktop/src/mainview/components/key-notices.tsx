// What the device key asks of the person (spec 40 M4b), over every screen:
// - "Waiting for Touch ID: <summary>" while a decision waits for the sheet, in the sheet's own
//   words so the person can match the two, with Cancel (the main process takes the sheet down);
// - on a Mac with a software key whose build now has the key helper, the offer to sign in again
//   and keep the key in the Secure Enclave, confirmed first (SignInAgainDialog, also on This Mac).
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../shared/rpc.ts";
import { bun, onTouchId } from "../bridge.ts";

const TOUCH_ID = "touch-id";
const UPGRADE = "key-upgrade";

export const touchIdText = (summary: string) => `Waiting for Touch ID: ${summary}`;
export const UPGRADE_TEXT = "This Mac can now keep its key in the Secure Enclave: sign in again";

/**
 * Confirms moving this Mac to a Secure Enclave key: signing in again revokes this device first
 * (stopping, and saying so, if that fails), then the website approves the new key.
 */
export function SignInAgainDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="sign-in-again-dialog">
        <DialogHeader>
          <DialogTitle>Sign in again with a Secure Enclave key?</DialogTitle>
          <DialogDescription>
            This Mac signs out (its software key is revoked), then your browser opens to approve it
            again. Approve only if the website shows exactly the key fingerprint this app shows, all
            four groups.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            data-testid="sign-in-again-confirm"
            onClick={async () => {
              setBusy(true);
              const session = await bun.signInAgain({});
              setBusy(false);
              client.setQueryData(["session"], session);
              if (session.signedIn && session.error) toast.error(session.error);
              else onOpenChange(false);
            }}
          >
            Sign in again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function KeyNotices({ session }: { session: Session }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(
    () =>
      onTouchId((summary) => {
        if (summary === null) {
          toast.dismiss(TOUCH_ID);
          return;
        }
        toast.loading(touchIdText(summary), {
          id: TOUCH_ID,
          duration: Number.POSITIVE_INFINITY,
          action: { label: "Cancel", onClick: () => void bun.cancelTouchId({}) },
        });
      }),
    [],
  );

  // This Mac (Settings) makes the same offer inline, so the toast stays off there.
  const onThisMac = useRouterState({ select: (s) => s.location.pathname === "/settings" });
  const offer = session.signedIn && session.keyUpgrade && !onThisMac;
  useEffect(() => {
    if (!offer) {
      toast.dismiss(UPGRADE);
      return;
    }
    toast(UPGRADE_TEXT, {
      id: UPGRADE,
      duration: Number.POSITIVE_INFINITY,
      description: "Gate decisions from this Mac need it.",
      action: { label: "Sign in again…", onClick: () => setConfirming(true) },
    });
  }, [offer]);

  return <SignInAgainDialog open={confirming} onOpenChange={setConfirming} />;
}
