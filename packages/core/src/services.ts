// What operations may call outside D1. sf-engine supplies the real ones (the GitHub App, the runner
// channel secret); tests supply fakes (`@software-factory/core/testing`). Handlers that call a
// service do it before the batch commits, so every such call must be idempotent.

export interface RepoRef {
  /** The GitHub App installation that covers the repo (ADR 0025). */
  installationId: string;
  owner: string;
  repo: string;
}

/** The GitHub App, acting as the factory (ADR 0025, 0033). Never a user token. */
export interface GitHubService {
  /**
   * A short-lived installation token scoped to this one repository, `contents: write` only
   * (ADR 0033). GitHub can't scope a token to a branch: see ADR 0052 for how pushes are confined.
   */
  mintRepoToken(repo: RepoRef): Promise<{ token: string; expiresAt: string }>;
  /** The branch's head SHA, or null if it doesn't exist. */
  getBranchSha(repo: RepoRef, branch: string): Promise<string | null>;
  /** Creates `branch` at `sha`. A no-op if it already exists. */
  createBranch(repo: RepoRef, branch: string, sha: string): Promise<void>;
  /** Moves `branch` to `sha` only as a fast-forward. */
  fastForward(
    repo: RepoRef,
    branch: string,
    sha: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Commits one file to `branch` (creating or replacing it); returns the new commit SHA. */
  commitFile(
    repo: RepoRef,
    input: { branch: string; path: string; content: string; message: string },
  ): Promise<{ commitSha: string }>;
  /** Opens a PR from `head` into `base`, or returns the open one for `head`. */
  openPullRequest(
    repo: RepoRef,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }>;
  /** Merges the PR if its head is still `sha`. */
  mergePullRequest(
    repo: RepoRef,
    input: { number: number; sha: string; method: "merge" | "squash" },
  ): Promise<{ merged: true; sha: string } | { merged: false; reason: string }>;
}

export interface FactoryServices {
  github: GitHubService;
  /**
   * A runner's channel key (spike ADR 0100): HMAC of the runner id and key version under
   * RUNNER_CHANNEL_SECRET. Throws an `unavailable` OperationError when the secret isn't set.
   */
  runnerKey(runnerId: string, keyVersion: number): Promise<string>;
}
