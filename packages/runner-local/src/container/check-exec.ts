// The project's checks for a container job (ADR 0451 on top of ADR 0430). The host runs each check
// through the adapter's `exec`; for a container job that is a fresh container from the agent's own
// spec (the same image, user, mounts and limits, so it sees exactly the job repo the agent saw),
// with no network at all and no model credential. Never a process on the host: the project's code
// under test stays inside the isolation the agent had.
//
// The agent's container has stopped by then (its session ended), so this never shares it.
import type { ExecResult as CheckExecResult } from "@software-factory/runner-contract";
import type { Exec } from "../exec.ts";
import { type ContainerRuntime, type ContainerSpec, dockerRunArgs } from "./runtime.ts";
import { JOB_LABEL, ROLE_LABEL } from "./spec.ts";

/** The output a check keeps in memory (the host keeps only the tail). */
const OUTPUT_MAX = 256_000;

let seq = 0;

/** The spec a check runs in: the agent's, minus the network, the credential and the terminal. */
export function checkSpec(agent: ContainerSpec, run: string, n: number): ContainerSpec {
  const { envFile: _secret, networkAlias: _alias, detachKeys: _keys, ...rest } = agent;
  const env = Object.fromEntries(
    Object.entries(agent.env).filter(([k]) => !/^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY)$/i.test(k)),
  );
  return {
    ...rest,
    name: `${agent.name}-check-${n}`,
    entrypoint: "/bin/sh",
    command: ["-c", run],
    env: { ...env, CI: "1", FORCE_COLOR: "0" },
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
  command: { run: string; timeoutMs: number },
  signal: AbortSignal,
): Promise<CheckExecResult> {
  const spec = checkSpec(agent, command.run, ++seq);
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
