// The desktop app's view (ADR 0390, spec 40): a TanStack Router (hash history) + Query SPA on
// packages/ui. Operations go over RPC to the main process, which calls the client door; gate
// decisions go through `decide` (Touch ID). The view holds no token.
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bun } from "./bridge.ts";
import { connect } from "./lib/op.ts";
import { onTitleBarDoubleClick } from "./lib/title-bar.ts";
import { makeRouter } from "./router.tsx";
import "./styles.css";

connect(bun);
onTitleBarDoubleClick(document, () => void bun.titleBarDoubleClick({}).catch(() => undefined));
const { router, queryClient } = makeRouter();

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
