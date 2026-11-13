// The board's and lists' side of stageWait (stage-wait.ts): their reads (`workItem.board`) say
// only the stage and status, so a card in verify reads the item (`workItem.get`, the same query
// as its page, shared in the cache) and a card in merge its project's `delivery.status` (already
// read for the Held chip). Only for those stages, and only while the item is moving on its own.
import { useQuery } from "@tanstack/react-query";
import { deliveryStatusQuery } from "./factory-queries.ts";
import { workItemQuery } from "./queries.ts";
import { stageWait } from "./stage-wait.ts";

export function useStageWait(item: {
  id: string;
  projectId: string;
  stage?: string;
  status: string;
}): string | null {
  const moving = item.status === "running" || item.status === "waiting";
  const verify = moving && item.stage === "verify";
  const merge = moving && item.stage === "merge";
  // Slower than the page's 10 s: a card's line, not the page being read.
  const detail = useQuery({ ...workItemQuery(item.id), enabled: verify, refetchInterval: 30_000 });
  const delivery = useQuery({ ...deliveryStatusQuery(item.projectId), enabled: merge });
  if (!item.stage || (!verify && !merge)) return null;
  const repo = delivery.data?.repositories.find((r) =>
    r.deliveries.some((d) => d.workItemId === item.id),
  );
  const entry = repo?.deliveries.find((d) => d.workItemId === item.id);
  return stageWait({
    item: { stage: item.stage, status: item.status },
    stages: detail.data?.stages,
    runs: detail.data?.runs,
    reviewPacket: detail.data?.reviewPacket ?? null,
    mergeQueue: detail.data?.mergeQueue ?? null,
    delivery:
      entry && repo ? { position: entry.position, state: entry.state, branch: repo.branch } : null,
  });
}
