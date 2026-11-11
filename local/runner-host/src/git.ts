// Git on the runner host (ADR 0033, 0035, 0052). The host, not the harness, talks to GitHub: it
// keeps one clone per repo, fetches the job's base with the job token, and after the session pushes
// the run branch, and only the run branch, with a fresh job token. Every git call it makes runs with
// no system or global config (so never the owner's keychain helper or `gh auth git-credential`),
// hooks off, and a credential helper that answers only github.com with the job token. The token is
// passed in the environment of that one git process, never in its arguments or on disk.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PRIVATE_WORKTREE_FILES } from "@software-factory/harness-claude";
import type { Artifact, Job } from "@software-factory/runner-contract";
import type { Exec } from "@software-factory/runner-orca";

/** The push remote of a clone: a URL git can't use, so only the host's explicit push works. */
export const DISABLED_PUSH_URL = "no-push://the-runner-host-pushes";

/** A credential helper that gives the job token to github.com and nothing else. */
const HELPER = [
  "!f() {",
  'test "$1" = get || exit 0;',
  "ok=;",
  'while IFS= read -r line; do case "$line" in host=github.com) ok=1;; esac; done;',
  'test -n "$ok" && test -n "$SF_JOB_TOKEN" && printf "username=x-access-token\\npassword=%s\\n" "$SF_JOB_TOKEN";',
  "}; f",
].join(" ");

/** Variables the host's own git calls never inherit. */
const DROP = /TOKEN|SECRET|PASSWORD|CREDENTIAL|^SSH_|^GIT_|^GH_|^GITHUB_/i;

