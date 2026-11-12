// What a section shows for its reads (spec 41): a skeleton while one is pending, the error with
// Retry when one failed, and its content only once every read has answered. An empty message is
// then a fact ("You have no runners yet"), never a guess made while a read is out or after it failed.
import { errorMessage } from "@software-factory/client/format";
import { Button } from "@software-factory/ui/components/button";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import type * as React from "react";
import { Panel } from "./shell-list.tsx";

/** The part of a query a section needs. A refetch that fails after data came keeps the data. */
export interface ReadQuery {
  data: unknown;
  error: unknown;
  isError: boolean;
  isPending: boolean;
  refetch: () => unknown;
}

export type ReadState = "pending" | "error" | "ready";

/** Ready once every read has data; failed when one failed with nothing to show; else pending. */
export function readState(queries: ReadQuery[]): ReadState {
  if (queries.some((q) => q.isError && q.data === undefined)) return "error";
  if (queries.some((q) => q.data === undefined)) return "pending";
  return "ready";
}

/**
 * A section's content once its reads have answered. `what` names it in the error ("the runners").
 * `skeleton` is the pending shape (a table's by default); `children` render only when ready.
 */
export function Reads({
  queries,
  what,
  skeleton,
  children,
}: {
  queries: ReadQuery[];
  what: string;
  skeleton?: React.ReactNode;
  children: () => React.ReactNode;
}) {
  const state = readState(queries);
  if (state === "pending") return <>{skeleton ?? <TableSkeleton />}</>;
  if (state === "error") {
    const failed = queries.filter((q) => q.isError && q.data === undefined);
    return (
      <ReadError
        what={what}
        error={failed[0]?.error}
        retry={() => {
          for (const q of failed) void q.refetch();
        }}
      />
    );
  }
  return <>{children()}</>;
}

/** A read that failed: what couldn't load, the door's reason, and Retry. */
export function ReadError({
  what,
  error,
  retry,
}: {
  what: string;
  error: unknown;
  retry: () => void;
}) {
  return (
    <Panel
      className="flex-row items-center gap-3 text-[13px]"
      role="alert"
      data-testid="read-error"
    >
      <span className="min-w-0 flex-1">
        <span className="text-destructive">Couldn't load {what}.</span>{" "}
        <span className="text-ink-3">{errorMessage(error)}</span>
      </span>
      <Button size="md" variant="outline" onClick={retry} data-testid="read-retry">
        Retry
      </Button>
    </Panel>
  );
}

/** A table's shape while its read is out. */
export function TableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Panel className="gap-2.5" aria-busy="true" data-testid="read-pending">
      <Skeleton className="h-3 w-1/3" />
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity.
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </Panel>
  );
}

/** A figure tile's shape while its read is out. */
export function StatSkeleton() {
  return (
    <Panel className="gap-2 px-3.5 py-3" aria-busy="true" data-testid="read-pending">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-5 w-10" />
      <Skeleton className="h-3 w-24" />
    </Panel>
  );
}
