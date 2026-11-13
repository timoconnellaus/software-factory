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
import { takeEarlyDoubleClick } from "./lib/window-shell.ts";
import { makeRouter } from "./router.tsx";
import "./styles.css";

connect(bun);
const titleBarDoubleClick = () => void bun.titleBarDoubleClick({}).catch(() => undefined);
onTitleBarDoubleClick(document, titleBarDoubleClick);
// A double-click on the static shell's title bar (index.html) before this ran: act on it now.
const early = window as { __sfEarlyDoubleClick?: number; __sfStopEarlyDoubleClick?: () => void };
early.__sfStopEarlyDoubleClick?.();
if (takeEarlyDoubleClick(early, Date.now())) titleBarDoubleClick();
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
