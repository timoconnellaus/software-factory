// Git on the runner host (ADR 0033, 0035, 0052). The host, not the harness, talks to GitHub: it
// keeps one clone per repo, fetches the job's base with the job token, and after the session pushes
// the run branch, and only the run branch, with a fresh job token. Every git call it makes runs with
// no system or global config (so never the owner's keychain helper or `gh auth git-credential`),
// hooks off, and a credential helper that answers only github.com with the job token. The token is
// passed in the environment of that one git process, never in its arguments or on disk.
//
// The checkout is the one the adapter resolved (ADR 0260, amended by ADR 0380): usually the owner's
// own (found under the `checkouts` dirs), else the host's clone. In the owner's checkout the host only fetches, by explicit URL,
// into its own ref namespace (`refs/software-factory/…`): it never changes their remotes, config,
// FETCH_HEAD, branches or working tree, and never pushes from or checks out in it.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PRIVATE_WORKTREE_FILES } from "@software-factory/harness-claude";
import type { Artifact, Job } from "@software-factory/runner-contract";
import type { Exec } from "@software-factory/runner-local";

/**
 * The oldest git the host works with: the check export reads the tree with `--attr-source`
 * (`exportTree`), which git 2.40 added. On an older git every check export fails, so doctor checks it.
 */
export const MIN_GIT: [number, number] = [2, 40];

/** Whether `git --version` output (`git version 2.39.5 (Apple Git-154)`) is at least `min`. */
export function gitAtLeast(text: string, min: [number, number] = MIN_GIT): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(text);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

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

