// Running commands on the runner host. Injectable so the adapter and the host can be tested without a
// shell.

import { execFile, spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** The command was killed for running past its timeout (its exit code says nothing). */
  timedOut?: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The child's whole environment (default: the host's). */
    env?: Record<string, string>;
    /**
     * Stream the output and keep only about the last this-many characters of each stream, however
     * much the command prints (a project's check, ADR 0501), rather than buffering it all.
     */
    keepTail?: number;
  },
) => Promise<ExecResult>;

/** `nodeExec` with `keepTail`: streamed, only the tail of each stream kept. */
function execTail(
  command: string,
  args: string[],
  options: NonNullable<Parameters<Exec>[2]> & { keepTail: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 120_000,
      killSignal: "SIGKILL",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const keep = options.keepTail;
    const out = { stdout: "", stderr: "" };
    for (const name of ["stdout", "stderr"] as const) {
      child[name].on("data", (chunk: Buffer) => {
        out[name] += chunk.toString("utf8");
        if (out[name].length > keep * 2) out[name] = out[name].slice(-keep);
      });
    }
    let failed: string | undefined;
    child.on("error", (err) => {
      failed = err.message;
    });
    child.on("close", (code, signal) => {
      const killed = code === null && signal === "SIGKILL";
      resolve({
        stdout: out.stdout.slice(-keep),
        stderr: `${out.stderr.slice(-keep)}${failed && code === null ? failed : ""}`,
        code: code ?? 1,
        ...(killed && !options.signal?.aborted ? { timedOut: true } : {}),
      });
    });
  });
}

export const nodeExec: Exec = (command, args, options = {}) =>
  options.keepTail
    ? execTail(command, args, { ...options, keepTail: options.keepTail })
    : execBuffered(command, args, options);

const execBuffered: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        const killed = !!error && (error as { killed?: boolean }).killed === true;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr || (error?.message ?? "")),
          code,
          ...(killed && !options.signal?.aborted ? { timedOut: true } : {}),
        });
      },
    );
  });

/** Runs and throws on a non-zero exit. */
export async function run(
  exec: Exec,
  command: string,
  args: string[],
  options?: Parameters<Exec>[2],
): Promise<string> {
  const result = await exec(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
