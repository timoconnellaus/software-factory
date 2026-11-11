import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { OpError } from "./lib/ops.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  // One QueryClient per page load (and per server render).
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        // A refusal (not found, forbidden, invalid) won't change on retry: show it at once.
        retry: (count, error) => !(error instanceof OpError) && count < 2,
      },
    },
  });
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
