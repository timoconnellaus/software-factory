import { Toaster } from "@software-factory/ui/components/sonner";
import { TooltipProvider } from "@software-factory/ui/components/tooltip";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

/** What every route's loader gets: the page's QueryClient (router.tsx). */
export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "color-scheme", content: "light dark" },
      { title: "Software Factory" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => <Outlet />,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-svh antialiased">
        <QueryProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </QueryProvider>
        <Toaster position="bottom-right" closeButton />
        <Scripts />
      </body>
    </html>
  );
}

function QueryProvider({ children }: { children: ReactNode }) {
  const { queryClient } = useRouter().options.context as RouterContext;
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
