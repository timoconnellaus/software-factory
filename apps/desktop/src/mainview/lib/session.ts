// Who is signed in and their orgs, for any component under the `_app` layout route.
import { getRouteApi } from "@tanstack/react-router";

const appRoute = getRouteApi("/_app");

export function useSession() {
  return appRoute.useRouteContext().session;
}
