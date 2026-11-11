import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { PagePending } from "./components/page-pending.tsx";
import { OpError } from "./lib/ops.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  // One QueryClient per page load (and per server render). Loaders fill it; pages read it.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Each query in lib/queries.ts sets its own; this covers the rest.
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        // A refusal (not found, forbidden, invalid) won't change on retry: show it at once.
        retry: (count, error) => !(error instanceof OpError) && count < 2,
      },
    },
  });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    // Hovering or focusing a link runs its loaders, which warm the query cache.
    defaultPreload: "intent",
    // The router always re-runs loaders and lets TanStack Query decide freshness: `ensureQueryData`
    // answers from the cache when it has the data, so a preload is never thrown away.
    defaultPreloadStaleTime: 0,
    // A navigation that has to fetch shows the new page's skeleton after a beat, instead of
    // leaving the old page up until the data arrives.
    defaultPendingComponent: PagePending,
    defaultPendingMs: 150,
    defaultPendingMinMs: 200,
    scrollRestoration: true,
  });
  // Carries the server render's query cache to the browser (no refetch after hydration) and
  // provides the QueryClient.
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
