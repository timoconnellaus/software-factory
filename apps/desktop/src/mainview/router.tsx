// The view's router (ADR 0380): TanStack Router with hash history (views:// has no server for
// paths) and a QueryClient that loaders fill and pages read, as in sf-app (ADR 0241).
import { OpError } from "@software-factory/client/ops";
import { QueryClient } from "@tanstack/react-query";
import { createHashHistory, createRouter } from "@tanstack/react-router";
import { AppError } from "./components/app-error.tsx";
import { PagePending } from "./components/page-pending.tsx";
import { appRoute } from "./routes/_app.tsx";
import { Route as flowAuto } from "./routes/flow.$orgId.auto.tsx";
import { Route as flowChat } from "./routes/flow.$orgId.chat.tsx";
import { Route as flowInbox } from "./routes/flow.$orgId.inbox.tsx";
import { Route as flowItem } from "./routes/flow.$orgId.p.$projectId.i.$itemId.tsx";
import { Route as flowProject } from "./routes/flow.$orgId.p.$projectId.tsx";
import { Route as flowPlugins } from "./routes/flow.$orgId.plugins.tsx";
import { Route as flowSettings } from "./routes/flow.$orgId.settings.tsx";
import { Route as flowTeam } from "./routes/flow.$orgId.team.tsx";
import { flowOrg, flowOrgIndex } from "./routes/flow.$orgId.tsx";
import { Route as flowWork } from "./routes/flow.$orgId.work.tsx";
import { Route as flowWorkflows } from "./routes/flow.$orgId.workflows.tsx";
import { Route as flowOrgs } from "./routes/flow.orgs.tsx";
import { flowIndex, flowLayout } from "./routes/flow.tsx";
import { Route as home } from "./routes/index.tsx";
import { rootRoute } from "./routes/root.tsx";

// The app is the new core's shell (spec 70), under /flow; `/` goes there.
export const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    home,
    flowLayout.addChildren([
      flowIndex,
      flowOrgs,
      flowOrg.addChildren([
        flowOrgIndex,
        flowInbox,
        flowWork,
        flowChat,
        flowTeam,
        flowAuto,
        flowPlugins,
        flowSettings,
        flowProject,
        flowWorkflows,
        flowItem,
      ]),
    ]),
  ]),
]);

export function makeRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        // A refusal (not found, forbidden, invalid) won't change on retry: show it at once.
        retry: (count, error) => !(error instanceof OpError) && count < 2,
      },
    },
  });
  const router = createRouter({
    routeTree,
    history: createHashHistory(),
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PagePending,
    // Any error a route doesn't handle itself: the app's error screen, not the router's default.
    defaultErrorComponent: AppError,
    defaultPendingMs: 150,
    defaultPendingMinMs: 200,
  });
  return { router, queryClient };
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>["router"];
  }
}
