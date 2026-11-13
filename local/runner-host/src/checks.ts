// The project's checks, run by the host itself (ADR 0501, spec 51). After a build session's turn
// ends, the host commits what it left and runs each declared check on that commit; a failure goes
// back into the same session with the exact command, exit code and log tail, and the session's fix
// is checked again, up to `fixRounds`. An attached PR's verify job runs them once, on the PR's head,
// before its reviewer session. The results ride on the hand-back; the cloud stores them against the
// SHA each ran on. The agent's own report of checks is never used.
//
// What makes the evidence worth something (ADR 0501, amended 2026-11-12):
//   - A clean tree. Every round starts from a fresh copy of exactly the commit (`exportTree`):
//     nothing the session left that git ignores (`node_modules`, `dist/`, caches) survives into it,
//     and it has no git dir. A project declares its install as a check of its own, first.
//   - A dir of its own per check (third review). Each check runs in `<root>/r<round>-<i>/tree`,
//     with its own HOME, temp and pnpm store beside it. The first check of a round gets the export;
//     each later one gets a copy of the tree the check before it left (its install), made only
//     after that check ended and everything it started was killed. A process an earlier check left
//     behind can write only that check's dir, never the one the next check runs in.
//   - Isolation. The command runs through the adapter's `exec` (a container job: a check container),
//     or under the host's OS sandbox with the harness's floor (./check-sandbox.ts). With neither,
//     nothing runs: each check is reported "not run", which fails, so a person decides.
//   - Guards. Before any host git that follows code the job ran (a fix round, a check), the git
//     config and the adapter's own git dir check are run again (`guard`); a finding fails the job.
//   - The checked head is the pushed head: the host never commits after the last round.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type CapabilityManifest,
  type CheckCommand,
  checkFailureMessage,
  checkPassed,
  type ExecResult,
  type ExecutedCheck,
  type Job,
  type JobChecks,
  logTail,
  NO_ISOLATION,
  redactSecrets,
  type SessionOutcome,
} from "@software-factory/runner-contract";

const execFileP = promisify(execFile);

/** Runs one command in the clean tree of the commit under check. */
export type Exec = (
  command: { run: string; timeoutMs: number },
  signal: AbortSignal,
) => Promise<ExecResult>;

/** The git guards found something: the job fails and nothing is pushed. */
export class GuardTripped extends Error {}

