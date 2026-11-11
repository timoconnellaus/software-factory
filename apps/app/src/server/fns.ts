// The app's server functions: same-origin RPC from the browser (CSRF-checked in start.ts). Each
// resolves the signed-in user from the request; operations run on sf-engine as that user. Each one
// reports where its time went in a `Server-Timing` header (session, each engine call).
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { appendResponseHeader, getRequest } from "@tanstack/react-start/server";
import { appEnv, runOp, runReads, sessionInfo, Timings } from "./app-api.ts";

const headers = () => getRequest().headers;

async function timed<T>(fn: (timings: Timings) => Promise<T>): Promise<T> {
  const timings = new Timings();
  try {
    return await timings.time("total", () => fn(timings));
  } finally {
    appendResponseHeader("Server-Timing", timings.header());
  }
}

/**
 * The signed-in user and their orgs, or null. The client asks once per page load and keeps the
 * answer in the query cache (`sessionQuery`), refreshing it in the background.
 */
export const getSession = createServerFn({ method: "GET" }).handler(() =>
  timed((t) => sessionInfo(appEnv(env), headers(), t)),
);

/** One operation, by name, as the signed-in user. The typed client is `op()` in lib/op.ts. */
export const callOperation = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(({ data }) => timed((t) => runOp(appEnv(env), headers(), data, t)));

/** Several read operations in one request, in parallel. The batching client is `read()`. */
export const callReads = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(({ data }) => timed((t) => runReads(appEnv(env), headers(), data, t)));
