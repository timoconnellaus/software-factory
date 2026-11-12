// The project's checks, run by the host itself (ADR 0501, spec 51). After a build session's turn
// ends, the host commits what it left and runs each declared check on that commit; a failure goes
// back into the same session with the exact command, exit code and log tail, and the session's fix
// is checked again, up to `fixRounds`. An attached PR's verify job runs them once, on the PR's head,
// before its reviewer session. The results ride on the hand-back; the cloud stores them against the
// SHA each ran on. The agent's own report of checks is never used.
//
// What makes the evidence worth something (ADR 0501, amended 2026-11-12):
//   - A clean tree. Every round runs on a fresh copy of exactly the commit (`exportTree`): nothing
//     the session left that git ignores (`node_modules`, `dist/`, caches) survives into it, and it
//     has no git dir. A project declares its install as a check of its own.
//   - Isolation. The command runs through the adapter's `exec` (a container job: a check container),
//     or under the host's OS sandbox with the harness's floor (./check-sandbox.ts). With neither,
//     nothing runs: each check is reported "not run", which fails, so a person decides.
//   - Guards. Before any host git that follows code the job ran (a fix round, a check), the git
//     config and the adapter's own git dir check are run again (`guard`); a finding fails the job.
//   - The checked head is the pushed head: the host never commits after the last round.
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CheckCommand,
  checkFailureMessage,
  checkPassed,
  type ExecResult,
  type ExecutedCheck,
  type Job,
  type JobChecks,
  logTail,
  NOT_RUN_NO_ISOLATION,
  redactSecrets,
  type SessionOutcome,
} from "@software-factory/runner-contract";

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
      result = { exitCode: null, timedOut: false, output: NOT_RUN_NO_ISOLATION };
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
    out.push({
      name: c.name,
      command: c.run,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      logTail: logTail(redactSecrets(result.output, secrets)),
      headSha,
      round,
    });
  }
  return out;
}

export interface CheckLoopOptions {
  checks: JobChecks;
  /**
   * The isolated exec for a clean tree at `dir`; null when this runner has none (every check is
   * then reported not run).
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
  if (!options.exec) notes.push(`the checks were not run: ${NOT_RUN_NO_ISOLATION.slice(9)}`);
  for (let round = 0; ; round++) {
    // The session (or a fix round) ran code in the worktree: guard before the host's git.
    await options.guard(round === 0 ? "after the session" : `after fix round ${round}`);
    const head = await options.commit();
    const dir = join(options.root, `tree-${round}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let ran: ExecutedCheck[];
    try {
      if (options.exec) await options.exportTree(head, dir);
      ran = await runChecks(
        checks.commands,
        options.exec ? options.exec(dir) : null,
        head,
        round,
        signal,
        options.secrets,
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    // The checks ran the project's code: guard again before anything else touches git.
    await options.guard(`after the checks of round ${round}`);
    results.push(...ran);
    const failed = ran.filter((c) => !checkPassed(c));
    const summary = `checks on ${head.slice(0, 7)}${round ? ` (fix round ${round})` : ""}: ${ran
      .map((c) => `${c.name} ${checkPassed(c) ? "passed" : options.exec ? "failed" : "not run"}`)
      .join(", ")}`;
    notes.push(summary);
    options.log?.(summary);
    const end = { results, final: ran, head, rounds: round, notes };
    if (failed.length === 0 || signal.aborted) return end;
    // Nothing a session can fix: a person decides.
    if (!options.exec) return end;
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

/** Whether a job carries checks for the host to run. */
export const hasChecks = (job: Job): job is Job & { checks: JobChecks } =>
  !!job.checks && job.checks.commands.length > 0;
