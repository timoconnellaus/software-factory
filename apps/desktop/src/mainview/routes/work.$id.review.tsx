// The review packet page (spec 14): /work/<id>/review. Also the Review packet tab on the detail page.
// Ported from sf-app for spec 40 M3.
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { ReviewPacket } from "../components/review-packet.tsx";
import { workItemQuery } from "../lib/queries.ts";
import { useProjects } from "../lib/session.ts";
import { appRoute } from "./_app.tsx";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/work/$id/review",
  // The packet lives on the work item; project names come from the shell's loader.
  loader: ({ context, params }) => context.queryClient.ensureQueryData(workItemQuery(params.id)),
  pendingComponent: () => (
    <Page>
      <Skeleton className="h-64 w-full" />
    </Page>
  ),
  errorComponent: () => (
    <Page>
      <p className="text-sm">
        Work item not found.{" "}
        <Link to="/" className="underline">
          Back to the inbox
        </Link>
      </p>
    </Page>
  ),
  component: ReviewPage,
});

function ReviewPage() {
  const { id } = Route.useParams();
  const { data } = useSuspenseQuery(workItemQuery(id));
  const projects = useProjects();
  return (
    <Page>
      <div className="text-muted-foreground text-xs">
        <Link to="/work/$id" params={{ id }} className="hover:underline">
          {projects.data?.find((p) => p.id === data.item.projectId)?.name ?? "project"} · #
          {data.item.number}
        </Link>{" "}
        · requested by you
      </div>
      <ReviewPacket detail={data} full />
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[1200px] gap-4 p-4 md:p-6">
      {children}
    </main>
  );
}
