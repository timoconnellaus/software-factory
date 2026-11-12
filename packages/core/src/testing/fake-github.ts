// A fake GitHub App for tests and local dev (sf-engine uses it when GITHUB_FAKE=1). State lives in
// D1 (one JSON row per repo, in a table it creates), so a Workflow and a test see the same repo.
// Commits form a parent chain so fast-forwards are checked like the real thing.
import type {
  AppSettings,
  ChangedFile,
  CheckRunInfo,
  GitHubService,
  InstallationInfo,
  InstallationRepo,
  PullRequestInfo,
  RepoGuards,
  RepoRef,
} from "../services.ts";
import { PROTECTION_EVENTS } from "../verify/protection.ts";

type Touch =
  | string
  | { path: string; status: ChangedFile["status"]; previousPath?: string; patch?: string };

interface RepoState {
  refs: Record<string, string>;
  /** Paths each commit touched (set by `push`), for `changedFiles`. A plain path is "modified". */
  touched?: Record<string, Touch[]>;
  /** Check runs per commit SHA. A SHA with none reads as green CI (`ci`), unless `ciDefault` says otherwise. */
  checks?: Record<string, CheckRunInfo[]>;
  /** What each check run the App posted says, by check run id (tests read `factory/verify`'s). */
  checkOutputs?: Record<string, { title: string; summary: string }>;
  /** What a SHA with no check runs of its own reports (default: one green `ci`). */
  ciDefault?: Omit<CheckRunInfo, "id">[];
  /** Files by ref or SHA, for `readFile`. */
  blobs?: Record<string, Record<string, string>>;
  guards?: RepoGuards;
  /** Repo roles by lowercased login, for `repoPermission`. The owner is admin unless set. */
  permissions?: Record<string, string | null>;
  /** The App's installation on this repo; undefined reads as `"1"`, null as not installed. */
  installation?: string | null;
  parents: Record<string, string | null>;
  files: Record<string, Record<string, string>>;
  pulls: FakePull[];
  /** PRs GitHub can't merge (`false`) or is still computing (`null`), by number. Default mergeable. */
  mergeable?: Record<number, boolean | null>;
  /** Update-branch requests waiting for `completeUpdate` (`deferUpdates`), by PR number. */
  pendingUpdates?: number[];
  deferUpdates?: boolean;
  /** A merge commit's second parent (what `update-branch` merged in), by merge commit SHA. */
  merged?: Record<string, string>;
  tokens: number;
}

interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  state: "open" | "merged" | "closed";
  body?: string;
  author?: string;
  draft?: boolean;
  /** A fork's `owner/name`; unset means the repo itself. */
  headRepo?: string;
  /** A fork's head SHA (a fork's branch isn't in this repo's refs). */
  headSha?: string;
}

const TABLE = "fake_github_repos";
const INSTALLATIONS = "fake_github_installations";

/** An installation in the fake: what GitHub would tell the App, its repos, and who can see it. */
export interface FakeInstallation {
  installationId: string;
  account: { login: string; type: "User" | "Organization" };
  repositorySelection?: "all" | "selected";
  suspended?: boolean;
  repos?: InstallationRepo[];
  /** GitHub logins (besides a User account's own login) whose `/user/installations` lists it. */
  members?: string[];
}

/** The user token the fake accepts for `login` in `userInstallationIds`. */
export const fakeUserToken = (login: string) => `ghu_fake_${login}`;

