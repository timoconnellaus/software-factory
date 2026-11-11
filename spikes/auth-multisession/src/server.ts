// Worker entry: Better Auth and the spike API first, TanStack Start for everything else.
import handler from "@tanstack/react-start/server-entry";
import type { AuthEnv } from "./server/auth.ts";
import { handleServerRequest } from "./server/handler.ts";

export default {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    return (await handleServerRequest(request, env)) ?? handler.fetch(request);
  },
};
