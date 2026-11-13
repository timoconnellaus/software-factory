// Builds the core's InvokeDeps from the Worker's env: the GitHub App (or the fake), the runner-key
// derivation, the floor and outbox delivery.
import {
  type FactoryServices,
  type InvokeDeps,
  OperationError,
  r2AttachmentBlobs,
} from "@software-factory/core";
import { fakeGitHub } from "@software-factory/core/testing";
import { runnerChannelKey } from "@software-factory/runner-contract";
import { githubApp } from "./github/app.ts";
import { mobileAttestation, mobileTestSeams } from "./mobile.ts";
import { deliverOutbox } from "./outbox.ts";
import { secrets } from "./secrets.ts";

/**
 * The GitHub App client, built once per isolate (AGENTS.md, Cloudflare cost, rule 10): its imported
 * key, App JWT and control-plane tokens are cached in memory, so building it per call minted a token
 * with an RSA signature on every operation. Job tokens are never cached (ADR 0033).
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

/**
 * Archived chunks read by run.live, kept in the isolate (they never change once written): a person
 * paging through an old run reads each chunk from R2 once. Bounded by size: at most about 8 MB of
 * text (a chunk is at most 1 MB), least recently read out first. Null when the object isn't there;
 * an R2 failure throws, so run.live can tell "missing" from "couldn't read".
 */
const CHUNK_CACHE_CHARS = 8_000_000;
const chunkCache = new Map<string, string>();
let chunkCacheChars = 0;
async function archivedChunk(bucket: R2Bucket, key: string): Promise<string | null> {
  const hit = chunkCache.get(key);
  if (hit !== undefined) {
    chunkCache.delete(key);
    chunkCache.set(key, hit);
    return hit;
  }
  const object = await bucket.get(key);
  if (!object) return null;
  const text = await object.text();
  chunkCache.set(key, text);
  chunkCacheChars += text.length;
  for (const [old, value] of chunkCache) {
    if (chunkCacheChars <= CHUNK_CACHE_CHARS || old === key) break;
    chunkCache.delete(old);
    chunkCacheChars -= value.length;
  }
  return text;
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
    attachments: r2AttachmentBlobs(env.ATTACHMENTS),
    runArchive: {
      get: async (key, opts) =>
        opts?.fresh
          ? ((await env.ARCHIVE.get(key))?.text() ?? null)
          : archivedChunk(env.ARCHIVE, key),
      exists: async (key) => (await env.ARCHIVE.head(key)) !== null,
    },
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
    floor: env.FACTORY_FLOOR,
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
    createBranch: no,
    fastForward: no,
    commitFile: no,
    commitFiles: no,
    openPullRequest: no,
    changedFiles: no,
    mergePullRequest: no,
    getPullRequest: no,
    listOpenPullRequests: no,
    pullRequestMergeability: no,
    compareCommits: no,
    commitParents: no,
    commitTime: no,
    commitInfo: no,
    changedPaths: no,
    pathEntries: no,
    updatePullRequestBranch: no,
    compareFiles: no,
    readFile: no,
    listCheckRuns: no,
    postCheckRun: no,
    findRepoInstallation: no,
    repoGuards: no,
    repoPermission: no,
    appSettings: no,
    getInstallation: no,
    listInstallationRepos: no,
    getInstallationRepo: no,
    userInstallationIds: no,
    rerequestCheckRun: no,
    checkRunDetail: no,
    mergeBaseAmbiguous: no,
  };
}