export interface FakeGitHub extends GitHubService {
  /** Simulates a runner's push: a new commit on `branch` whose parent is the branch head (or `from`). */
  push(repo: RepoRef, branch: string, from?: string, files?: Touch[]): Promise<string>;
  state(repo: RepoRef): Promise<RepoState>;
  /** Sets the CI check runs GitHub reports for a SHA (replacing the default green `ci`). */
  setChecks(repo: RepoRef, sha: string, checks: Omit<CheckRunInfo, "id">[]): Promise<void>;
  /** Puts a file at a ref (or SHA) for `readFile`. */
  setFile(repo: RepoRef, ref: string, path: string, content: string): Promise<void>;
  setGuards(repo: RepoRef, guards: RepoGuards): Promise<void>;
  /**
   * Simulates GitHub's update-branch merge commit landing on a PR's head (GitHub does it
   * asynchronously; the fake does it at once unless `deferUpdates` is set). Returns the new head.
   */
  completeUpdate(repo: RepoRef, number: number): Promise<string | null>;
  /** Sets what CI reports on SHAs with no check runs of their own (null: one green `ci`). */
  setCiDefault(repo: RepoRef, checks: Omit<CheckRunInfo, "id">[] | null): Promise<void>;
  /** Makes `updatePullRequestBranch` accept without moving the head until `completeUpdate`. */
  deferUpdates(repo: RepoRef, on: boolean): Promise<void>;
  /** Sets what GitHub says about a PR's mergeability (false: conflicts; null: still computing). */
  setMergeable(repo: RepoRef, number: number, mergeable: boolean | null): Promise<void>;
  /** Sets a person's role on the repo (null: not a collaborator). */
  setPermission(repo: RepoRef, login: string, permission: string | null): Promise<void>;
  /** What `GET /app` reports (default: every event the factory needs). */
  setAppSettings(settings: AppSettings): void;
  /** Sets the App's installation on a repo for `findRepoInstallation` (null: not installed). Default `"1"`. */
  setInstallation(
    repo: Pick<RepoRef, "owner" | "repo">,
    installationId: string | null,
  ): Promise<void>;
  /** Creates or replaces an installation of the App (as `getInstallation` etc. will report it). */
  putInstallation(installation: FakeInstallation): Promise<void>;
  /** Removes an installation: GitHub then answers 404 for it. */
  dropInstallation(installationId: string): Promise<void>;
  /**
   * Opens a PR as a person would, outside the factory (spec 05): pushes a commit to `branch` unless
   * it exists, then opens the PR into the default branch. `fork` makes the head another repo's.
   */
  openOutsidePull(
    repo: RepoRef,
    input: {
      branch: string;
      title: string;
      body?: string;
      author?: string;
      draft?: boolean;
      fork?: string;
      files?: Touch[];
    },
  ): Promise<{ number: number; headSha: string }>;
  /** Closes a PR without merging it. */
  closePull(repo: RepoRef, number: number): Promise<void>;
}

export const FAKE_APP = { id: "1000", slug: "software-factory-test" } as const;

/** What an unknown SHA's CI looks like in the fake: one green `ci` check from Actions. */
const GREEN_CI: Omit<CheckRunInfo, "id"> = {
  name: "ci",
  status: "completed",
  conclusion: "success",
  appSlug: "github-actions",
  url: null,
};

