// The signed-in session and the user's projects, for any component under the /_app layout.
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { projectsQuery } from "./queries.ts";

const appRoute = getRouteApi("/_app");

export function useSession() {
  return appRoute.useRouteContext().session;
}

/** Every project in the user's orgs (for pickers and the sidebar). */
export function useProjects() {
  const session = useSession();
  return useQuery(projectsQuery(session.orgs.map((o) => o.id)));
}

/** Only same-origin paths: never an open redirect. */
export function safeRedirect(target: string | undefined): string {
  return target?.startsWith("/") && !target.startsWith("//") ? target : "/";
}
