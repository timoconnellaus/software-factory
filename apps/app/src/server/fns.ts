// The app's server functions: same-origin RPC from the browser (CSRF-checked in start.ts). Each
// resolves the signed-in user from the request; operations run on sf-engine as that user.
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { appEnv, runOp, sessionInfo } from "./app-api.ts";

const headers = () => getRequest().headers;

/** The signed-in user and their orgs, or null. Route guards call this on navigation. */
export const getSession = createServerFn({ method: "GET" }).handler(() =>
  sessionInfo(appEnv(env), headers()),
);

/** One operation, by name, as the signed-in user. The typed client is `op()` in lib/op.ts. */
export const callOperation = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(({ data }) => runOp(appEnv(env), headers(), data));