/** Where the host keeps the item branches it fetched, in any checkout. */
/** Git's empty tree: no `.gitattributes`, for an export with no filters. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export const FETCH_NAMESPACE = "refs/software-factory/heads";

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
     * Makes sure the job's base (the item branch) is in the checkout the job will run in, and
     * returns that checkout's path. `existing` is the checkout the adapter resolved for the repo
     * (ADR 0260): the host fetches into it and leaves everything else alone. Only when there is
     * none does the host clone, once, into `clonePath(job)`.
     */
    async ensureRepo(job: Job, token: string, existing?: string | null): Promise<string> {
      const url = remoteUrl(job);
      const path = existing ?? this.clonePath(job);
      return locked(path, async () => {
        if (!existing) {
          const isRepo = await exec("git", ["rev-parse", "--git-dir"], { cwd: path, env: env() })
            .then((r) => r.code === 0)
            .catch(() => false);
          if (!isRepo) {
            await mkdir(dirname(path), { recursive: true });
            await git(dirname(path), ["clone", "--no-checkout", "--quiet", url, path], token);
          }
          // The host's own clone: fetch from GitHub, never push through `origin`, no helpers.
          await git(path, ["config", "remote.origin.url", url]);
          await git(path, ["config", "remote.origin.pushurl", DISABLED_PUSH_URL]);
          await git(path, ["config", "--replace-all", "credential.helper", ""]);
          await excludePrivate(path);
        }
        // By URL, not through a remote: the token stays in this process's environment, the
        // checkout's remotes and config are untouched, and FETCH_HEAD isn't rewritten. Only https
        // (and file, for tests): a URL rewrite in the checkout's config can't send it over ssh.
        await git(
          path,
          [
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--quiet",
            "--no-write-fetch-head",
            "--no-tags",
            url,
            `+refs/heads/${job.repo.baseRef}:${FETCH_NAMESPACE}/${job.repo.baseRef}`,
            // The default branch too, so a build can merge it before the session (ADR 0320).
            ...(job.repo.defaultBranch && job.repo.defaultBranch !== job.repo.baseRef
              ? [
                  `+refs/heads/${job.repo.defaultBranch}:${FETCH_NAMESPACE}/${job.repo.defaultBranch}`,
                ]
              : []),
          ],
          token,
        );
        return path;
      });
    },

    /**
     * Where the job's worktree should start, as a SHA in `checkout`: the reviewed head for verify,
     * else the item branch as just fetched.
     */
    async startPoint(job: Job, checkout: string): Promise<string> {
      const head = typeof job.context.headSha === "string" ? job.context.headSha : null;
      if (job.stage === "verify" && head && /^[0-9a-f]{40}$/.test(head)) {
        const has = await exec("git", ["cat-file", "-e", `${head}^{commit}`], {
          cwd: checkout,
          env: env(),
        });
        if (has.code === 0) return head;
      }
      return (
        await git(checkout, [
          "rev-parse",
          "--verify",
          `${FETCH_NAMESPACE}/${job.repo.baseRef}^{commit}`,
        ])
      ).trim();
    },

    /**
     * Merges the default branch, as just fetched, into the job's worktree (ADR 0320), so the run's
     * PR stays mergeable while `main` moves. Merge commits only, never a rebase. A conflict is left
     * in progress (MERGE_HEAD and the conflict markers) for the build agent to resolve; the prompt
     * says so. `ahead`: whether the branch had commits of its own before the merge.
     */
    async mergeDefault(
      job: Job,
      worktree: string,
    ): Promise<
      | { status: "skipped" | "up-to-date"; ahead: boolean }
      | { status: "merged"; sha: string; ahead: boolean }
      | { status: "conflict"; files: string[]; ahead: boolean }
    > {
      const branch = job.repo.defaultBranch;
      if (!branch || branch === job.repo.baseRef) return { status: "skipped", ahead: true };
      const ref = `${FETCH_NAMESPACE}/${branch}`;
      const has = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: worktree,
        env: env(),
      });
      if (has.code !== 0) return { status: "skipped", ahead: true };
      const ahead =
        Number((await git(worktree, ["rev-list", "--count", `${ref}..HEAD`])).trim()) > 0;
      const contained = await exec("git", ["merge-base", "--is-ancestor", ref, "HEAD"], {
        cwd: worktree,
        env: env(),
      });
      if (contained.code === 0) return { status: "up-to-date", ahead };
      const merged = await exec(
        "git",
        [...base, "merge", "--no-ff", "--no-edit", "-m", `Merge ${branch} into ${job.branch}`, ref],
        { cwd: worktree, timeoutMs: 10 * 60_000, env: env() },
      );
      if (merged.code === 0) return { status: "merged", sha: await this.headSha(worktree), ahead };
      const files = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .filter(Boolean);
      if (files.length === 0) {
        // Not a content conflict (a dirty tree, an unrelated history): undo and say why.
        await exec("git", [...base, "merge", "--abort"], { cwd: worktree, env: env() });
        throw new GitError(`git merge ${branch} exited ${merged.code}: ${merged.stderr.trim()}`);
      }
      return { status: "conflict", files, ahead };
    },

    /** Paths still unmerged, and whether a merge is still in progress (MERGE_HEAD). */
    async mergeState(worktree: string): Promise<{ inProgress: boolean; unmerged: string[] }> {
      const head = await exec("git", ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
        cwd: worktree,
        env: env(),
      });
      const unmerged = (await git(worktree, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .filter(Boolean);
      return { inProgress: head.code === 0, unmerged };
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

    /**
     * Writes the tree of `sha` into `dest` (an empty directory) and nothing else: no ignored files
     * the session left (`node_modules`, `dist/`, caches), no git dir (ADR 0501). Through a
     * throwaway index, so the worktree's own index is untouched, and with `checkout-index` rather
     * than `git archive`, which would honour an `export-ignore` the agent wrote.
     *
     * No filter runs: the export is the host's own git, outside every sandbox, so a smudge filter in
     * the checkout's config (git-lfs, an owner's own) paired with a `.gitattributes` the agent wrote
     * would run the owner's command on the agent's content. Attributes come from the empty tree (no
     * in-tree `.gitattributes`), no attributes file, and every filter driver the config names is
     * blanked (an empty `smudge`/`process` is no filter), so the copy is the blobs as committed.
     */
    async exportTree(worktree: string, sha: string, dest: string, index: string): Promise<void> {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitError(`not a commit: ${sha}`);
      const indexEnv = { ...env(), GIT_INDEX_FILE: index, GIT_ATTR_NOSYSTEM: "1" };
      const listed = await exec("git", ["config", "--name-only", "--get-regexp", "^filter\\."], {
        cwd: worktree,
        env: env(),
      });
      const drivers = new Set(
        listed.stdout
          .split("\n")
          .map((k) => /^filter\.(.+)\.[^.]+$/.exec(k.trim())?.[1])
          .filter((d): d is string => !!d),
      );
      const noFilters = [
        `--attr-source=${EMPTY_TREE}`,
        "-c",
        "core.attributesFile=/dev/null",
        ...[...drivers].flatMap((d) => [
          "-c",
          `filter.${d}.smudge=`,
          "-c",
          `filter.${d}.process=`,
          "-c",
          `filter.${d}.required=false`,
        ]),
      ];
      for (const args of [
        ["read-tree", sha],
        ["checkout-index", "--all", "--force", `--prefix=${dest.replace(/\/?$/, "/")}`],
      ]) {
        const result = await exec("git", [...noFilters, ...base, ...args], {
          cwd: worktree,
          timeoutMs: 10 * 60_000,
          env: indexEnv,
        });
        if (result.code !== 0) {
          throw new GitError(`git ${args[0]} exited ${result.code}: ${result.stderr.trim()}`);
        }
      }
    },

    /** Commits whatever the session left uncommitted, so a build never loses work. */
    async commitLeftovers(worktree: string, message: string): Promise<boolean> {
      if (!(await this.dirty(worktree))) return false;
      await git(worktree, ["add", "-A"]);
      await git(worktree, ["commit", "--quiet", "--no-verify", "-m", message]);
      return true;
    },

    /**
     * Pushes HEAD (or `commit`) to the run branch with the job token. Never forces, never pushes
     * anything else.
     */
    async pushRunBranch(
      job: Job,
      worktree: string,
      token: { token: string; pushBranch: string },
      /** The commit to push (the last one the checks ran on, ADR 0501); default HEAD. */
      commit?: string,
    ): Promise<string> {
      assertPushable(job, token.pushBranch);
      if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) {
        throw new GitError(`not a commit: ${commit}`);
      }
      const sha = commit ?? (await this.headSha(worktree));
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
