// What a page shows while its loader fetches (router.tsx: after defaultPendingMs). Routes with a
// distinctive layout bring their own skeleton.
import { Skeleton } from "@software-factory/ui/components/skeleton";

export function PagePending() {
  return (
    <main
      className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[1200px] gap-4 p-4 md:p-6"
      aria-busy="true"
      data-testid="page-pending"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-36 w-full" />
    </main>
  );
}
