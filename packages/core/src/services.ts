import type { AttachmentBlobs } from "./attachments.ts";
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

/** A check run on a commit, as GitHub reports it (CI, `factory/verify`, anything else). */
export interface CheckRunInfo {
  id: string;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  /** Set once completed: success, failure, neutral, cancelled, skipped, timed_out, action_required, stale. */
  conclusion: string | null;
  /** The App that posted it (`github-actions` for Actions), when GitHub says. */
  appSlug: string | null;
  url: string | null;
  /** When GitHub started and completed the run, if it says (spec 53: orders `main` observations). */
  startedAt?: string | null;
  completedAt?: string | null;
}

/** What `factory/verify` (or any check the App posts) should say about one head SHA. */
export interface CheckRunPost {
  name: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "neutral" | "cancelled" | "action_required";
  title: string;
  /** Markdown, at most 65 535 characters. */
  summary: string;
  detailsUrl?: string;
  externalId?: string;
  /** Update this check run instead of creating one. */
  checkRunId?: string | null;
}

/** One file in a compare, with how it changed (for the check-only auto-merge rule, ADR 0230). */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  previousPath?: string;
  /**
   * The file's unified diff, when GitHub returned one (ADR 0500). GitHub leaves it out for large
   * or binary files; the tests-intact guard reports a test or gate file without one.
   */
  patch?: string;
  /** Lines added plus removed, as GitHub counts them (0 for a pure rename). */
  changes?: number;
}

/** A tree entry: the file's mode (`100644`, `100755`, `120000`, `160000`) and its blob SHA. */
export interface TreeEntry {
  mode: string;
  sha: string;
}
/** A commit's files by path. */
export type Tree = Record<string, TreeEntry>;

export interface CommitInfo {
  parents: string[];
  committer: { name: string; email: string } | null;
  /** GitHub verified the commit's signature (its own web-flow signs update-branch merges). */
  verified: boolean;
}

/** One rule of a repository ruleset, as GitHub reports it. */
export interface RulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}

/** Who may bypass a ruleset. */
export interface BypassActor {
  actorType: string;
  actorId: number | null;
  bypassMode: string;
}

/** A repository ruleset (the repo's own or inherited from its org). */
export interface RulesetInfo {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  include: string[];
  exclude: string[];
  rules: RulesetRule[];
  /** Null when GitHub didn't say (it shows the list only to some callers). */
  bypassActors: BypassActor[] | null;
}

/** A rule in force on one branch, with the ruleset it comes from (`GET /rules/branches/{b}`). */
export interface BranchRule extends RulesetRule {
  rulesetId: number;
}

/** What guards a repo's default branch: classic branch protection and repository rulesets. */
export interface RepoGuards {
  /** Null when the branch has no classic protection (or it can't be read). */
  protection: {
    requiredChecks: { context: string; appId: number | null }[];
    enforceAdmins: boolean;
  } | null;
  rulesets: RulesetInfo[];
  /** GitHub's own list of rules in force on the branch; null: compute it from `rulesets`. */
  branchRules: BranchRule[] | null;
}

/** What the App is set up to receive and do, as GitHub reports it (`GET /app`). */
export interface AppSettings {
  events: string[];
  permissions: Record<string, string>;
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

/** The GitHub App, acting as the factory (ADR 0025, 0033). Never a user token. */
/** A pull request as GitHub reports it. */
export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** The author's login. */
  author: string | null;
  /** `repo` is the head repository's `owner/name` (a fork's differs); null when it was deleted. */
  head: { ref: string; sha: string; repo: string | null };
  base: { ref: string };
  /** The merge commit once merged (GitHub's `merge_commit_sha`); null or absent otherwise. */
  mergeCommitSha?: string | null;
}

