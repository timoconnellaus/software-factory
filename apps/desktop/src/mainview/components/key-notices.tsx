// What the device key asks of the person (spec 40 M4b), as toasts over every screen:
// - "Waiting for Touch ID: <summary>" while a decision waits for the sheet, in the sheet's own
//   words so the person can match the two, with Cancel (the main process takes the sheet down);
// - on a Mac with a software key whose build now has the key helper, the offer to sign in again
//   and keep the key in the Secure Enclave.
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import type { Session } from "../../shared/rpc.ts";
import { bun, onTouchId } from "../bridge.ts";

const TOUCH_ID = "touch-id";
const UPGRADE = "key-upgrade";

export const touchIdText = (summary: string) => `Waiting for Touch ID: ${summary}`;
export const UPGRADE_TEXT = "This Mac can now keep its key in the Secure Enclave: sign in again";

export function KeyNotices({ session }: { session: Session }) {
  const client = useQueryClient();

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
      description:
        "Approve this Mac on the website only if the key fingerprint there matches the one shown here.",
      action: {
        label: "Sign in again",
        onClick: async () => client.setQueryData(["session"], await bun.signInAgain({})),
      },
    });
  }, [offer, client]);

  return null;
}
