// "Updating to <version>" (spec 40 M4): from the click on Restart to update until the app restarts,
// the whole window says what is happening, step by step (shared/update-apply.ts). It can't be
// dismissed while the update runs; a refused update says why (the updater's own refusal message)
// and offers the way back.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { cn } from "@software-factory/ui/lib/utils";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { type ApplyState, type ApplyStep, applyStepText } from "../../shared/update-apply.ts";
import { DRAG, NO_DRAG } from "../lib/title-bar.ts";

const STEPS: ApplyStep[] = ["verifying", "waiting", "restarting"];

/** Where each step stands for the current one: done, now, or still to come. */
export function stepMarks(step: ApplyStep): Record<ApplyStep, "done" | "now" | "later"> {
  const at = STEPS.indexOf(step);
  const mark = (s: ApplyStep) => {
    const i = STEPS.indexOf(s);
    if (at < 0 || i < 0) return "later" as const;
    return i < at ? ("done" as const) : i === at ? ("now" as const) : ("later" as const);
  };
  return {
    idle: "later",
    refused: "later",
    verifying: mark("verifying"),
    waiting: mark("waiting"),
    restarting: mark("restarting"),
  };
}

const LABEL: Record<"verifying" | "waiting" | "restarting", string> = {
  verifying: "Check the update's signature",
  waiting: "Wait for this Mac's runner to stop taking jobs",
  restarting: "Restart into the new version",
};

export function Updating({
  applying,
  back,
}: {
  applying: ApplyState;
  back: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const refused = applying.step === "refused";
  const marks = stepMarks(applying.step);
  return (
    <main
      className="grid h-dvh place-content-center bg-window p-6 text-ink"
      data-testid="updating"
      aria-live="polite"
      aria-busy={!refused}
    >
      {/* The window has no title bar (spec 41): the top strip still moves it. */}
      <div aria-hidden="true" className={`fixed inset-x-0 top-0 h-11 ${DRAG}`} />
      <div className="grid w-full max-w-md gap-4">
        <h1 className="font-semibold text-2xl tracking-tight">
          {refused ? "The update didn't install" : `Updating to ${applying.version}`}
        </h1>
        {refused ? (
          <>
            <Card className="flex-row items-start gap-2.5 px-4 py-3 text-sm" role="alert">
              <CircleAlertIcon className="mt-0.5 size-4 flex-none text-destructive" />
              <span data-testid="update-refusal">{applying.reason}</span>
            </Card>
            <p className="text-muted-foreground text-sm">
              Software Factory keeps running this version. Nothing was changed.
            </p>
            <div className={NO_DRAG}>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await back();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Back to Software Factory
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-sm" data-testid="update-step">
              {applyStepText(applying.step)}
            </p>
            <Card className="gap-2.5 px-4 py-3">
              {(["verifying", "waiting", "restarting"] as const).map((s) => (
                <div
                  key={s}
                  className={cn(
                    "flex items-center gap-2.5 text-sm",
                    marks[s] === "later" && "text-muted-foreground",
                  )}
                  data-step={s}
                  data-mark={marks[s]}
                >
                  {marks[s] === "done" ? (
                    <CheckIcon className="size-4 flex-none text-status-done" />
                  ) : marks[s] === "now" ? (
                    <LoaderCircleIcon className="size-4 flex-none animate-spin" />
                  ) : (
                    <span className="size-4 flex-none" />
                  )}
                  {LABEL[s]}
                </div>
              ))}
            </Card>
            <p className="text-muted-foreground text-xs">
              The app restarts on its own and comes back where this window is now.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
