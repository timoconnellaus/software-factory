// What a page shows while its loader fetches (router.tsx: after defaultPendingMs). Routes with a
// distinctive layout bring their own skeleton.
import { Skeleton } from "@software-factory/ui/components/skeleton";

export function PagePending() {
  return (
    <main
      aria-busy="true"
      className="flex min-w-0 flex-1 flex-col gap-4 p-6"
      data-testid="page-pending"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-36 w-full" />
    </main>
  );
}
