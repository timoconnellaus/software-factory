// Auto's read (spec 70): the org's schedules, re-read while the screen shows them so "Next" and
// "Last" keep up with the cron. An engine without flow.schedule.list reads as no schedules.
import { queryOptions } from "@tanstack/react-query";
import { orEmpty } from "./flow-edit-queries.ts";
import { read } from "./op.ts";

export const flowSchedulesQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["flow", orgId, "schedules"],
    queryFn: () => orEmpty(read("flow.schedule.list", { orgId }), { schedules: [] }),
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
