// The runner updates itself to the commit the factory was deployed from (ADR 0360, spec 08).
//
// The heartbeat answers with `desiredVersion`. When the runner's checkout is behind it, the runner
// checks it can move (auto-update on, a clean checkout on `main` or detached, the commit on
// `origin/main`, forward only), stops claiming until its jobs end, then fast-forwards to exactly
// that commit, reinstalls with the frozen lockfile and exits non-zero so launchd starts the new
// code. The first successful heartbeat on the new code confirms the update.
//
// Only the launchd service (`bin/sf-runner-service` sets SF_RUNNER_SERVICE=1) applies an update; a
// runner started in a terminal reports where it stands but leaves its checkout alone.
//
// The update record lives in `<stateDir>/update/`, one small file per field, so the `sh` wrapper
// `bin/sf-runner-service` can read and write it without jq. The wrapper rolls an update back after
// three starts that never confirmed it, and lists the commit in `<stateDir>/update-rolled-back`.
//   update/status      pending | confirmed | failed | rolled_back | superseded
//   update/from        the commit before the update
//   update/to          the commit updated to
//   update/mode        branch (on main, moved with `merge --ff-only`) | detached
//   update/starts      starts the wrapper counted without a confirmation (rollback after 3)
//   update/at          when the record was last written (ISO)
//   update/reason      why it failed or was rolled back
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunnerVersion } from "@software-factory/runner-contract";
import type { Exec } from "@software-factory/runner-local";

/** The exit code that asks launchd to start the runner on its new code (EX_TEMPFAIL). */
export const UPDATE_EXIT_CODE = 75;

export type UpdateState = RunnerVersion["update"]["state"];

export interface UpdateRecord {
  status: "pending" | "confirmed" | "failed" | "rolled_back" | "superseded";
  from: string;
  to: string;
  mode: "branch" | "detached";
  starts: number;
  at: string;
  reason: string | null;
}

/** What `sf-runner status` shows: the last report, written on every heartbeat. */
export interface VersionStatus {
  sha: string;
  autoUpdate: boolean;
  desired: string | null;
  state: UpdateState;
  target: string | null;
  reason: string | null;
  at: string;
  pid: number;
}

export type Check =
  | { kind: "current" }
  | { kind: "ready"; from: string; mode: "branch" | "detached" }
  | { kind: "blocked"; reason: string }
  | { kind: "rolled_back"; reason: string };

export const recordDir = (stateDir: string) => join(stateDir, "update");
export const rolledBackFile = (stateDir: string) => join(stateDir, "update-rolled-back");
export const versionStatusFile = (stateDir: string) => join(stateDir, "version.json");

const FIELDS = ["status", "from", "to", "mode", "starts", "at", "reason"] as const;

export async function readUpdateRecord(stateDir: string): Promise<UpdateRecord | null> {
  const dir = recordDir(stateDir);
  const field = (name: string) =>
    readFile(join(dir, name), "utf8").then(
      (s) => s.trim(),
      () => "",
    );
  const [status, from, to, mode, starts, at, reason] = await Promise.all(FIELDS.map(field));
  if (!status || !to) return null;
  return {
    status: status as UpdateRecord["status"],
    from: from ?? "",
    to: to ?? "",
    mode: mode === "detached" ? "detached" : "branch",
    starts: Number(starts) || 0,
    at: at ?? "",
    reason: reason || null,
  };
}

/** Writes every field, `status` last: the wrapper acts on `status` alone. */
export async function writeUpdateRecord(stateDir: string, record: UpdateRecord): Promise<void> {
  const dir = recordDir(stateDir);
  await mkdir(dir, { recursive: true });
  const put = async (name: string, value: string) => {
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    await writeFile(tmp, `${value}\n`);
    await rename(tmp, join(dir, name));
  };
  await put("from", record.from);
  await put("to", record.to);
  await put("mode", record.mode);
  await put("starts", String(record.starts));
  await put("at", record.at);
  if (record.reason) await put("reason", record.reason.replace(/\s+/g, " "));
  else await rm(join(dir, "reason"), { force: true });
  await put("status", record.status);
}

