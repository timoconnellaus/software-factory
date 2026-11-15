// A fake GitHub App for tests and local dev (sf-engine uses it when GITHUB_FAKE=1). State lives in
// D1 (one JSON row per repo and per installation, in tables it creates), so the engine and a test
// see the same repo. Commits form a parent chain, enough for a branch's head.
import type { GitHubService, InstallationInfo, InstallationRepo, RepoRef } from "../services.ts";

interface RepoState {
  refs: Record<string, string>;
  parents: Record<string, string | null>;
  /** Paths each commit touched (set by `push`). */
  touched?: Record<string, string[]>;
  /** How many installation tokens were minted for this repo. */
  tokens: number;
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
  push(repo: RepoRef, branch: string, from?: string, files?: string[]): Promise<string>;
  state(repo: RepoRef): Promise<RepoState>;
  /** Adds or replaces an installation of the App. */
  putInstallation(installation: FakeInstallation): Promise<void>;
  /** Removes an installation (GitHub forgot it: the App was uninstalled). */
  dropInstallation(installationId: string): Promise<void>;
}

export const FAKE_APP = { id: "1000", slug: "software-factory-test" } as const;

export function fakeGitHub(d1: D1Database, defaultBranch = "main"): FakeGitHub {
  const key = (r: RepoRef) => `${r.owner}/${r.repo}`;
  let ready: Promise<unknown> | null = null;
  const init = () => {
    ready ??= d1.batch([
      d1.prepare(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (repo TEXT PRIMARY KEY, state TEXT NOT NULL)`,
      ),
      d1.prepare(
        `CREATE TABLE IF NOT EXISTS ${INSTALLATIONS} (id TEXT PRIMARY KEY, state TEXT NOT NULL)`,
      ),
    ]);
    return ready;
  };
  const load = async (r: RepoRef): Promise<RepoState> => {
    await init();
    const row = await d1
      .prepare(`SELECT state FROM ${TABLE} WHERE repo = ?`)
      .bind(key(r))
      .first<{ state: string }>();
    if (row) return JSON.parse(row.state) as RepoState;
    const root = await sha(`${key(r)}:root`);
    return { refs: { [defaultBranch]: root }, parents: { [root]: null }, tokens: 0 };
  };
  const save = async (r: RepoRef, state: RepoState) => {
    await d1
      .prepare(
        `INSERT INTO ${TABLE} (repo, state) VALUES (?, ?) ON CONFLICT (repo) DO UPDATE SET state = excluded.state`,
      )
      .bind(key(r), JSON.stringify(state))
      .run();
  };
  const loadInstallation = async (id: string): Promise<FakeInstallation | null> => {
    await init();
    const row = await d1
      .prepare(`SELECT state FROM ${INSTALLATIONS} WHERE id = ?`)
      .bind(id)
      .first<{ state: string }>();
    return row ? (JSON.parse(row.state) as FakeInstallation) : null;
  };
  const allInstallations = async (): Promise<FakeInstallation[]> => {
    await init();
    const { results } = await d1.prepare(`SELECT state FROM ${INSTALLATIONS}`).all<{
      state: string;
    }>();
    return results.map((r) => JSON.parse(r.state) as FakeInstallation);
  };

  return {
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
      await init();
      await d1
        .prepare(
          `INSERT INTO ${INSTALLATIONS} (id, state) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state`,
        )
        .bind(installation.installationId, JSON.stringify(installation))
        .run();
    },
    async dropInstallation(id) {
      await init();
      await d1.prepare(`DELETE FROM ${INSTALLATIONS} WHERE id = ?`).bind(id).run();
    },
    async push(r, branch, from, files = ["src/index.ts"]) {
      const state = await load(r);
      const parent = from ?? state.refs[branch] ?? null;
      const next = await sha(`${parent}:push-${branch}:${crypto.randomUUID()}`);
      state.parents[next] = parent;
      state.refs[branch] = next;
      state.touched = { ...(state.touched ?? {}), [next]: files };
      await save(r, state);
      return next;
    },
    state: load,
  };
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
