// A fake GitHub App for tests and local dev (sf-engine uses it when GITHUB_FAKE=1). State lives in
// D1 (one JSON row per repo, in a table it creates), so a Workflow and a test see the same repo.
// Commits form a parent chain so fast-forwards are checked like the real thing.
import type { ChangedFile, CheckRunInfo, GitHubService, RepoGuards, RepoRef } from "../services.ts";

type Touch = string | { path: string; status: ChangedFile["status"] };

interface RepoState {
  refs: Record<string, string>;
  /** Paths each commit touched (set by `push`), for `changedFiles`. A plain path is "modified". */
  touched?: Record<string, Touch[]>;
  /** Check runs per commit SHA. A SHA with none reads as green CI (`ci`), unless `ciDefault` says otherwise. */
  checks?: Record<string, CheckRunInfo[]>;
  /** Files by ref or SHA, for `readFile`. */
  blobs?: Record<string, Record<string, string>>;
  guards?: RepoGuards;
  parents: Record<string, string | null>;
  files: Record<string, Record<string, string>>;
  pulls: { number: number; head: string; base: string; title: string; state: "open" | "merged" }[];
  tokens: number;
}

const TABLE = "fake_github_repos";

export interface FakeGitHub extends GitHubService {
  /** Simulates a runner's push: a new commit on `branch` whose parent is the branch head (or `from`). */
  push(repo: RepoRef, branch: string, from?: string, files?: Touch[]): Promise<string>;
  state(repo: RepoRef): Promise<RepoState>;
  /** Sets the CI check runs GitHub reports for a SHA (replacing the default green `ci`). */
  setChecks(repo: RepoRef, sha: string, checks: Omit<CheckRunInfo, "id">[]): Promise<void>;
  /** Puts a file at a ref (or SHA) for `readFile`. */
  setFile(repo: RepoRef, ref: string, path: string, content: string): Promise<void>;
  setGuards(repo: RepoRef, guards: RepoGuards): Promise<void>;
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
    async mergePullRequest(r, { number, sha: expected }) {
      const state = await load(r);
      const pull = state.pulls.find((p) => p.number === number);
      if (!pull) return { merged: false, reason: "no such pull request" };
      if (pull.state === "merged") return { merged: true, sha: state.refs[pull.base] ?? expected };
      if (state.refs[pull.head] !== expected) return { merged: false, reason: "head moved" };
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
      return [...touchesBetween(await load(r), base, head)].map(([path, status]) => ({
        path,
        status,
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
      return [{ ...GREEN_CI, id: `ci-${at.slice(0, 8)}` }];
    },
    async postCheckRun(r, check) {
      const state = await load(r);
      const runs = [
        ...(state.checks?.[check.headSha] ?? [
          { ...GREEN_CI, id: `ci-${check.headSha.slice(0, 8)}` },
        ]),
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
      await save(r, state);
      return { id };
    },
    async repoGuards(r) {
      return (await load(r)).guards ?? { protection: null, rulesets: [] };
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
