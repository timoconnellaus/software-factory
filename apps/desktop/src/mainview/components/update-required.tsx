// "Update required" (spec 40 M4, ADR 0393): the door refused this build as too old, so nothing but
// updating works. Shown instead of everything else, signed in or not, so a person is never left
// with a generic error. With a verified update staged it offers the restart (never cancelling the
// runner's jobs without saying so); otherwise the download.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { useState } from "react";
import type { UpdateStatus } from "../../shared/rpc.ts";

type Action = "restart" | "restart-when-idle" | "restart-anyway" | "download" | "retry";

/** What the screen says and offers for this status; pure, for the tests. */
export function updateRequiredView(u: UpdateStatus): {
  body: string;
  actions: { action: Action; label: string; variant: "default" | "outline" | "destructive" }[];
} {
  const jobs = `${u.jobs} job${u.jobs === 1 ? "" : "s"}`;
  if (u.needsMove)
    return {
      body: "Move Software Factory to your Applications folder and open it from there, so it can update itself. Or download the new version.",
      actions: [
        { action: "download", label: "Download the new version", variant: "default" },
        { action: "retry", label: "Try again", variant: "outline" },
      ],
    };
  if (u.ready && u.jobs === 0)
    return {
      body: `Version ${u.version} is downloaded and checked. Restart to finish updating.`,
      actions: [{ action: "restart", label: "Restart to update", variant: "default" }],
    };
  if (u.ready)
    return {
      body: `Version ${u.version} is downloaded and checked. This Mac's runner is running ${jobs}; restarting now cancels them and their unpushed work is lost.`,
      actions: [
        {
          action: "restart-when-idle",
          label: `Restart when the ${jobs} finish`,
          variant: "default",
        },
        {
          action: "restart-anyway",
          label: `Restart now (cancels ${jobs})`,
          variant: "destructive",
        },
      ],
    };
  return {
    body: u.error
      ? `The app couldn't update itself (${u.error}). Download the new version, quit this one and open the new one.`
      : "Looking for the new version… If it doesn't appear in a few minutes, download it.",
    actions: [
      { action: "download", label: "Download the new version", variant: "default" },
      { action: "retry", label: "Try again", variant: "outline" },
    ],
  };
}

export function UpdateRequired({
  status,
  act,
}: {
  status: UpdateStatus;
  act: (action: Action) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const view = updateRequiredView(status);
  return (
    <main
      className="mx-auto grid min-h-screen max-w-md place-content-center gap-4 p-6"
      data-testid="update-required"
    >
      <h1 className="font-semibold text-2xl tracking-tight">Update required</h1>
      <p className="text-muted-foreground text-sm">
        This version of Software Factory is too old for the factory. {view.body}
      </p>
      {status.error && !status.needsMove && (
        <Card className="px-4 py-3 text-muted-foreground text-xs">{status.error}</Card>
      )}
      <div className="flex flex-wrap gap-2">
        {view.actions.map((a) => (
          <Button
            key={a.action}
            variant={a.variant}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await act(a.action);
              } finally {
                setBusy(false);
              }
            }}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </main>
  );
}
