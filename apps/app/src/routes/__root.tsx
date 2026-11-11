import { Toaster } from "@software-factory/ui/components/sonner";
import { TooltipProvider } from "@software-factory/ui/components/tooltip";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
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
        {/* The QueryClientProvider comes from the router's SSR query integration (router.tsx). */}
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-right" closeButton />
        <Scripts />
      </body>
    </html>
  );
}
