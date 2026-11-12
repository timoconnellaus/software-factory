// A local job's checks in a check container (ADR 0501, amended 2026-11-12, fourth review). On a Mac
// runner whose jobs run on the host (no container isolation), the project's checks still run in a
// fresh container when a container runtime is present (OrbStack, Docker Desktop): the OS sandbox on
// macOS can't stop a process a check leaves from outliving it, and can't give a check a loopback of
// its own (Seatbelt scopes loopback by host and port, not by process), so a test that starts a
// server could not reach it.
//
// It reuses the container job's check path (./check-exec.ts, `execInCheckContainer`): the same
// image, read-only root, every capability dropped, no new privileges, a pids limit, the clean tree
// mounted at its own path. What differs for a local job:
//   - a network of its own per check: an internal Docker network with no route out, and on it the
//     egress proxy (./egress.ts, the agent image's `egress-proxy.mjs`) with the job's allowlist
//     (`allowedDomains(profile)`, not the model API), so an install reaches the registry and nothing
//     else; the container's own loopback is private, so a server the check starts is reachable;
//   - its own pnpm store, the empty `<check dir>/store` beside its tree, mounted where it is;
//   - when the check's shell exits the container stops, and every process in it with it; the
//     container, the proxy and the network are removed after every check, however it ended.
// Nothing of the Mac's filesystem is visible but the check's own tree and store.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { allowedDomains } from "@software-factory/harness-claude";
import type { ExecResult as CheckExecResult, Job } from "@software-factory/runner-contract";
import { type Exec, nodeExec } from "../exec.ts";
import { execInCheckContainer } from "./check-exec.ts";
import { proxyEnv } from "./egress.ts";
import { ensureImage } from "./image.ts";
import { type ContainerRuntime, type ContainerSpec, dockerRuntime } from "./runtime.ts";
import { JOB_LABEL, PROXY_ALIAS, proxySpec, ROLE_LABEL } from "./spec.ts";

export interface LocalCheckOptions {
  /** The runtime (default: Docker over its CLI). */
  runtime?: ContainerRuntime;
  exec?: Exec;
  /** `uid:gid` the check runs as (default: this process's, so its files are the host user's). */
  user?: string;
  /** More egress hosts (tests: a local registry). */
  allowedHosts?: string[];
  /** Tests: `--add-host` entries for the proxy. */
  proxyAddHosts?: string[];
  /** Tests: the image to run (default: the agent image, built on first use). */
  image?: string;
  pidsLimit?: number;
  memory?: string;
  cpus?: number;
  log?: (message: string) => void;
}

/** Whether a container runtime answers here, or why not (for the mode and `sf-runner doctor`). */
export async function containerRuntimeProblem(
  runtime: ContainerRuntime = dockerRuntime(),
): Promise<string | null> {
  try {
    await runtime.version();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The check exec for a local job's checks: each command in a fresh check container. `root` is the
 * check's own dir (`<checksDir>/<job>-…/r<round>-<i>`), `dir` its tree.
 */
export function localCheckContainer(
  options: LocalCheckOptions = {},
): (
  job: Pick<Job, "jobId" | "harness">,
  dirs: { root: string; dir: string },
) => (
  command: { run: string; timeoutMs: number },
  signal: AbortSignal,
) => Promise<CheckExecResult> {
  const exec = options.exec ?? nodeExec;
  const runtime = options.runtime ?? dockerRuntime({ exec });
  const user =
    options.user ??
    (process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : "1000:1000");
  return (job, dirs) => async (command, signal) => {
    const image = options.image ?? (await ensureImage(runtime, { log: options.log })).id;
    const name = `sf-chk-${randomBytes(6).toString("hex")}`;
    const network = `${name}-net`;
    const proxyName = `${name}-egress`;
    const store = join(dirs.root, "store");
    await mkdir(store, { recursive: true, mode: 0o700 });
    const allow = [
      ...new Set(
        [...allowedDomains(job.harness.profile), ...(options.allowedHosts ?? [])].map((h) =>
          h.toLowerCase(),
        ),
      ),
    ];
    try {
      await runtime.createNetwork(network, {
        internal: true,
        labels: { [JOB_LABEL]: job.jobId },
      });
      await runtime.start(
        proxySpec({
          name: proxyName,
          image,
          jobId: job.jobId,
          allow,
          ...(options.proxyAddHosts ? { addHosts: options.proxyAddHosts } : {}),
        }),
      );
      await runtime.connect(network, proxyName, PROXY_ALIAS);
      const ready = Date.now() + 15_000;
      while (!/"listening"/.test(await runtime.logs(proxyName))) {
        if (Date.now() > ready || signal.aborted) {
          return {
            exitCode: null,
            timedOut: false,
            output: "",
            notRun: "the check container's egress proxy didn't start",
          };
        }
        await sleep(100);
      }
      const base: ContainerSpec = {
        name,
        image,
        user,
        workdir: dirs.dir,
        entrypoint: "/bin/sh",
        command: [],
        env: { ...proxyEnv(), LANG: "C.UTF-8" },
        mounts: [],
        tmpfs: { "/tmp": "rw,exec,nosuid,size=4g" },
        network,
        labels: { [JOB_LABEL]: job.jobId, [ROLE_LABEL]: "check" },
        pidsLimit: options.pidsLimit ?? 4096,
        ...(options.cpus ? { cpus: options.cpus } : {}),
        ...(options.memory ? { memory: options.memory } : {}),
        interactive: false,
      };
      return await execInCheckContainer(
        runtime,
        exec,
        base,
        { ...command, dir: dirs.dir },
        signal,
        undefined,
        { network, store },
      );
    } finally {
      // The check's container (the shell exited, or it was killed), its proxy and its network.
      for (const c of await runtime.containers(`${JOB_LABEL}=${job.jobId}`).catch(() => [])) {
        if (c.name.startsWith(name)) await runtime.remove(c.name).catch(() => {});
      }
      await runtime.remove(proxyName).catch(() => {});
      await runtime.removeNetwork(network).catch(() => {});
    }
  };
}
