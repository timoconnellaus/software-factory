// "Update required" (spec 40 M4, ADR 0393): the door refused this build as too old, so nothing but
// updating works. Shown instead of everything else, signed in or not, so a person is never left
// with a generic error. With a verified update staged it offers the restart (never cancelling the
// runner's jobs without saying so); otherwise the download.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../shared/rpc.ts";
import { DRAG, NO_DRAG } from "../lib/title-bar.ts";

type Action = "restart" | "restart-when-idle" | "restart-anyway" | "download" | "retry";

const secondsLeft = (until: number, now = Date.now()) =>
  Math.max(0, Math.ceil((until - now) / 1000));

/** What the screen says and offers for this status; pure, for the tests. */
export function updateRequiredView(u: UpdateStatus): {
  body: string;
  actions: { action: Action; label: string; variant: "default" | "outline" | "destructive" }[];
} {
  const jobs = `${u.jobs} job${u.jobs === 1 ? "" : "s"}`;
  // "Restart to update" asked the runner to stop claiming and is waiting for its answer (bounded).
  if (u.waitingForRunner !== null)
    return {
      body: `Version ${u.version ?? "new"} is ready. Waiting for this Mac's runner to stop taking jobs before restarting (up to ${secondsLeft(u.waitingForRunner)} s)…`,
      actions: [],
    };
  if (u.needsMove)
    return {
      body: "Move Software Factory to your Applications folder and open it from there, so it can update itself. Or download the new version.",
      actions: [
        { action: "download", label: "Download the new version", variant: "default" },
        { action: "retry", label: "Try again", variant: "outline" },
      ],
    };
  if (u.ready && u.jobs === 0 && u.installFailure?.version === u.version)
    return {
      body: u.installFailure.reason,
      actions: [{ action: "restart", label: "Retry the update", variant: "default" }],
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
      ? "The app couldn't update itself. Download the new version, quit this one and open the new one."
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
      {/* The window has no title bar (spec 41): the top strip still moves it. */}
      <div aria-hidden="true" className={`fixed inset-x-0 top-0 h-12 ${DRAG}`} />
      <h1 className="font-semibold text-2xl tracking-tight">Update required</h1>
      <p className="text-muted-foreground text-sm">
        This version of Software Factory is too old for the factory. {view.body}
      </p>
      {status.waitingForRunner !== null && <WaitingForRunner until={status.waitingForRunner} />}
      {status.error && !status.needsMove && (
        <Card className="px-4 py-3 text-muted-foreground text-xs">{status.error}</Card>
      )}
      <div className={`flex flex-wrap gap-2 ${NO_DRAG}`}>
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

/** The drain's countdown: "Waiting for the runner", ticking until the app gives up on it. */
function WaitingForRunner({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card className="px-4 py-3 text-muted-foreground text-xs" data-testid="waiting-for-runner">
      Waiting for the runner… gives up in {secondsLeft(until, now)} s, then the app updates once the
      runner is idle.
    </Card>
  );
}
