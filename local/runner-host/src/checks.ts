// The project's checks, run by the host itself (ADR 0501, spec 51). After a build session's turn
// ends, the host commits what it left and runs each declared check in the job's worktree, on that
// commit. A failure goes back into the same session with the exact command, exit code and log tail,
// and the session's fix is checked again, up to `fixRounds`. The results ride on the hand-back; the
// cloud stores them against the SHA each ran on. The agent's own report of checks is never used.
//
// Commands go through the adapter's `exec` (a containerised job runs them in its container). Only
// an adapter without one gets a local process in the worktree.
import { spawn } from "node:child_process";
import {
  type CheckCommand,
  checkFailureMessage,
  checkPassed,
  type ExecResult,
  type ExecutedCheck,
  type Job,
  type JobChecks,
  logTail,
  type SessionOutcome,
} from "@software-factory/runner-contract";

/** Runs one command where the job runs. */
export type Exec = (
  command: { run: string; timeoutMs: number },
  signal: AbortSignal,
) => Promise<ExecResult>;

/**
 * The environment a local check runs with: enough to find the toolchain, none of the owner's
 * tokens or cloud credentials (ADR 0010, 0033). Containerised runners isolate further via `exec`.
 */
export function checkEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TERM",
    "NVM_DIR",
    "PNPM_HOME",
    "COREPACK_HOME",
  ];
  const out: NodeJS.ProcessEnv = {};
  for (const k of keep) if (from[k] !== undefined) out[k] = from[k];
  return out;
}

/** How much output a local check keeps while it runs (the tail is cut again for the report). */
const OUTPUT_KEEP = 64_000;

/**
 * The fallback for an adapter without `exec`: `/bin/sh -c` in the worktree, its own process group
 * so a timeout or cancel kills everything it started.
 */
export function localExec(cwd: string, env: NodeJS.ProcessEnv = process.env): Exec {
  return (command, signal) =>
    new Promise((resolve) => {
      let output = "";
      let timedOut = false;
      const child = spawn("/bin/sh", ["-c", command.run], {
        cwd,
        env: { ...env, CI: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const keep = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > OUTPUT_KEEP * 2) output = output.slice(-OUTPUT_KEEP);
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, command.timeoutMs);
      const onAbort = () => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (exitCode: number | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve({ exitCode: timedOut ? null : exitCode, timedOut, output });
      };
      child.on("error", (err) => {
        output += `\n${err.message}`;
        done(127);
      });
      child.on("close", (code) => done(code));
    });
}

/** Runs every check once, in order, on the worktree as it is at `headSha`. */
export async function runChecks(
  commands: readonly CheckCommand[],
  exec: Exec,
  headSha: string,
  round: number,
  signal: AbortSignal,
): Promise<ExecutedCheck[]> {
  const out: ExecutedCheck[] = [];
  for (const c of commands) {
    if (signal.aborted) break;
    const started = Date.now();
    let result: ExecResult;
    try {
      result = await exec({ run: c.run, timeoutMs: c.timeoutMs }, signal);
    } catch (err) {
      result = {
        exitCode: null,
        timedOut: false,
        output: `the runner couldn't run it: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    out.push({
      name: c.name,
      command: c.run,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      logTail: logTail(result.output),
      headSha,
      round,
    });
  }
  return out;
}

export interface CheckLoopOptions {
  checks: JobChecks;
  exec: Exec;
  /** Commits what the session left and returns the head the checks run on. */
  commit: () => Promise<string>;
  /**
   * Types a message into the same session and waits for that turn to end. Absent when the adapter
   * can't continue a session (no `steer`): a failure is then reported at once.
   */
  continueSession?: ((text: string) => Promise<SessionOutcome>) | undefined;
  signal: AbortSignal;
  log?: (message: string) => void;
}

export interface CheckLoopResult {
  /** Every result from every round, each on its own SHA (the cloud keeps the latest per SHA). */
  results: ExecutedCheck[];
  /** The last round's results: what the head that is handed back looks like. */
  final: ExecutedCheck[];
  rounds: number;
  /** Lines for the run's summary. */
  notes: string[];
}

/** Checks, and while any fail and rounds remain, the failure back into the same session. */
export async function checkLoop(options: CheckLoopOptions): Promise<CheckLoopResult> {
  const { checks, exec, signal } = options;
  const results: ExecutedCheck[] = [];
  const notes: string[] = [];
  for (let round = 0; ; round++) {
    const head = await options.commit();
    const ran = await runChecks(checks.commands, exec, head, round, signal);
    results.push(...ran);
    const failed = ran.filter((c) => !checkPassed(c));
    const summary = `checks on ${head.slice(0, 7)}${round ? ` (fix round ${round})` : ""}: ${ran
      .map((c) => `${c.name} ${checkPassed(c) ? "passed" : "failed"}`)
      .join(", ")}`;
    notes.push(summary);
    options.log?.(summary);
    if (failed.length === 0 || signal.aborted) return { results, final: ran, rounds: round, notes };
    if (round >= checks.fixRounds) {
      notes.push(`the checks still fail after ${round} fix round(s): a person decides`);
      return { results, final: ran, rounds: round, notes };
    }
    if (!options.continueSession) {
      notes.push("the session can't be continued on this runner, so the failure goes to a person");
      return { results, final: ran, rounds: round, notes };
    }
    const outcome = await options.continueSession(checkFailureMessage(failed, round + 1));
    if (outcome !== "completed") {
      notes.push(`the session's fix round ${round + 1} ended ${outcome}`);
      return { results, final: ran, rounds: round, notes };
    }
  }
}

/** Whether a job carries checks for the host to run. */
export const hasChecks = (job: Job): job is Job & { checks: JobChecks } =>
  !!job.checks && job.checks.commands.length > 0;
