// Builds the core's InvokeDeps from the Worker's env: the GitHub App (or the fake), the runner-key
// derivation and outbox delivery.
import { type FactoryServices, type InvokeDeps, OperationError } from "@software-factory/core";
import { fakeGitHub } from "@software-factory/core/testing";
import { runnerChannelKey } from "@software-factory/runner-contract";
import { githubApp } from "./github/app.ts";
import { mobileAttestation, mobileTestSeams } from "./mobile.ts";
import { deliverOutbox } from "./outbox.ts";
import { secrets } from "./secrets.ts";

/**
 * The GitHub App client, built once per isolate (AGENTS.md, Cloudflare cost, rule 10): its imported
 * key and App JWT are cached in memory, so building it per call would sign a JWT with RSA on every
 * operation. Installation tokens for runners are never cached (ADR 0033).
 */
let app: { config: string; client: ReturnType<typeof githubApp> } | null = null;
export function appFor(
  appId: string,
  appSlug: string,
  privateKey: string,
): ReturnType<typeof githubApp> {
  const config = `${appId}\n${appSlug}\n${privateKey}`;
  if (app?.config !== config) app = { config, client: githubApp({ appId, appSlug, privateKey }) };
  return app.client;
}

export function services(env: Env): FactoryServices {
  const { GH_APP_PRIVATE_KEY, RUNNER_CHANNEL_SECRET } = secrets(env);
  const github =
    env.GITHUB_FAKE === "1"
      ? fakeGitHub(env.DB)
      : GH_APP_PRIVATE_KEY
        ? appFor(env.GH_APP_ID, env.GH_APP_SLUG, GH_APP_PRIVATE_KEY)
        : unavailableGitHub();
  return {
    github,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    allowSoftwareDeviceKeys: env.DESKTOP_ALLOW_SOFTWARE_KEYS === "1",
    mobileAttestation: mobileAttestation(env),
    ...(env.DEPLOYED_SHA ? { deployedSha: env.DEPLOYED_SHA } : {}),
    ...(env.RUNNER_SHA ? { runnerSha: env.RUNNER_SHA } : {}),
    runnerKey: async (runnerId, version) => {
      if (!RUNNER_CHANNEL_SECRET) {
        throw new OperationError("unavailable", "RUNNER_CHANNEL_SECRET is not set on sf-engine");
      }
      return runnerChannelKey(RUNNER_CHANNEL_SECRET, runnerId, version);
    },
  };
}

export function invokeDeps(env: Env): InvokeDeps {
  return {
    d1: env.DB,
    services: services(env),
    deliver: (ids) => deliverOutbox(env, ids),
    beforeCommit: async (op) => {
      await mobileTestSeams.beforeCommit?.(op);
    },
  };
}

function unavailableGitHub(): FactoryServices["github"] {
  const no = async (): Promise<never> => {
    throw new OperationError("unavailable", "GH_APP_PRIVATE_KEY is not set on sf-engine");
  };
  return {
    app: { id: "", slug: "" },
    mintRepoToken: no,
    getBranchSha: no,
    getInstallation: no,
    listInstallationRepos: no,
    userInstallationIds: no,
  };
}
