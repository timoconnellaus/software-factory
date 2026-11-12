// What a page shows while its loader fetches (router.tsx: after defaultPendingMs). Routes with a
// distinctive layout bring their own skeleton.
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { PageArea } from "./shell-list.tsx";

export function PagePending() {
  return (
    <PageArea aria-busy="true" data-testid="page-pending">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-36 w-full" />
    </PageArea>
  );
}