export function fakeGitHub(d1: D1Database, defaultBranch = "main"): FakeGitHub {
  const key = (r: RepoRef) => `${r.owner}/${r.repo}`;
  let appSettings: AppSettings = {
    events: [
      "pull_request",
      "check_suite",
      "check_run",
      "push",
      "installation",
      "installation_repositories",
      ...PROTECTION_EVENTS,
    ],
    permissions: { administration: "read", contents: "write", metadata: "read" },
  };
  let ready: Promise<unknown> | null = null;
  const init = () => {
    ready ??= d1
      .prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (repo TEXT PRIMARY KEY, state TEXT NOT NULL)`)
      .run();
    return ready;
  };
  const load = async (r: RepoRef): Promise<RepoState> => {
    await init();
    const row = await d1
      .prepare(`SELECT state FROM ${TABLE} WHERE repo = ?`)
      .bind(key(r))
      .first<{ state: string }>();
    if (row) return JSON.parse(row.state) as RepoState;
    const root = sha(`${key(r)}:root`);
    return {
      refs: { [defaultBranch]: await root },
      parents: { [await root]: null },
      files: {},
      pulls: [],
      tokens: 0,
    };
  };
  let readyInstallations: Promise<unknown> | null = null;
  const loadInstallation = async (id: string): Promise<FakeInstallation | null> => {
    readyInstallations ??= d1
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${INSTALLATIONS} (id TEXT PRIMARY KEY, state TEXT NOT NULL)`,
      )
      .run();
    await readyInstallations;
    const row = await d1
      .prepare(`SELECT state FROM ${INSTALLATIONS} WHERE id = ?`)
      .bind(id)
      .first<{ state: string }>();
    return row ? (JSON.parse(row.state) as FakeInstallation) : null;
  };
  const allInstallations = async (): Promise<FakeInstallation[]> => {
    await loadInstallation("0");
    const { results } = await d1.prepare(`SELECT state FROM ${INSTALLATIONS}`).all<{
      state: string;
    }>();
    return results.map((r) => JSON.parse(r.state) as FakeInstallation);
  };
  const save = async (r: RepoRef, state: RepoState) => {
    await d1
      .prepare(
        `INSERT INTO ${TABLE} (repo, state) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET state = excluded.state`,
      )
      .bind(key(r), JSON.stringify(state))
      .run();
  };
  const isAncestor = (state: RepoState, ancestor: string, of: string) => {
    for (let at: string | null | undefined = of; at; at = state.parents[at]) {
      if (at === ancestor) return true;
    }
    return false;
  };
  /** Every commit reachable from `from`, through first parents and merged-in ones. */
  const reachable = (state: RepoState, from: string | null | undefined) => {
    const seen = new Set<string>();
    const todo = from ? [from] : [];
    while (todo.length > 0) {
      const at = todo.pop() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      const parent = state.parents[at];
      if (parent) todo.push(parent);
      const other = state.merged?.[at];
      if (other) todo.push(other);
    }
    return seen;
  };
  const updateHead = async (state: RepoState, number: number) => {
    const pull = state.pulls.find((p) => p.number === number);
    if (!pull) return null;
    const head = state.refs[pull.head];
    const base = state.refs[pull.base];
    if (!head || !base) return null;
    const next = await commit(state, head, `update-${number}`);
    state.merged = { ...(state.merged ?? {}), [next]: base };
    state.refs[pull.head] = next;
    return next;
  };
  const commit = async (state: RepoState, parent: string | null, salt: string) => {
    const next = await sha(`${parent}:${salt}:${crypto.randomUUID()}`);
    state.parents[next] = parent;
    return next;
  };

  const touchPath = (t: Touch) => (typeof t === "string" ? t : t.path);
  const touchesBetween = (state: RepoState, base: string, head: string) => {
    const stop = state.refs[base] ?? base;
    const files = new Map<string, ChangedFile["status"]>();
    const chain: string[] = [];
    for (
      let at: string | null | undefined = state.refs[head] ?? head;
      at && at !== stop;
      at = state.parents[at]
    ) {
      if (isAncestor(state, at, stop)) break;
      chain.unshift(at);
    }
    for (const at of chain) {
      for (const t of state.touched?.[at] ?? []) {
        const status = typeof t === "string" ? "modified" : t.status;
        const prior = files.get(touchPath(t));
        files.set(touchPath(t), prior === "added" && status !== "removed" ? "added" : status);
      }
    }
    return files;
  };
  /** The patches and renames the commits between base and head carry, last one wins (ADR 0500). */
  const detailsBetween = (state: RepoState, base: string, head: string) => {
    const touched = touchesBetween(state, base, head);
    const out = new Map<string, Omit<ChangedFile, "path" | "status">>();
    const stop = state.refs[base] ?? base;
    for (
      let at: string | null | undefined = state.refs[head] ?? head;
      at && at !== stop && !isAncestor(state, at, stop);
      at = state.parents[at]
    ) {
      for (const t of state.touched?.[at] ?? []) {
        if (typeof t === "string" || out.has(t.path) || !touched.has(t.path)) continue;
        out.set(t.path, {
          ...(t.previousPath ? { previousPath: t.previousPath } : {}),
          ...(t.patch !== undefined ? { patch: t.patch } : {}),
        });
      }
    }
    return out;
  };

  const github: FakeGitHub = {
    app: FAKE_APP,
    async mintRepoToken(r) {
      const state = await load(r);
      state.tokens++;
      await save(r, state);
      return {
        token: `ghs_fake_${crypto.randomUUID().replaceAll("-", "")}`,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    },
    async getBranchSha(r, branch) {
      return (await load(r)).refs[branch] ?? null;
    },
    async createBranch(r, branch, at) {
      const state = await load(r);
      if (state.refs[branch]) return;
      state.refs[branch] = at;
      await save(r, state);
    },
    async fastForward(r, branch, to) {
      const state = await load(r);
      const current = state.refs[branch];
      if (!(to in state.parents)) return { ok: false, reason: `unknown commit ${to}` };
      if (current && !isAncestor(state, current, to)) {
        return { ok: false, reason: `${to} is not a fast-forward of ${branch}` };
      }
      state.refs[branch] = to;
      await save(r, state);
      return { ok: true };
    },
    async commitFile(r, { branch, path, content }) {
      const state = await load(r);
      const parent = state.refs[branch] ?? null;
      const next = await commit(state, parent, path);
      state.refs[branch] = next;
      const existed = state.files[branch]?.[path] !== undefined;
      state.touched = {
        ...(state.touched ?? {}),
        [next]: [{ path, status: existed ? "modified" : "added" }],
      };
      state.files[branch] = { ...(state.files[branch] ?? {}), [path]: content };
      await save(r, state);
      return { commitSha: next };
    },
    async openPullRequest(r, { head, base, title }) {
      const state = await load(r);
      const open = state.pulls.find((p) => p.head === head && p.state === "open");
      if (open) return { number: open.number, url: pullUrl(r, open.number) };
      const number = state.pulls.length + 1;
      state.pulls.push({ number, head, base, title, state: "open" });
      await save(r, state);
      return { number, url: pullUrl(r, number) };
    },
    async getPullRequest(r, number) {
      const state = await load(r);
      const pull = state.pulls.find((p) => p.number === number);
      return pull ? pullInfo(r, state, pull) : null;
    },
    async listOpenPullRequests(r) {
      const state = await load(r);
      return state.pulls
        .filter((p) => p.state === "open")
        .reverse()
        .map((p) => pullInfo(r, state, p));
    },
    async openOutsidePull(r, input) {
      const state = await load(r);
      let headSha = input.fork ? undefined : state.refs[input.branch];
      if (!headSha) {
        headSha = await commit(state, state.refs[defaultBranch] ?? null, input.branch);
        state.touched = { ...(state.touched ?? {}), [headSha]: input.files ?? ["README.md"] };
        if (!input.fork) state.refs[input.branch] = headSha;
      }
      const number = state.pulls.length + 1;
      state.pulls.push({
        number,
        head: input.branch,
        base: defaultBranch,
        title: input.title,
        state: "open",
        body: input.body ?? "",
        author: input.author ?? "timoconnellaus",
        draft: input.draft ?? false,
        ...(input.fork ? { headRepo: input.fork, headSha } : {}),
      });
      await save(r, state);
      return { number, headSha };
    },
    async closePull(r, number) {
      const state = await load(r);
      const pull = state.pulls.find((p) => p.number === number);
      if (pull && pull.state === "open") pull.state = "closed";
      await save(r, state);
    },
    async pullRequestMergeability(r, number) {
      const state = await load(r);
      const pull = state.pulls.find((p) => p.number === number);
      if (!pull) throw new Error(`GitHub pull request #${number}: HTTP 404`);
      const mergeable = state.mergeable?.[number] ?? true;
      return {
        mergeable: pull.state === "merged" ? false : mergeable,
        mergeableState: mergeable === null ? "unknown" : mergeable ? "clean" : "dirty",
        headSha: state.refs[pull.head] ?? null,
      };
    },
    async setMergeable(r, number, mergeable) {
      const state = await load(r);
      state.mergeable = { ...(state.mergeable ?? {}), [number]: mergeable };
      await save(r, state);
    },
    async compareCommits(r, base, head) {
      const state = await load(r);
      const b = reachable(state, state.refs[base] ?? base);
      const h = reachable(state, state.refs[head] ?? head);
      return {
        aheadBy: [...h].filter((c) => !b.has(c)).length,
        behindBy: [...b].filter((c) => !h.has(c)).length,
      };
    },
    async commitParents(r, at) {
      const state = await load(r);
      const first = state.parents[at];
      const second = state.merged?.[at];
      return [...(first ? [first] : []), ...(second ? [second] : [])];
    },
    async updatePullRequestBranch(r, { number, expectedHeadSha }) {
      const state = await load(r);
      const pull = state.pulls.find((p) => p.number === number);
      if (pull?.state !== "open") return { status: "refused", reason: "not an open PR" };
      if (state.refs[pull.head] !== expectedHeadSha) {
        return { status: "refused", reason: "expected head sha didn't match current head ref" };
      }
      if (state.mergeable?.[number] === false) {
        return { status: "conflict", reason: "merge conflict between base and head" };
      }
      if (state.deferUpdates) {
        state.pendingUpdates = [...(state.pendingUpdates ?? []), number];
      } else {
        await updateHead(state, number);
      }
      await save(r, state);
      return { status: "requested" };
    },
    async completeUpdate(r, number) {
      const state = await load(r);
      state.pendingUpdates = (state.pendingUpdates ?? []).filter((n) => n !== number);
      const next = await updateHead(state, number);
      await save(r, state);
      return next;
    },
    async setCiDefault(r, checks) {
      const state = await load(r);
      if (checks) state.ciDefault = checks;
      else delete state.ciDefault;
      await save(r, state);
    },
    async deferUpdates(r, on) {
      const state = await load(r);
      state.deferUpdates = on;
      await save(r, state);
    },
    async mergePullRequest(r, { number, sha: expected }) {
      const state = await load(r);
      const pull = state.pulls.find((p) => p.number === number);
      if (!pull) return { merged: false, reason: "no such pull request" };
      if (pull.state === "merged") return { merged: true, sha: state.refs[pull.base] ?? expected };
      if (state.refs[pull.head] !== expected)
        return { merged: false, reason: "head moved", headMoved: true };
      const merge = await commit(state, expected, `merge-${number}`);
      state.refs[pull.base] = merge;
      pull.state = "merged";
      await save(r, state);
      return { merged: true, sha: merge };
    },
    async changedFiles(r, base, head) {
      return [...touchesBetween(await load(r), base, head).keys()];
    },
    async compareFiles(r, base, head) {
      const state = await load(r);
      const details = detailsBetween(state, base, head);
      return [...touchesBetween(state, base, head)].map(([path, status]) => ({
        path,
        status,
        ...details.get(path),
      }));
    },
    async readFile(r, path, ref) {
      const state = await load(r);
      return state.blobs?.[ref]?.[path] ?? state.files[ref]?.[path] ?? null;
    },
    async listCheckRuns(r, at) {
      const state = await load(r);
      const known = state.checks?.[at];
      if (known) return known;
      return (state.ciDefault ?? [GREEN_CI]).map((c, i) => ({
        ...c,
        id: `ci-${at.slice(0, 8)}-${i}`,
      }));
    },
    async postCheckRun(r, check) {
      const state = await load(r);
      const runs = [
        ...(state.checks?.[check.headSha] ??
          (state.ciDefault ?? [GREEN_CI]).map((c, i) => ({
            ...c,
            id: `ci-${check.headSha.slice(0, 8)}-${i}`,
          }))),
      ];
      const id = check.checkRunId ?? `cr-${crypto.randomUUID().slice(0, 8)}`;
      const run: CheckRunInfo = {
        id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion ?? null,
        appSlug: FAKE_APP.slug,
        url: check.detailsUrl ?? null,
      };
      const i = runs.findIndex((c) => c.id === id);
      if (i >= 0) runs[i] = run;
      else runs.push(run);
      state.checks = { ...(state.checks ?? {}), [check.headSha]: runs };
      state.checkOutputs = {
        ...(state.checkOutputs ?? {}),
        [id]: { title: check.title, summary: check.summary },
      };
      await save(r, state);
      return { id };
    },
    async findRepoInstallation(owner, repo) {
      const state = await load({ owner, repo, installationId: "" });
      const id = state.installation === undefined ? "1" : state.installation;
      return id
        ? { installationId: id, reason: null }
        : {
            installationId: null,
            reason: `the GitHub App ${FAKE_APP.slug} isn't installed on ${owner}/${repo}`,
          };
    },
    async setInstallation(r, installationId) {
      const ref = { ...r, installationId: "" };
      const state = await load(ref);
      state.installation = installationId;
      await save(ref, state);
    },
    async getInstallation(id) {
      const i = await loadInstallation(id);
      if (!i) return null;
      const info: InstallationInfo = {
        installationId: i.installationId,
        account: i.account,
        repositorySelection: i.repositorySelection ?? "selected",
        suspended: i.suspended ?? false,
      };
      return info;
    },
    async listInstallationRepos(id) {
      const i = await loadInstallation(id);
      if (!i) throw new Error(`GitHub installation token: HTTP 404 (installation ${id})`);
      return i.repos ?? [];
    },
    async getInstallationRepo(id, repoId) {
      const i = await loadInstallation(id);
      return i?.repos?.find((r) => r.id === repoId) ?? null;
    },
    async userInstallationIds(token) {
      const login = token.startsWith("ghu_fake_") ? token.slice("ghu_fake_".length) : null;
      if (!login) throw new Error("GitHub /user/installations: HTTP 401 Bad credentials");
      const lower = login.toLowerCase();
      return (await allInstallations())
        .filter(
          (i) =>
            (i.account.type === "User" && i.account.login.toLowerCase() === lower) ||
            (i.members ?? []).some((m) => m.toLowerCase() === lower),
        )
        .map((i) => i.installationId);
    },
    async putInstallation(installation) {
      await loadInstallation("0");
      await d1
        .prepare(
          `INSERT INTO ${INSTALLATIONS} (id, state) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state`,
        )
        .bind(installation.installationId, JSON.stringify(installation))
        .run();
    },
    async dropInstallation(id) {
      await loadInstallation("0");
      await d1.prepare(`DELETE FROM ${INSTALLATIONS} WHERE id = ?`).bind(id).run();
    },
    async repoGuards(r) {
      return (await load(r)).guards ?? { protection: null, rulesets: [], branchRules: null };
    },
    async repoPermission(r, login) {
      const state = await load(r);
      return state.permissions?.[login.toLowerCase()] ?? (login === r.owner ? "admin" : null);
    },
    async appSettings() {
      return appSettings;
    },
    setAppSettings(settings) {
      appSettings = settings;
    },
    async setPermission(r, login, permission) {
      const state = await load(r);
      state.permissions = { ...(state.permissions ?? {}), [login.toLowerCase()]: permission };
      await save(r, state);
    },
    async setChecks(r, at, checks) {
      const state = await load(r);
      const own = (state.checks?.[at] ?? []).filter((c) => c.appSlug === FAKE_APP.slug);
      state.checks = {
        ...(state.checks ?? {}),
        [at]: [...checks.map((c, i) => ({ ...c, id: `ci-${at.slice(0, 6)}-${i}` })), ...own],
      };
      await save(r, state);
    },
    async setFile(r, ref, path, content) {
      const state = await load(r);
      state.blobs = {
        ...(state.blobs ?? {}),
        [ref]: { ...(state.blobs?.[ref] ?? {}), [path]: content },
      };
      await save(r, state);
    },
    async setGuards(r, guards) {
      const state = await load(r);
      state.guards = guards;
      await save(r, state);
    },
    async push(r, branch, from, files = ["src/index.ts"]) {
      const state = await load(r);
      const parent = from ?? state.refs[branch] ?? null;
      const next = await commit(state, parent, `push-${branch}`);
      state.refs[branch] = next;
      state.touched = { ...(state.touched ?? {}), [next]: files };
      await save(r, state);
      return next;
    },
    state: load,
  };
  return github;
}

const pullUrl = (r: RepoRef, n: number) => `https://github.com/${r.owner}/${r.repo}/pull/${n}`;

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function pullInfo(r: RepoRef, state: RepoState, p: FakePull): PullRequestInfo {
  return {
    number: p.number,
    url: pullUrl(r, p.number),
    title: p.title,
    body: p.body ?? "",
    state: p.state === "open" ? "open" : "closed",
    merged: p.state === "merged",
    draft: p.draft ?? false,
    author: p.author ?? null,
    head: {
      ref: p.head,
      sha: p.headSha ?? state.refs[p.head] ?? "",
      repo: p.headRepo ?? `${r.owner}/${r.repo}`,
    },
    base: { ref: p.base },
  };
}
