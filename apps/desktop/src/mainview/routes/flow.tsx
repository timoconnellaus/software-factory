// The new core's screens (spec 70, .kim/plans/2026-11-15-the-new-cores-ui-board-item-panel-and-card-
// timeline.md) live under /flow. The `_app` layout draws the new shell (components/flow/shell.tsx)
// for these paths instead of the old one; the old screens stay where they were, behind Old factory.
import { createRoute, Outlet, redirect } from "@tanstack/react-router";
import { appRoute } from "./_app.tsx";

export const flowLayout = createRoute({
  getParentRoute: () => appRoute,
  path: "flow",
  component: Outlet,
});

/** /flow: Personal's Work (or the first org's). */
export const flowIndex = createRoute({
  getParentRoute: () => flowLayout,
  path: "/",
  beforeLoad: ({ context: { session } }) => {
    const orgId = session.personalOrgId ?? session.orgs[0]?.id;
    if (orgId) throw redirect({ to: "/flow/$orgId/work", params: { orgId } });
  },
});