export interface GitHubService {
  /** The App itself: its id (branch protection pins `factory/verify` to it) and slug (`<slug>[bot]`). */
  readonly app: { id: string; slug: string };
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
  /**
   * Commits several files to `branch` in ONE commit (spec 22: the spec and its `.kim/` artifacts
   * land together); returns the new commit SHA. Through the Git Data API: blobs, a tree on the
   * branch's head, a commit, and a fast-forward of the branch.
   */
  commitFiles(
    repo: RepoRef,
    input: { branch: string; files: { path: string; content: string }[]; message: string },
  ): Promise<{ commitSha: string }>;
  /** Opens a PR from `head` into `base`, or returns the open one for `head`. */
  openPullRequest(
    repo: RepoRef,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }>;
  /** Paths changed between two refs (for the self-modify check on `.factory/`, ADR 0036). */
  changedFiles(repo: RepoRef, base: string, head: string): Promise<string[]>;
  /** The same compare, with each file's status. Only GitHub's answer counts, never the runner's. */
  compareFiles(repo: RepoRef, base: string, head: string): Promise<ChangedFile[]>;
  /** A file's text at a ref (branch or SHA), or null when it doesn't exist there. */
  readFile(repo: RepoRef, path: string, ref: string): Promise<string | null>;
  /** Every check run on a commit (paged through). */
  listCheckRuns(repo: RepoRef, sha: string): Promise<CheckRunInfo[]>;
  /** Creates (or, with `checkRunId`, updates) a check run as the App. Needs `checks: write`. */
  postCheckRun(repo: RepoRef, check: CheckRunPost): Promise<{ id: string }>;
  /**
   * Asks GitHub to run a check again (`POST /check-runs/{id}/rerequest`; for GitHub Actions it
   * re-runs the job). Needs `checks: write`. The babysitter's one flake rerun (spec 53 §4).
   */
  rerequestCheckRun(repo: RepoRef, checkRunId: string): Promise<{ ok: boolean; reason: string }>;
  /**
   * What a check run reported about itself: its output's title, summary and text, and its first
   * annotations (path:line and message), clipped. The babysit job's evidence for "flake or
   * regression?": the agent has no GitHub credentials of its own (ADR 0033). Needs `checks: read`.
   */
  checkRunDetail(repo: RepoRef, checkRunId: string): Promise<string>;
  /**
   * The App's installation covering `owner/repo`, asked as the App itself (its JWT, `GET
   * /repos/{owner}/{repo}/installation`): no user token involved. `reason` says why there is none.
   */
  findRepoInstallation(
    owner: string,
    repo: string,
  ): Promise<{ installationId: string; reason: null } | { installationId: null; reason: string }>;
  /** An installation of the App, asked as the App (its JWT). Null when GitHub doesn't know it. */
  getInstallation(installationId: string): Promise<InstallationInfo | null>;
  /** Every repository the installation can reach (installation token, paged). */
  listInstallationRepos(installationId: string): Promise<InstallationRepo[]>;
  /** One repository by id, only if the installation can reach it; null otherwise. */
  getInstallationRepo(installationId: string, repoId: number): Promise<InstallationRepo | null>;
  /**
   * The installation ids a person can see, asked with their own GitHub user token (`GET
   * /user/installations`). Used only to prove a person may connect an installation (ADR 0055); the
   * token is never stored and never used for repo access.
   */
  userInstallationIds(userToken: string): Promise<string[]>;
  /** Branch protection and rulesets on `branch` (project onboarding, spec 04; ADR 0280). */
  repoGuards(repo: RepoRef, branch: string): Promise<RepoGuards>;
  /**
   * A person's role on the repo (`GET /collaborators/{login}/permission`, as the App): `admin`,
   * `maintain`, `write`, `triage`, `read`, or null when they aren't a collaborator. Only to choose
   * between "apply this yourself" and "send it to the repo admin" (ADR 0280).
   */
  repoPermission(repo: RepoRef, login: string): Promise<string | null>;
  /** The App's subscribed events and permissions (`GET /app`, its JWT). */
  appSettings(): Promise<AppSettings>;
  /** One pull request, or null when it doesn't exist (spec 05: attaching an outside PR). */
  getPullRequest(repo: RepoRef, number: number): Promise<PullRequestInfo | null>;
  /** The repo's open pull requests, newest first (at most 100). */
  listOpenPullRequests(repo: RepoRef): Promise<PullRequestInfo[]>;
  /**
   * Whether GitHub can merge the PR into its base (`GET /pulls/{n}`): `mergeable` is null while
   * GitHub is still computing it (the first read starts that). `headSha` is the PR's head as GitHub
   * sees it. GitHub runs no `pull_request` workflows on a PR it can't merge (ADR 0320).
   */
  pullRequestMergeability(
    repo: RepoRef,
    number: number,
  ): Promise<{ mergeable: boolean | null; mergeableState: string | null; headSha: string | null }>;
  /**
   * How two commits relate (`GET /compare/{base}...{head}`): `aheadBy` commits in `head` that
   * aren't in `base`, `behindBy` commits in `base` that aren't in `head`. The merge queue uses
   * `behindBy` to see whether a PR's head still lacks the default branch (ADR 0330).
   */
  compareCommits(
    repo: RepoRef,
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; behindBy: number }>;
  /** A commit's parents, in order (`GET /commits/{sha}`). */
  commitParents(repo: RepoRef, sha: string): Promise<string[]>;
  /** The commit's committer date as GitHub gives it (ISO), or null when it isn't there. */
  commitTime(repo: RepoRef, sha: string): Promise<string | null>;
  /**
   * A commit's parents, its committer and whether GitHub verified its signature (spec 53: a merge
   * of the default branch counts only when GitHub's update-branch made it). Null: no such commit.
   */
  commitInfo(repo: RepoRef, sha: string): Promise<CommitInfo | null>;
  /**
   * The paths that differ between `base`'s merge base with `head` and `head` (GitHub's compare,
   * renames' old paths included), and that merge base. `complete` is false when GitHub may have left
   * paths out (it lists at most 300 files): a caller then can't rely on it (spec 53, fail closed).
   */
  changedPaths(
    repo: RepoRef,
    base: string,
    head: string,
  ): Promise<{ mergeBase: string | null; paths: string[]; complete: boolean }>;
  /**
   * The entries (mode and blob SHA) of just these paths in the commit's tree; a path that isn't
   * there is left out. Reads only the paths' directories, never the whole tree (second review of
   * #105: large repositories).
   */
  pathEntries(repo: RepoRef, sha: string, paths: readonly string[]): Promise<Tree>;
  /**
   * Merges the PR's base into its head on GitHub (`PUT /pulls/{n}/update-branch`), only if the
   * head is still `expectedHeadSha`. GitHub makes the merge commit asynchronously: `requested`
   * means it accepted; read the PR's head afterwards. `conflict`: the base can't merge in cleanly.
   */
  updatePullRequestBranch(
    repo: RepoRef,
    input: { number: number; expectedHeadSha: string },
  ): Promise<{ status: "requested" } | { status: "conflict" | "refused"; reason: string }>;
  /**
   * Merges the PR if its head is still `sha`. `headMoved`: refused because the head is no longer
   * `sha` (GitHub's 409 "Head branch was modified").
   */
  mergePullRequest(
    repo: RepoRef,
    input: { number: number; sha: string; method: "merge" | "squash" },
  ): Promise<
    { merged: true; sha: string } | { merged: false; reason: string; headMoved?: boolean }
  >;
}

