// The project's checks for a container job (ADR 0501 on top of ADR 0430). The host runs each check
// through the adapter's `exec`; for a container job that is a fresh container from the agent's own
// image, user and limits, with no network at all, no model credential and no terminal. Never a
// process on the host: the project's code under test stays inside the isolation the agent had.
//
// It sees only the clean tree the host made of the commit under check (mounted at the agent's work
// path, so paths look the same), the job's pnpm store (content-addressed, checked on read) and a
// temporary HOME. Not the job repo, its git dir, the run dir or the agent's home: nothing the check
// runs can leave anything for the host's git or the next session (ADR 0501, amended 2026-11-12).
//
// The agent's container has stopped by then (its session ended), so this never shares it.
import type { ExecResult as CheckExecResult } from "@software-factory/runner-contract";
import type { Exec } from "../exec.ts";
import { type ContainerRuntime, type ContainerSpec, dockerRunArgs } from "./runtime.ts";
import { JOB_LABEL, ROLE_LABEL } from "./spec.ts";

/** The output a check keeps in memory (the host keeps only the tail). */
const OUTPUT_MAX = 256_000;

let seq = 0;

/** What a check container mounts: the clean tree and, when the job has one, its pnpm store. */
export interface CheckTree {
  /** The host's clean copy of the commit under check. */
  dir: string;
  pnpmStore?: string;
}

/** The spec a check runs in: the agent's image and limits, the clean tree, nothing else. */
export function checkSpec(
  agent: ContainerSpec,
  run: string,
  n: number,
  tree: CheckTree,
): ContainerSpec {
  const { envFile: _secret, networkAlias: _alias, detachKeys: _keys, ...rest } = agent;
  const env = Object.fromEntries(
    Object.entries(agent.env).filter(([k]) => !/^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY|HOME)$/i.test(k)),
  );
  return {
    ...rest,
    name: `${agent.name}-check-${n}`,
    entrypoint: "/bin/sh",
    command: ["-c", run],
    mounts: [
      { source: tree.dir, target: agent.workdir, readOnly: false },
      ...(tree.pnpmStore
        ? [{ source: tree.pnpmStore, target: tree.pnpmStore, readOnly: false }]
        : []),
    ],
    env: {
      ...env,
      // A HOME of its own on the container's tmpfs, never the agent's (its Claude state).
      HOME: "/tmp",
      ...(tree.pnpmStore ? { npm_config_store_dir: tree.pnpmStore } : {}),
      CI: "1",
      FORCE_COLOR: "0",
    },
    network: "none",
    labels: { ...agent.labels, [JOB_LABEL]: agent.labels[JOB_LABEL] ?? "", [ROLE_LABEL]: "check" },
    interactive: false,
  };
}

/**
 * Runs `run` in a check container and waits for it: `docker run --rm` in the foreground (no `-d`,
 * no TTY), killed and removed on a timeout or a cancel.
 */
export async function execInCheckContainer(
  runtime: ContainerRuntime,
  exec: Exec,
  agent: ContainerSpec,
  command: { run: string; timeoutMs: number; dir: string },
  signal: AbortSignal,
  pnpmStore?: string,
): Promise<CheckExecResult> {
  const spec = checkSpec(agent, command.run, ++seq, {
    dir: command.dir,
    ...(pnpmStore ? { pnpmStore } : {}),
  });
  const [bin = "docker"] = runtime.runArgv(spec);
  const args = dockerRunArgs(spec).filter((a) => a !== "-d");
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, command.timeoutMs);
  const onAbort = () => stop.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const r = await exec(bin, args, {
      // The CLI's own timeout is ours plus slack: the timer above decides.
      timeoutMs: command.timeoutMs + 30_000,
      signal: stop.signal,
    });
    const output = `${r.stdout}${r.stderr}`;
    return {
      exitCode: timedOut || stop.signal.aborted ? null : r.code,
      timedOut,
      output: output.length > OUTPUT_MAX ? output.slice(-OUTPUT_MAX) : output,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // `--rm` removes it when it exits; a killed CLI leaves it running.
    if (stop.signal.aborted) await runtime.remove(spec.name).catch(() => {});
  }
}
