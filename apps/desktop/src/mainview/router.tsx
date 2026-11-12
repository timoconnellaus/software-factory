// The view's router (ADR 0380): TanStack Router with hash history (views:// has no server for
// paths) and a QueryClient that loaders fill and pages read, as in sf-app (ADR 0241).
import { OpError } from "@software-factory/client/ops";
import { QueryClient } from "@tanstack/react-query";
import { createHashHistory, createRouter } from "@tanstack/react-router";
import { PagePending } from "./components/page-pending.tsx";
import { appRoute } from "./routes/_app.tsx";
import { factoryLayout } from "./routes/_factory.tsx";
import { settingsLayout } from "./routes/_settings.tsx";
import { workLayout } from "./routes/_work.tsx";
import { Route as attach } from "./routes/attach.tsx";
import { Route as factoryAgents } from "./routes/factory.agents.tsx";
import { Route as factoryIncidents } from "./routes/factory.incidents.tsx";
import { Route as factoryOverview } from "./routes/factory.index.tsx";
import { Route as factoryPolicy } from "./routes/factory.policy.tsx";
import { Route as factoryRunners } from "./routes/factory.runners.tsx";
import { Route as factoryWorkflows } from "./routes/factory.workflows.tsx";
import { Route as inbox } from "./routes/index.tsx";
import { Route as newWork } from "./routes/new.tsx";
import { rootRoute } from "./routes/root.tsx";
import { Route as settingsConnections } from "./routes/settings.connections.tsx";
import { Route as settingsDevices } from "./routes/settings.devices.tsx";
import { Route as settingsRepositories } from "./routes/settings.repositories.tsx";
import { Route as settings } from "./routes/settings.tsx";
import { Route as setup } from "./routes/setup.tsx";
import { Route as workItem } from "./routes/work.$id.index.tsx";
import { Route as review } from "./routes/work.$id.review.tsx";
import { Route as workList } from "./routes/work.index.tsx";

export const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    inbox,
    workLayout.addChildren([newWork, attach, workList, workItem, review]),
    factoryLayout.addChildren([
      factoryOverview,
      factoryRunners,
      factoryIncidents,
      factoryPolicy,
      factoryAgents,
      factoryWorkflows,
    ]),
    settingsLayout.addChildren([
      setup,
      settings,
      settingsRepositories,
      settingsConnections,
      settingsDevices,
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