/** Runs every check once, in order, on the clean tree of `headSha`; `exec` null: none is run. */
export async function runChecks(
  commands: readonly CheckCommand[],
  exec: Exec | null,
  headSha: string,
  round: number,
  signal: AbortSignal,
  secrets: readonly string[] = [],
): Promise<ExecutedCheck[]> {
  const out: ExecutedCheck[] = [];
  for (const c of commands) {
    if (signal.aborted) break;
    const started = Date.now();
    let result: ExecResult;
    if (!exec) {
      result = { exitCode: null, timedOut: false, output: "", notRun: NO_ISOLATION };
    } else {
      try {
        result = await exec({ run: c.run, timeoutMs: c.timeoutMs }, signal);
      } catch (err) {
        result = {
          exitCode: null,
          timedOut: false,
          output: `the runner couldn't run it: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const notRun = result.notRun?.slice(0, 300);
    // A runner limit it hit (memory, disk), as the host saw it from outside: a failure like any
    // other, with the limit said after the check's own output (so the tail always keeps it).
    const limit = notRun ? undefined : result.limit?.slice(0, 300);
    out.push({
      name: c.name,
      command: c.run,
      exitCode: notRun ? null : result.exitCode,
      timedOut: notRun ? false : result.timedOut,
      durationMs: Date.now() - started,
      logTail: logTail(
        redactSecrets(
          notRun
            ? `not run: ${notRun}\n${result.output}`.trim()
            : limit
              ? `${result.output.trimEnd()}\n${limit}`.trim()
              : result.output,
          secrets,
        ),
      ),
      headSha,
      round,
      ...(notRun ? { notRun } : result.isolation ? { isolation: result.isolation } : {}),
      ...(limit ? { limit } : {}),
    });
  }
  return out;
}

export interface CheckLoopOptions {
  checks: JobChecks;
  /**
   * The isolated exec for one check's tree at `dir` (`<root>/r<round>-<i>/tree`, the check's own
   * dir being its parent); null when this runner has none (every check is then reported not run).
   */
  exec: ((dir: string) => Exec) | null;
  /** Commits what the session left (a build) and returns the head the checks run on. */
  commit: () => Promise<string>;
  /** Writes the tree of `sha` into the empty directory `dir`. */
  exportTree: (sha: string, dir: string) => Promise<void>;
  /** The job's checks root (outside the worktree; removed by the caller). */
  root: string;
  /** Throws GuardTripped when the job's git config or git dir was tampered with. */
  guard: (when: string) => Promise<void>;
  /**
   * Types a message into the same session and waits for that turn to end. Absent when the adapter
   * can't continue a session: a failure is then reported at once.
   */
  continueSession?: ((text: string) => Promise<SessionOutcome>) | undefined;
  /** The job's own secrets (its tokens), taken out of every log tail. */
  secrets?: readonly string[];
  signal: AbortSignal;
  log?: (message: string) => void;
  /**
   * The disk bound for a tree carried to the next check (fifth review; runner.json
   * `checks.maxTreeGb`): a tree that grew past it is not copied, and the next check is not run.
   */
  maxTreeBytes?: number;
  /** A tree's size on disk (default `du -sk`; tests inject it). */
  treeBytes?: (dir: string) => Promise<number>;
  /** How often a running check's dir is measured against `maxTreeBytes` (default 15 s). */
  treeWatchMs?: number;
}

export interface CheckLoopResult {
  /** Every result from every round, each on its own SHA (the cloud keeps the latest per SHA). */
  results: ExecutedCheck[];
  /** The last round's results: what the head that is handed back looks like. */
  final: ExecutedCheck[];
  /** The commit the last round ran on: the host pushes exactly this, or nothing. */
  head: string;
  rounds: number;
  /** Lines for the run's summary. */
  notes: string[];
}

/** Checks, and while any fail and rounds remain, the failure back into the same session. */
export async function checkLoop(options: CheckLoopOptions): Promise<CheckLoopResult> {
  const { checks, signal } = options;
  const results: ExecutedCheck[] = [];
  const notes: string[] = [];
  if (!options.exec) notes.push(`the checks were not run: ${NO_ISOLATION}`);
  for (let round = 0; ; round++) {
    // The session (or a fix round) ran code in the worktree: guard before the host's git.
    await options.guard(round === 0 ? "after the session" : `after fix round ${round}`);
    const head = await options.commit();
    const ran: ExecutedCheck[] = [];
    /** The dir of the check before this one, removed once the next has its copy. */
    let prev: string | undefined;
    try {
      for (const [i, c] of checks.commands.entries()) {
        if (signal.aborted) break;
        const at = join(options.root, `r${round}-${i}`);
        const tree = join(at, "tree");
        await rm(at, { recursive: true, force: true });
        await mkdir(tree, { recursive: true, mode: 0o700 });
        let prepared: string | null = null;
        let tooBig: string | null = null;
        if (options.exec) {
          try {
            // The first check gets the commit; each later one, a copy of what the one before left
            // (made now: that check has ended and everything it started was killed), unless it
            // grew past the runner's disk bound.
            if (prev === undefined) await options.exportTree(head, tree);
            else {
              const bound = options.maxTreeBytes;
              const size = bound ? await (options.treeBytes ?? duBytes)(join(prev, "tree")) : 0;
              if (bound && size > bound) {
                tooBig = `the tree the check before left is ${gb(size)} GB, over this runner's bound of ${gb(bound)} GB (runner.json checks.maxTreeGb)`;
                prepared = tooBig;
              } else await carryTree(join(prev, "tree"), tree);
            }
          } catch (err) {
            prepared = err instanceof Error ? err.message : String(err);
          }
        }
        if (prev !== undefined) await rm(prev, { recursive: true, force: true }).catch(() => {});
        prev = at;
        // The export of the commit itself failed: the host's own problem, as before.
        if (prepared !== null && i === 0) throw new Error(prepared);
        ran.push(
          ...(prepared !== null
            ? [
                {
                  name: c.name,
                  command: c.run,
                  exitCode: null,
                  timedOut: false,
                  durationMs: 0,
                  logTail: logTail(
                    redactSecrets(
                      tooBig
                        ? `not run: ${tooBig}`
                        : `the runner couldn't copy the tree the check before left: ${prepared}`,
                      options.secrets,
                    ),
                  ),
                  headSha: head,
                  round,
                  // Over the disk bound: nothing a fix round can win, so a person decides.
                  ...(tooBig ? { notRun: tooBig.slice(0, 300) } : {}),
                },
              ]
            : await runChecks(
                [c],
                options.exec
                  ? boundWhileRunning(options.exec(tree), at, options.maxTreeBytes, {
                      size: options.treeBytes ?? duBytes,
                      everyMs: options.treeWatchMs ?? TREE_WATCH_MS,
                    })
                  : null,
                head,
                round,
                signal,
                options.secrets,
              )),
        );
      }
    } finally {
      if (prev !== undefined) await rm(prev, { recursive: true, force: true }).catch(() => {});
    }
    // The checks ran the project's code: guard again before anything else touches git.
    await options.guard(`after the checks of round ${round}`);
    results.push(...ran);
    const failed = ran.filter((c) => !checkPassed(c));
    const summary = `checks on ${head.slice(0, 7)}${round ? ` (fix round ${round})` : ""}: ${ran
      .map(
        (c) =>
          `${c.name} ${checkPassed(c) ? "passed" : c.notRun ? "not run" : c.limit ? `failed: ${c.limit}` : "failed"}`,
      )
      .join(", ")}`;
    notes.push(summary);
    options.log?.(summary);
    const end = { results, final: ran, head, rounds: round, notes };
    if (failed.length === 0 || signal.aborted) return end;
    // Nothing a session can fix: a check that was not run (no isolation here, no container, a
    // sandbox that couldn't start) goes to a person, never to a fix round it can't win.
    if (failed.some((c) => c.notRun)) {
      notes.push("a check was not run on this runner: a person decides");
      return end;
    }
    // A check that failed on a runner limit (seen from outside it: never from its output) failed,
    // and the code under check may be why; but a fix round can't raise the limit, so a person
    // decides: raise it in the runner's config, or have the code fixed.
    if (failed.some((c) => c.limit)) {
      notes.push("a check failed on a runner limit: a person decides, not a fix round");
      return end;
    }
    if (round >= checks.fixRounds) {
      notes.push(`the checks still fail after ${round} fix round(s): a person decides`);
      return end;
    }
    if (!options.continueSession) {
      notes.push("the session can't be continued on this runner, so the failure goes to a person");
      return end;
    }
    const outcome = await options.continueSession(checkFailureMessage(failed, round + 1));
    if (outcome !== "completed") {
      // The fix round may have left the worktree changed: guard it before the host's git, and
      // hand back the last round's head (nothing after it is pushed).
      await options.guard(`after fix round ${round + 1}`);
      notes.push(`the session's fix round ${round + 1} ended ${outcome}`);
      return end;
    }
  }
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** How often a running check's dir is measured against the disk bound. */
export const TREE_WATCH_MS = 15_000;

