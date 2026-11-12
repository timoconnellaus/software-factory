// The review packet's own address (spec 14): /work/<id>/review, which `sf://` links and older
// bookmarks use. Since spec 41 the packet is the work item's Review tab, so this opens it there.
import { createRoute, redirect } from "@tanstack/react-router";
import { workLayout } from "./_work.tsx";

export const Route = createRoute({
  getParentRoute: () => workLayout,
  path: "/work/$id/review",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/work/$id",
      params: { id: params.id },
      search: { tab: "review" },
      replace: true,
    });
  },
});