export async function readRolledBack(stateDir: string): Promise<string[]> {
  const text = await readFile(rolledBackFile(stateDir), "utf8").catch(() => "");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function readVersionStatus(stateDir: string): Promise<VersionStatus | null> {
  try {
    return JSON.parse(await readFile(versionStatusFile(stateDir), "utf8")) as VersionStatus;
  } catch {
    return null;
  }
}

export interface SelfUpdaterOptions {
  /** The runner's own checkout: the repo holding the running `cli.ts`. */
  repo: string;
  stateDir: string;
  autoUpdate: boolean;
  /**
   * Whether something restarts the runner after it exits: true under the launchd wrapper
   * (`SF_RUNNER_SERVICE=1`). A runner in a terminal reports its version but never updates itself.
   */
  canRestart?: boolean;
  exec: Exec;
  /** Production: `pnpm install --frozen-lockfile` in the repo root. Throws on failure. */
  installDeps: (repo: string) => Promise<void>;
  log?: (message: string) => void;
  now?: () => Date;
  /** At most one `git fetch` per this long while behind (default 60 s). */
  fetchEveryMs?: number;
  /** A failed (not rolled back) update to the same commit is retried after this long (default 1 h). */
  retryFailedAfterMs?: number;
}

/** What the host loop needs from the updater; it knows nothing about git. */
export interface SelfUpdate {
  /** The `version` field of the next heartbeat. */
  report(): RunnerVersion;
  /**
   * After each heartbeat: `claim` as usual, `drain` (claim nothing this turn, the update waits
   * for the running jobs) or `restart` (updated: stop and exit so launchd starts the new code).
   */
  consider(desired: string | null, idle: boolean): Promise<"claim" | "drain" | "restart">;
  /** The first successful heartbeat since start: an update that got this far worked. */
  confirm(): Promise<void>;
}

export interface SelfUpdater extends SelfUpdate {
  current(): Promise<string>;
  check(desired: string | null): Promise<Check>;
  /** Moves the checkout to `desired` and reinstalls; on failure moves back and returns why. */
  apply(desired: string, from: string, mode: "branch" | "detached"): Promise<string | null>;
}

const short = (sha: string) => sha.slice(0, 7);

/** The checkout a running `cli.ts` lives in, or null when it isn't a git checkout. */
export async function runnerRepo(exec: Exec, dir: string): Promise<string | null> {
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 20_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** `pnpm install --frozen-lockfile` in the repo root, with the service's PATH. */
export const pnpmInstall =
  (exec: Exec, pnpm = process.env.SF_RUNNER_PNPM ?? "pnpm") =>
  async (repo: string): Promise<void> => {
    const r = await exec(pnpm, ["install", "--frozen-lockfile"], {
      cwd: repo,
      timeoutMs: 15 * 60_000,
      env: { ...(process.env as Record<string, string>), CI: "1" },
    });
    if (r.code !== 0) {
      throw new Error(
        `pnpm install --frozen-lockfile exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-300)}`,
      );
    }
  };

export async function createSelfUpdater(options: SelfUpdaterOptions): Promise<SelfUpdater> {
  const { repo, stateDir, exec } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const fetchEveryMs = options.fetchEveryMs ?? 60_000;
  const retryFailedAfterMs = options.retryFailedAfterMs ?? 3_600_000;
  const gitEnv = { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" };
  const git = (...args: string[]) =>
    exec("git", args, { cwd: repo, timeoutMs: 120_000, env: gitEnv });
  const gitOk = async (...args: string[]) => {
    const r = await git(...args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };

  const current = () => gitOk("rev-parse", "HEAD");
  let sha = await current();
  let lastFetch = 0;
  let lastLogged = "";

  // Before the first `consider`: say what the last update did, if it was rolled back.
  const initial = await readUpdateRecord(stateDir);
  let state: RunnerVersion["update"] =
    initial?.status === "rolled_back"
      ? { state: "rolled_back", target: initial.to, reason: initial.reason }
      : { state: "current", target: null, reason: null };

  const moveTo = async (target: string, mode: "branch" | "detached") => {
    if (mode === "branch") await gitOk("merge", "--ff-only", "--quiet", target);
    else await gitOk("checkout", "--quiet", "--detach", target);
  };

  const check = async (desired: string | null): Promise<Check> => {
    sha = await current();
    if (!desired || desired === sha) return { kind: "current" };
    if (!options.autoUpdate) return { kind: "blocked", reason: "auto-update is off" };
    if ((await readRolledBack(stateDir)).includes(desired)) {
      const record = await readUpdateRecord(stateDir);
      return {
        kind: "rolled_back",
        reason:
          record?.to === desired && record.reason
            ? record.reason
            : `the update to ${short(desired)} was rolled back before; it won't be retried`,
      };
    }
    const record = await readUpdateRecord(stateDir);
    if (
      record?.status === "failed" &&
      record.to === desired &&
      now().getTime() - Date.parse(record.at) < retryFailedAfterMs
    ) {
      return { kind: "blocked", reason: record.reason ?? `the update to ${short(desired)} failed` };
    }
    const dirty = await gitOk("status", "--porcelain");
    if (dirty) return { kind: "blocked", reason: "the runner's checkout has local changes" };
    const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
    const mode = branch.code === 0 ? "branch" : "detached";
    if (mode === "branch" && branch.stdout.trim() !== "main") {
      return {
        kind: "blocked",
        reason: `the runner's checkout is on branch ${branch.stdout.trim()}, not main`,
      };
    }
    const onOrigin = async () =>
      (await git("merge-base", "--is-ancestor", desired, "refs/remotes/origin/main")).code === 0;
    if (!(await onOrigin())) {
      if (now().getTime() - lastFetch >= fetchEveryMs) {
        lastFetch = now().getTime();
        const fetched = await git(
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          "+refs/heads/main:refs/remotes/origin/main",
        );
        if (fetched.code !== 0) {
          return {
            kind: "blocked",
            reason: `can't fetch origin: ${fetched.stderr.trim().slice(0, 200)}`,
          };
        }
      }
      if (!(await onOrigin())) {
        return { kind: "blocked", reason: `${short(desired)} is not on origin/main` };
      }
    }
    if ((await git("merge-base", "--is-ancestor", sha, desired)).code !== 0) {
      const back = (await git("merge-base", "--is-ancestor", desired, sha)).code === 0;
      return {
        kind: "blocked",
        reason: back
          ? `updating to ${short(desired)} would go backwards from ${short(sha)}`
          : `${short(sha)} has commits that aren't in ${short(desired)}: not a fast-forward`,
      };
    }
    return { kind: "ready", from: sha, mode };
  };

  const apply = async (
    desired: string,
    from: string,
    mode: "branch" | "detached",
  ): Promise<string | null> => {
    const at = () => now().toISOString();
    // Recorded before the checkout moves, so the wrapper can always find the way back.
    await writeUpdateRecord(stateDir, {
      status: "pending",
      from,
      to: desired,
      mode,
      starts: 0,
      at: at(),
      reason: null,
    });
    try {
      await moveTo(desired, mode);
      const moved = await current();
      if (moved !== desired) throw new Error(`the checkout is at ${moved}, not ${desired}`);
      await options.installDeps(repo);
      sha = desired;
      return null;
    } catch (err) {
      const reason = `the update to ${short(desired)} failed: ${err instanceof Error ? err.message : String(err)}`;
      log(`${reason}; moving back to ${short(from)}`);
      try {
        if ((await current()) !== from) {
          if (mode === "branch") await gitOk("reset", "--quiet", "--keep", from);
          else await gitOk("checkout", "--quiet", "--detach", from);
        }
        await options.installDeps(repo);
      } catch (back) {
        log(`moving back failed: ${back instanceof Error ? back.message : back}`);
      }
      sha = await current().catch(() => sha);
      await writeUpdateRecord(stateDir, {
        status: "failed",
        from,
        to: desired,
        mode,
        starts: 0,
        at: at(),
        reason: reason.slice(0, 480),
      });
      return reason;
    }
  };

  const persist = async (desired: string | null) => {
    const body: VersionStatus = {
      sha,
      autoUpdate: options.autoUpdate,
      desired,
      ...state,
      at: now().toISOString(),
      pid: process.pid,
    };
    const file = versionStatusFile(stateDir);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body)}\n`);
    await rename(tmp, file);
  };

  const set = (next: RunnerVersion["update"]) => {
    state = { ...next, reason: next.reason ? next.reason.slice(0, 500) : null };
    const key = `${state.state}:${state.target}:${state.reason}`;
    if (key !== lastLogged && state.state !== "current") {
      log(
        `self-update ${state.state}${state.target ? ` → ${short(state.target)}` : ""}${state.reason ? `: ${state.reason}` : ""}`,
      );
    }
    lastLogged = key;
  };

  return {
    current,
    check,
    apply,
    report: () => ({ sha, autoUpdate: options.autoUpdate, update: state }),
    async consider(desired, idle) {
      let decision: "claim" | "drain" | "restart" = "claim";
      try {
        const c = await check(desired);
        if (c.kind === "current") {
          set({ state: "current", target: desired, reason: null });
        } else if (c.kind === "blocked") {
          set({ state: "blocked", target: desired, reason: c.reason });
        } else if (c.kind === "rolled_back") {
          set({ state: "rolled_back", target: desired, reason: c.reason });
        } else if (options.canRestart === false) {
          set({
            state: "blocked",
            target: desired,
            reason:
              "not running as the launchd service (sf-runner install), so nothing would restart it",
          });
        } else if (!idle) {
          set({ state: "waiting", target: desired, reason: "waiting for running jobs to finish" });
          decision = "drain";
        } else if (desired) {
          set({ state: "updating", target: desired, reason: null });
          log(`self-update: ${short(c.from)} → ${short(desired)}`);
          const failed = await apply(desired, c.from, c.mode);
          if (failed) set({ state: "blocked", target: desired, reason: failed });
          else decision = "restart";
        }
      } catch (err) {
        set({
          state: "blocked",
          target: desired,
          reason: `self-update check failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      await persist(desired).catch((err) => log(`version status file: ${err}`));
      return decision;
    },
    async confirm() {
      const record = await readUpdateRecord(stateDir);
      if (record?.status !== "pending") return;
      const head = await current();
      const confirmed = head === record.to;
      await writeUpdateRecord(stateDir, {
        ...record,
        status: confirmed ? "confirmed" : "superseded",
        at: now().toISOString(),
        reason: confirmed ? null : `the checkout is at ${short(head)}, not ${short(record.to)}`,
      });
      if (confirmed) log(`self-update to ${short(record.to)} confirmed`);
    },
  };
}