export interface HostGitOptions {
  exec: Exec;
  /** Where the host keeps its clones: `<reposDir>/<owner>/<name>`. */
  reposDir: string;
  identity: { name: string; email: string };
  /** Test hook: a clone/push URL in place of a job's GitHub URL (e.g. a local bare repo). */
  repoUrlMap?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

export class GitError extends Error {
  override name = "GitError";
}

/** The run branch a job may push: its own `factory/<n>-<slug>-run-<k>`, nothing else (ADR 0035). */
export function assertPushable(job: Pick<Job, "branch" | "repo" | "runNo">, pushBranch?: string) {
  const expected = `${job.repo.baseRef}-run-${job.runNo}`;
  if (job.branch !== expected) {
    throw new GitError(`job branch ${job.branch} is not the run branch ${expected}`);
  }
  if (!/^factory\/[0-9]+-[a-z0-9-]+-run-[0-9]+$/.test(job.branch)) {
    throw new GitError(`refusing to push ${job.branch}: not a factory run branch`);
  }
  if (pushBranch !== undefined && pushBranch !== job.branch) {
    throw new GitError(`the job token is for ${pushBranch}, not ${job.branch}`);
  }
}

/** Config keys that change where a push goes or what runs during it. */
const SENSITIVE =
  /^(url\.|remote\.|credential|http\.|https\.|include|core\.(sshcommand|hookspath|fsmonitor|askpass|gitproxy)|filter\.|protocol\.|transfer\.|push\.)/i;

export function hostGit(options: HostGitOptions) {
  const { exec } = options;
  const locks = new Map<string, Promise<unknown>>();

  function env(token?: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env ?? process.env)) {
      if (v !== undefined && !DROP.test(k)) out[k] = v;
    }
    out.GIT_CONFIG_NOSYSTEM = "1";
    out.GIT_CONFIG_GLOBAL = "/dev/null";
    out.GIT_TERMINAL_PROMPT = "0";
    out.GIT_ASKPASS = "/usr/bin/false";
    if (token) out.SF_JOB_TOKEN = token;
    return out;
  }

  const base = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${HELPER}`,
    "-c",
    `user.name=${options.identity.name}`,
    "-c",
    `user.email=${options.identity.email}`,
    "-c",
    "commit.gpgsign=false",
  ];

  async function git(cwd: string, args: string[], token?: string): Promise<string> {
    const result = await exec("git", [...base, ...args], {
      cwd,
      timeoutMs: 10 * 60_000,
      env: env(token),
    });
    if (result.code !== 0) {
      throw new GitError(`git ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  /** The URL the host clones and pushes: the job's GitHub URL, checked against its owner/name. */
  function remoteUrl(job: Pick<Job, "repo">): string {
    const canonical = `https://github.com/${job.repo.owner}/${job.repo.name}.git`;
    if (job.repo.url !== canonical && job.repo.url !== canonical.replace(/\.git$/, "")) {
      throw new GitError(`repo URL ${job.repo.url} is not ${canonical}`);
    }
    return options.repoUrlMap?.[canonical] ?? canonical;
  }

  /** Serialises git work per clone (two jobs on one repo would fight over its locks). */
  async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  }

  return {
    git,
    remoteUrl,

    clonePath(job: Pick<Job, "repo">): string {
      return join(options.reposDir, job.repo.owner, job.repo.name);
    },

    /**
     * Makes sure the host's clone of the job's repo exists and has the job's base (and, for verify,
     * the head under review). Returns the clone's path.
     */
    async ensureRepo(job: Job, token: string): Promise<string> {
      const path = this.clonePath(job);
      const url = remoteUrl(job);
      return locked(path, async () => {
        const isRepo = await exec("git", ["rev-parse", "--git-dir"], { cwd: path, env: env() })
          .then((r) => r.code === 0)
          .catch(() => false);
        if (!isRepo) {
          await mkdir(dirname(path), { recursive: true });
          await git(dirname(path), ["clone", "--no-checkout", "--quiet", url, path], token);
        }
        // The clone's own config: fetch from GitHub, never push through `origin`, no helpers.
        await git(path, ["config", "remote.origin.url", url]);
        await git(path, ["config", "remote.origin.pushurl", DISABLED_PUSH_URL]);
        await git(path, ["config", "--replace-all", "credential.helper", ""]);
        await excludePrivate(path);
        await git(
          path,
          [
            "fetch",
            "--quiet",
            "--prune",
            "origin",
            `+refs/heads/${job.repo.baseRef}:refs/remotes/origin/${job.repo.baseRef}`,
          ],
          token,
        );
        return path;
      });
    },

    /** Where the job's worktree should start: the reviewed head for verify, else the base. */
    async startPoint(job: Job, clone: string): Promise<string> {
      const head = typeof job.context.headSha === "string" ? job.context.headSha : null;
      if (job.stage === "verify" && head && /^[0-9a-f]{40}$/.test(head)) {
        const has = await exec("git", ["cat-file", "-e", `${head}^{commit}`], {
          cwd: clone,
          env: env(),
        });
        if (has.code === 0) return head;
      }
      return `origin/${job.repo.baseRef}`;
    },

    /** The config keys that could redirect a push or run code, for a before/after check. */
    async sensitiveConfig(worktree: string): Promise<string> {
      const result = await exec("git", ["config", "--list", "--show-scope"], {
        cwd: worktree,
        env: env(),
      });
      return result.stdout
        .split("\n")
        .filter((line) => {
          const [scope, entry] = line.split("\t");
          return (scope === "local" || scope === "worktree") && SENSITIVE.test(entry ?? "");
        })
        .sort()
        .join("\n");
    },

    async headSha(worktree: string): Promise<string> {
      return (await git(worktree, ["rev-parse", "HEAD"])).trim();
    },

    /** Uncommitted changes (the harness's private files are excluded). */
    async dirty(worktree: string): Promise<boolean> {
      return (await git(worktree, ["status", "--porcelain"])).trim().length > 0;
    },

    /** Commits whatever the session left uncommitted, so a build never loses work. */
    async commitLeftovers(worktree: string, message: string): Promise<boolean> {
      if (!(await this.dirty(worktree))) return false;
      await git(worktree, ["add", "-A"]);
      await git(worktree, ["commit", "--quiet", "--no-verify", "-m", message]);
      return true;
    },

    /**
     * Pushes HEAD to the run branch with the job token. Never forces, never pushes anything else.
     */
    async pushRunBranch(
      job: Job,
      worktree: string,
      token: { token: string; pushBranch: string },
    ): Promise<string> {
      assertPushable(job, token.pushBranch);
      const sha = await this.headSha(worktree);
      await git(
        worktree,
        [
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.file.allow=always",
          "push",
          "--quiet",
          "--no-verify",
          remoteUrl(job),
          `${sha}:refs/heads/${job.branch}`,
        ],
        token.token,
      );
      return sha;
    },

    /** Everything the session changed since `baseSha`: commits, edits and new files. */
    async diff(
      worktree: string,
      baseSha: string,
      branch: string,
      maxPatch = 450_000,
    ): Promise<Extract<Artifact, { kind: "diff" }>> {
      await git(worktree, ["add", "-A"]);
      const patch = await git(worktree, ["diff", "--cached", "--binary", baseSha]);
      const numstat = await git(worktree, ["diff", "--cached", "--numstat", baseSha]);
      let insertions = 0;
      let deletions = 0;
      let files = 0;
      for (const line of numstat.split("\n").filter(Boolean)) {
        const [added, removed] = line.split("\t");
        files++;
        insertions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
      return {
        kind: "diff",
        baseSha,
        headSha: await this.headSha(worktree),
        branch,
        patch:
          patch.length > maxPatch ? `${patch.slice(0, maxPatch)}\n… (patch truncated)\n` : patch,
        stats: { files, insertions, deletions },
      };
    },
  };

  async function excludePrivate(clone: string) {
    const path = join(clone, ".git", "info", "exclude");
    const current = await readFile(path, "utf8").catch(() => "");
    const lines = current.split("\n");
    const missing = PRIVATE_WORKTREE_FILES.filter((f) => !lines.includes(`/${f}`));
    if (missing.length === 0) return;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${current && !current.endsWith("\n") ? "\n" : ""}${missing.map((f) => `/${f}`).join("\n")}\n`,
    );
  }
}

export type HostGit = ReturnType<typeof hostGit>;

/** Revokes a job token (`DELETE /installation/token`). Best effort: it expires in an hour anyway. */
export async function revokeToken(token: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  if (token.startsWith("ghs_fake_")) return true;
  try {
    const response = await doFetch("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "software-factory-runner",
      },
    });
    return response.status === 204;
  } catch {
    return false;
  }
}
