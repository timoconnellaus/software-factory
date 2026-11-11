// The review packet page (spec 14): /work/<id>/review. Also the Review packet tab on the detail page.
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ReviewPacket } from "#/components/review-packet";
import { workItemQuery } from "#/lib/queries";
import { useProjects } from "#/lib/session";

export const Route = createFileRoute("/_app/work/$id/review")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(workItemQuery(params.id)).catch(() => null),
  component: ReviewPage,
});

function ReviewPage() {
  const { id } = Route.useParams();
  const detail = useQuery(workItemQuery(id));
  const projects = useProjects();
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[1200px] gap-4 p-4 md:p-6">
      {detail.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : detail.isError ? (
        <p className="text-sm">
          Work item not found.{" "}
          <Link to="/" className="underline">
            Back to the inbox
          </Link>
        </p>
      ) : (
        <>
          <div className="text-muted-foreground text-xs">
            <Link to="/work/$id" params={{ id }} className="hover:underline">
              {projects.data?.find((p) => p.id === detail.data.item.projectId)?.name ?? "project"} ·
              #{detail.data.item.number}
            </Link>{" "}
            · requested by you
          </div>
          <ReviewPacket detail={detail.data} full />
        </>
      )}
    </main>
  );
}
