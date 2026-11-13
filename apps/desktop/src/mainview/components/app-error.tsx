// The app's error screen: where any error no page handles lands (the root route's and the router's
// default error component), instead of the router's unstyled default under the traffic lights.
// A plain message, the detail folded away, Retry (reloads the routes) and Reload (the whole view).
// "Signed out" is not an error: the main process has already said so (sessionChanged), and the root
// shows the sign-in screen; this asks it again rather than showing anything.
import { OpError } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { useQueryClient } from "@tanstack/react-query";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { DRAG, NO_DRAG } from "../lib/title-bar.ts";

/** A refusal that means "this Mac isn't signed in" (the token ended, or never was). */
export const isSignedOut = (error: unknown) =>
  error instanceof OpError && error.code === "unauthenticated";

export function AppError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const signedOut = isSignedOut(error);
  useEffect(() => {
    // The root shows sign-in once the session says signed out; make sure it has asked.
    if (signedOut) void client.invalidateQueries({ queryKey: ["session"] });
  }, [signedOut, client]);
  if (signedOut) return null;
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return (
    <main
      className="grid h-dvh place-content-center bg-window p-6 text-ink"
      data-testid="app-error"
    >
      {/* The window has no title bar (spec 41): this strip, under the traffic lights, moves it. */}
      <div aria-hidden="true" className={`fixed inset-x-0 top-0 h-11 ${DRAG}`} />
      <div className="grid w-full max-w-md gap-4">
        <h1 className="font-semibold text-2xl tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground text-sm">
          This screen couldn't load. Retry it; if that doesn't help, reload the app's window.
        </p>
        <Collapsible>
          <CollapsibleTrigger
            className={`group flex items-center gap-1 text-muted-foreground text-xs ${NO_DRAG}`}
          >
            <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Card className="mt-2 max-h-48 overflow-auto px-4 py-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground text-xs">
                {detail}
              </pre>
            </Card>
          </CollapsibleContent>
        </Collapsible>
        <div className={`flex gap-2 ${NO_DRAG}`}>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await router.invalidate();
              } finally {
                setBusy(false);
                reset();
              }
            }}
          >
            Retry
          </Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    </main>
  );
}