/**
 * The disk bound while a check runs (fifth review follow-up): its dir (tree, home, temp, store) is
 * measured every `everyMs` by the host, and a check whose dir grows past `bound` is stopped and
 * reported failed on that limit, so a person decides, never a fix round. Without it a check could fill the
 * runner's disk before the bound was measured on the copy to the next check. No bound: as is.
 */
export function boundWhileRunning(
  exec: Exec,
  dir: string,
  bound: number | undefined,
  watch: { size: (dir: string) => Promise<number>; everyMs: number },
): Exec {
  if (!bound) return exec;
  return async (command, signal) => {
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let over: number | null = null;
    let measuring = false;
    const timer = setInterval(() => {
      if (measuring || over !== null) return;
      measuring = true;
      void watch
        .size(dir)
        .then((bytes) => {
          if (bytes > bound && over === null) {
            over = bytes;
            stop.abort();
          }
        })
        .catch(() => {})
        .finally(() => {
          measuring = false;
        });
    }, watch.everyMs);
    try {
      const r = await exec(command, stop.signal);
      if (over === null) return r;
      return {
        ...r,
        exitCode: null,
        timedOut: false,
        limit: `the check hit the runner's disk limit (${gb(bound)} GB, runner.json checks.maxTreeGb; its files reached ${gb(over)} GB). The code under check may be the cause; raise the limit in the runner's config or fix the code`,
      };
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * A tree's size on disk, from `du -sk` (symlinks not followed). A file that went away mid-walk, or
 * one it can't read, makes `du` exit 1 with the total still printed: that total counts.
 */
export async function duBytes(dir: string): Promise<number> {
  const stdout = await execFileP("du", ["-sk", dir], { maxBuffer: 1024 * 1024 }).then(
    (r) => r.stdout,
    (err: { stdout?: string }) => {
      if (!err.stdout) throw err;
      return err.stdout;
    },
  );
  const kb = Number.parseInt(stdout.trim().split("\n").at(-1) ?? "", 10);
  if (!Number.isFinite(kb)) throw new Error(`du gave no size for ${dir}`);
  return kb * 1024;
}

/**
 * Copies a check's tree to the next check's (`dest`, empty): symlinks as they are (never followed,
 * so nothing outside the tree is read), files cloned where the filesystem can (APFS, btrfs, XFS).
 * A FIFO or socket the check left makes the copy fail, and the next check with it.
 */
export async function carryTree(src: string, dest: string): Promise<void> {
  if (!(await stat(src).catch(() => null))?.isDirectory()) return;
  await cp(src, dest, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

/**
 * The adapter's manifest with what this host adds itself: `checks` (ADR 0501), since the host, not
 * the adapter, runs them, when `declare` (fifth review): every `sandbox` runner and every runner
 * whose adapter has its own exec, whether or not a check can run right now (one that can't comes
 * back not run with the reason, and the gate asks a person). A runner whose jobs live elsewhere (a
 * sprite runner) never declares it. `note` is the one line on where checks run here, or why not.
 */
export function hostManifest(
  manifest: CapabilityManifest,
  declare = true,
  note?: string,
): CapabilityManifest {
  const without = manifest.capabilities.filter((c) => c !== "checks" && c !== "babysit");
  // `babysit` (spec 53, ADR 0620): this host's job runner handles the stage, whatever the adapter.
  return {
    ...manifest,
    capabilities: declare ? [...without, "checks", "babysit"] : [...without, "babysit"],
    ...(note ? { checksNote: note.slice(0, 300) } : {}),
  };
}

/** Whether a job carries checks for the host to run. */
export const hasChecks = (job: Job): job is Job & { checks: JobChecks } =>
  !!job.checks && job.checks.commands.length > 0;
