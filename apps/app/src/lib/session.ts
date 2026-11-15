// The signed-in session, and where sign-in may send the person back to.
import { queryOptions } from "@tanstack/react-query";
import { getSession } from "#/server/fns";

/**
 * The signed-in user and their orgs. Fetched once per page load (on the server for the first
 * render, then carried to the browser with the rest of the cache); `_app` re-checks it in the
 * background once it is stale. Operations check the session on every call regardless.
 */
export const sessionQuery = () =>
  queryOptions({
    queryKey: ["session"],
    queryFn: () => getSession(),
    staleTime: 5 * 60_000,
  });

/** Only same-origin paths: never an open redirect. */
export function safeRedirect(target: string | undefined): string {
  return target?.startsWith("/") && !target.startsWith("//") ? target : "/";
}
