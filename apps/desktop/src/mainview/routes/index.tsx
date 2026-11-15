// `/`: the app is the new core's shell (spec 70), under /flow. A fresh window, a link to a screen
// that no longer exists, and signing in all land here and go on to it.
import { createRoute, redirect } from "@tanstack/react-router";
import { appRoute } from "./_app.tsx";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/flow", replace: true });
  },
});
