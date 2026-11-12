// STUB: to be ported from apps/app/src/routes/_app/work.index.tsx (spec 40 M3).
import { createRoute } from "@tanstack/react-router";
import { appRoute } from "./_app.tsx";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/work",
  component: () => <main className="p-6">Work</main>,
});