export interface FactoryServices {
  github: GitHubService;
  /**
   * Blob storage for work item attachments (ADR 0310): R2 on sf-engine. Absent where nothing
   * stores files; the attachment operations then refuse with `unavailable`.
   */
  attachments?: AttachmentBlobs;
  /**
   * The archive of runs' events (sf-archive on sf-engine): one chunk's NDJSON by its key, or null
   * when it isn't there. run.live reads an archived run's page from here. Absent where nothing is
   * archived (tests that don't need it, sf-app).
   */
  runArchive?: {
    get(key: string): Promise<string | null>;
    /** Whether the object is there (an R2 HEAD): run.reportArchiveMissing checks for itself. */
    exists(key: string): Promise<boolean>;
  };
  /** The app's public URL (`PUBLIC_BASE_URL`), for links GitHub shows (the check's details). */
  publicBaseUrl?: string;
  /**
   * Accept presence proofs from desktop devices with a software key (ADR 0391). Off unless the
   * engine runs with `DESKTOP_ALLOW_SOFTWARE_KEYS=1`, which no deployed config sets: fails closed.
   * Macs only: a phone with a software key never decides, whatever this says (ADR 0541).
   */
  allowSoftwareDeviceKeys?: boolean;
  /**
   * The phone app's key attestation (ADR 0541): the allowed signing certificates, Google's
   * revocation list and the chain check. Absent: phone sign-in is refused as `unavailable`.
   */
  mobileAttestation?: MobileAttestationService;
  /**
   * The default-branch commit this engine was deployed from (ADR 0360). Sent to runners as
   * `desiredVersion` only when `runnerSha` is unset. Unset on a dev engine.
   */
  deployedSha?: string;
  /**
   * The last commit at or before `deployedSha` that changed runner code (ADR 0520), computed by the
   * deploy: what runners are asked to run, so a deploy that changed no runner code moves no runner.
   * Unset (an older deploy, a dev engine): `deployedSha` is used.
   */
  runnerSha?: string;
  /**
   * A runner's channel key (spike ADR 0100): HMAC of the runner id and key version under
   * RUNNER_CHANNEL_SECRET. Throws an `unavailable` OperationError when the secret isn't set.
   */
  runnerKey(runnerId: string, keyVersion: number): Promise<string>;
}

/**
 * The commit runners should run (ADR 0360, 0520): the last runner-relevant commit the deploy
 * computed, else the deployed commit, or null on an engine that knows neither.
 */
export function desiredRunnerVersion(
  services: Pick<FactoryServices, "deployedSha" | "runnerSha">,
): string | null {
  for (const candidate of [services.runnerSha, services.deployedSha]) {
    const sha = candidate?.trim() ?? "";
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}
