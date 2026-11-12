// The Live tab (spec 31, ADR 0400): polls the latest run's `run.live` every 2 s while it is active
// and sends the runner owner's messages with `run.steer`. The view is `live-run-view.tsx`.

import { errorMessage } from "@software-factory/client/format";
import { Card } from "@software-factory/ui/components/card";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { LiveRunView } from "#/components/live-run-view";
import { op, submitKey } from "#/lib/op";
import type { WorkItemDetail } from "#/lib/ops";
import { liveQuery } from "#/lib/queries";
import { useSession } from "#/lib/session";

export function LiveRun({ detail }: { detail: WorkItemDetail }) {
  const queryClient = useQueryClient();
  const me = useSession().user.id;
  const latest = detail.runs.at(-1);
  const live = useQuery(liveQuery(queryClient, detail.item.id));
  // A newer run than the one shown (the work item refreshes every few seconds): read it.
  const shown = live.data?.run?.id;
  const refetch = live.refetch;
  useEffect(() => {
    if (latest && shown && latest.id !== shown) void refetch();
  }, [latest, shown, refetch]);

  if (!latest) {
    return <Card className="px-5 py-6 text-muted-foreground text-sm">No runs yet.</Card>;
  }
  if (!live.data) {
    return (
      <Card className="px-5 py-4">
        {live.error ? (
          <div className="text-muted-foreground text-sm">
            Couldn't load the live view: {errorMessage(live.error)}
          </div>
        ) : (
          <Skeleton className="h-64 w-full" />
        )}
      </Card>
    );
  }
  const workItemId = detail.item.id;
  const onSteer = async (runId: string, text: string) => {
    await op("run.steer", { workItemId, runId, text }, { idempotencyKey: submitKey() });
    await queryClient.invalidateQueries({ queryKey: ["workItem", workItemId, "live"] });
  };
  const onTakeover = async (runId: string) => {
    await op("run.takeover", { workItemId, runId }, { idempotencyKey: submitKey() });
    await queryClient.invalidateQueries({ queryKey: ["workItem", workItemId, "live"] });
  };
  return (
    <LiveRunView
      data={live.data}
      me={me}
      onSteer={onSteer}
      onTakeover={onTakeover}
      workItemId={workItemId}
    />
  );
}
