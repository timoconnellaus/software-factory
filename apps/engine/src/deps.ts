// Builds the core's InvokeDeps from the Worker's env: the GitHub App (or the fake), the runner-key
// derivation, the floor and outbox delivery.
import { type FactoryServices, type InvokeDeps, OperationError } from "@software-factory/core";
import { fakeGitHub } from "@software-factory/core/testing";
import { runnerChannelKey } from "@software-factory/runner-contract";
import { githubApp } from "./github/app.ts";
import { deliverOutbox } from "./outbox.ts";

export function services(env: Env): FactoryServices {
  const github =
    env.GITHUB_FAKE === "1"
      ? fakeGitHub(env.DB)
      : env.GH_APP_PRIVATE_KEY
        ? githubApp({ appId: env.GH_APP_ID, privateKey: env.GH_APP_PRIVATE_KEY })
        : unavailableGitHub();
  return {
    github,
    runnerKey: async (runnerId, version) => {
      if (!env.RUNNER_CHANNEL_SECRET) {
        throw new OperationError("unavailable", "RUNNER_CHANNEL_SECRET is not set on sf-engine");
      }
      return runnerChannelKey(env.RUNNER_CHANNEL_SECRET, runnerId, version);
    },
  };
}

export function invokeDeps(env: Env): InvokeDeps {
  return {
    d1: env.DB,
    services: services(env),
    floor: env.FACTORY_FLOOR,
    deliver: (ids) => deliverOutbox(env, ids),
  };
}

function unavailableGitHub(): FactoryServices["github"] {
  const no = async (): Promise<never> => {
    throw new OperationError("unavailable", "GH_APP_PRIVATE_KEY is not set on sf-engine");
  };
  return {
    mintRepoToken: no,
    getBranchSha: no,
    createBranch: no,
    fastForward: no,
    commitFile: no,
    openPullRequest: no,
    changedFiles: no,
    mergePullRequest: no,
  };
}
