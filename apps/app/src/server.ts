// sf-app's Worker entry: /api/health, Better Auth under /api/auth/*, and TanStack Start for every
// other request (pages and server functions).
import handler from "@tanstack/react-start/server-entry";
import { AUTH_BASE_PATH, getAuth } from "./server/auth.ts";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/health") return Response.json({ ok: true, worker: "sf-app" });
    if (pathname === AUTH_BASE_PATH || pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
      return getAuth(env).handler(request);
    }
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
