// @software-factory/runner-orca: the Orca runner adapter (ADR 0014, 0100). The runner host
// (`local/runner-host`) loads it; nothing in the core or the contract imports it.
export * from "./adapter.ts";
export * from "./exec.ts";
export * from "./orca-cli.ts";

export {
  diagnose,
  type Finding,
  findRepoForJob,
  isUnder,
  jobIdOf,
  type KeyedRepo,
  keyedRepos,
  type Migration,
  migrateRunnerRepos,
  pickRepo,
  type RepoOwnership,
  repoKey,
} from "./workspace.ts";
