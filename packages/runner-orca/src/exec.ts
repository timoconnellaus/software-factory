// Running commands on the runner host. Injectable so adapters and the host can be tested without a
// shell.

import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
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
  },
) => Promise<ExecResult>;

export const nodeExec: Exec = (command, args, options = {}) =>
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
        resolve({ stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")), code });
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
