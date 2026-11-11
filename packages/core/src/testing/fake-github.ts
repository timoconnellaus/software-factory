// A fake GitHub App for tests and local dev (sf-engine uses it when GITHUB_FAKE=1). State lives in
// D1 (one JSON row per repo, in a table it creates), so a Workflow and a test see the same repo.
// Commits form a parent chain so fast-forwards are checked like the real thing.
import type { GitHubService, RepoRef } from "../services.ts";

interface RepoState {
  refs: Record<string, string>;
  parents: Record<string, string | null>;
  files: Record<string, Record<string, string>>;
  pulls: { number: number; head: string; base: string; title: string; state: "open" | "merged" }[];
  tokens: number;
}

const TABLE = "fake_github_repos";

export interface FakeGitHub extends GitHubService {
  /** Simulates a runner's push: a new commit on `branch` whose parent is the branch head (or `from`). */
  push(repo: RepoRef, branch: string, from?: string): Promise<string>;
  state(repo: RepoRef): Promise<RepoState>;
}

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

  const github: FakeGitHub = {
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
    async push(r, branch, from) {
      const state = await load(r);
      const parent = from ?? state.refs[branch] ?? null;
      const next = await commit(state, parent, `push-${branch}`);
      state.refs[branch] = next;
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
