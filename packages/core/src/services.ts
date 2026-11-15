import type { MobileAttestationService } from "./operations/mobile.ts";

// What operations may call outside D1. sf-engine supplies the real ones (the GitHub App, the runner
// channel secret); tests supply fakes (`@software-factory/core/testing`). Handlers that call a
// service do it before the batch commits, so every such call must be idempotent.

export interface RepoRef {
  /** The GitHub App installation that covers the repo (ADR 0025). */
  installationId: string;
  owner: string;
  repo: string;
}

/** An installation of the factory's App, as GitHub reports it to the App (ADR 0055). */
export interface InstallationInfo {
  installationId: string;
  account: { login: string; type: "User" | "Organization" };
  repositorySelection: "all" | "selected";
  suspended: boolean;
}

/** A repository an installation can reach. */
export interface InstallationRepo {
  /** GitHub's repo id: stable across renames and transfers. */
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
}

/**
 * The factory's GitHub App, as the platform uses it: connecting an installation (ADR 0055), and
 * what the new core needs (spec 70): the repositories an installation reaches, a branch's head and
 * one-repository installation tokens (no standing tokens: ADR 0033).
 */
export interface GitHubService {
  readonly app: { id: string; slug: string };
  /** A token for one repository with these permissions (default `contents: write`). */
  mintRepoToken(
    repo: RepoRef,
    permissions?: Record<string, string>,
  ): Promise<{ token: string; expiresAt: string }>;
  getBranchSha(repo: RepoRef, branch: string): Promise<string | null>;
  getInstallation(installationId: string): Promise<InstallationInfo | null>;
  listInstallationRepos(installationId: string): Promise<InstallationRepo[]>;
  /** The installations a person's GitHub user token can see (proof of access to an org's). */
  userInstallationIds(userToken: string): Promise<string[]>;
}

export interface FactoryServices {
  github: GitHubService;
  /** The website's origin, for the links a sign-in hands back. */
  publicBaseUrl?: string;
  /** Accept presence proofs from desktop devices with a software key (a dev engine only). */
  allowSoftwareDeviceKeys?: boolean;
  mobileAttestation?: MobileAttestationService;
  /** The default-branch commit this engine was deployed from (ADR 0360). */
  deployedSha?: string;
  /** The last commit at or before `deployedSha` that changed runner code (ADR 0520). */
  runnerSha?: string;
  runnerKey(runnerId: string, keyVersion: number): Promise<string>;
}

/** The commit runners should run (ADR 0360, 0520): the runner code's, else the deploy's, else null. */
export function desiredRunnerVersion(
  services: Pick<FactoryServices, "deployedSha" | "runnerSha">,
): string | null {
  for (const candidate of [services.runnerSha, services.deployedSha]) {
    const sha = candidate?.trim() ?? "";
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}
