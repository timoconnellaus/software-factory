// The app's server functions: same-origin RPC from the browser (CSRF-checked in start.ts). Each
// resolves the signed-in user from the request; operations run on sf-engine as that user.
import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { appEnv, findInstallation, runOp, sessionInfo, syncPolicyFromGitHub } from "./app-api.ts";

const headers = () => getRequest().headers;

/** The signed-in user and their orgs, or null. Route guards call this on navigation. */
export const getSession = createServerFn({ method: "GET" }).handler(() =>
  sessionInfo(appEnv(env), headers()),
);

/** One operation, by name, as the signed-in user. The typed client is `op()` in lib/op.ts. */
export const callOperation = createServerFn({ method: "POST" })
  .validator((data: unknown) => data)
  .handler(({ data }) => runOp(appEnv(env), headers(), data));

/** Re-reads `.factory/policy.json` from the project's default branch and records it. */
export const syncPolicy = createServerFn({ method: "POST" })
  .validator((data: unknown) => z.object({ projectId: z.string().min(1) }).parse(data))
  .handler(({ data }) => syncPolicyFromGitHub(appEnv(env), headers(), data.projectId));

/** The GitHub App installation covering a repo, for Setup's "Add project". */
export const detectInstallation = createServerFn({ method: "POST" })
  .validator((data: unknown) =>
    z.object({ owner: z.string().min(1).max(39), name: z.string().min(1).max(100) }).parse(data),
  )
  .handler(({ data }) => findInstallation(appEnv(env), headers(), data));
