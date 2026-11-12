// Who is signed in, their orgs and projects, for any component under the `_app` layout route.
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
