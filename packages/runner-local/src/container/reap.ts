// After a host crash, and for `sf-runner doctor`: container jobs the host no longer runs. Their
// containers and networks carry the label `software-factory.job=<jobId>`; their dirs are
// `<containersDir>/sf-<jobId>`. Reaping removes them with the runtime and plain file operations,
// never git (a job repo left by a crashed run is unchecked). Nothing without the label, or outside
// the containers dir, is touched.
import { readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeRunDir } from "@software-factory/harness-claude";
import { isUnder } from "../checkouts.ts";
import { jobIdOfSession } from "../tmux.ts";
import type { ContainerRuntime } from "./runtime.ts";
import { JOB_LABEL, ROLE_LABEL } from "./spec.ts";

export interface ContainerHostDirs {
  containersDir: string;
  runsDir: string;
  runtime: ContainerRuntime;
}

export interface ContainerLeftovers {
  containers: Array<{ name: string; jobId: string }>;
  networks: Array<{ name: string; jobId: string }>;
  dirs: Array<{ path: string; jobId: string }>;
}

/** What container jobs left that `running` doesn't account for. */
export async function containerLeftovers(
  dirs: ContainerHostDirs,
  running: Set<string>,
): Promise<ContainerLeftovers> {
  const out: ContainerLeftovers = { containers: [], networks: [], dirs: [] };
  for (const c of await dirs.runtime.containers(JOB_LABEL)) {
    const jobId = c.labels[JOB_LABEL];
    if (jobId && !running.has(jobId)) out.containers.push({ name: c.name, jobId });
  }
  for (const n of await dirs.runtime.networks(JOB_LABEL)) {
    const jobId = n.labels[JOB_LABEL];
    if (jobId && !running.has(jobId)) out.networks.push({ name: n.name, jobId });
  }
  const root = await realpath(dirs.containersDir).catch(() => null);
  if (root) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const jobId = entry.isDirectory() ? jobIdOfSession(entry.name) : null;
      if (jobId && !running.has(jobId)) out.dirs.push({ path: join(root, entry.name), jobId });
    }
  }
  return out;
}

/** Removes container jobs' leftovers for jobs not in `running`. Returns the job ids. */
export async function reapContainers(
  dirs: ContainerHostDirs,
  running: Set<string>,
): Promise<string[]> {
  const found = await containerLeftovers(dirs, running);
  const reaped = new Set<string>();
  for (const c of found.containers) {
    await dirs.runtime.remove(c.name).catch(() => {});
    reaped.add(c.jobId);
  }
  for (const n of found.networks) {
    await dirs.runtime.removeNetwork(n.name).catch(() => {});
    reaped.add(n.jobId);
  }
  const root = await realpath(dirs.containersDir).catch(() => dirs.containersDir);
  for (const d of found.dirs) {
    if (!isUnder(d.path, root)) continue;
    await rm(d.path, { recursive: true, force: true }).catch(() => {});
    await rm(join(root, ".secrets", `${d.path.slice(root.length + 1)}.env`), { force: true });
    await removeRunDir(join(dirs.runsDir, d.jobId)).catch(() => {});
    reaped.add(d.jobId);
  }
  return [...reaped];
}

/** `doctor`'s findings: one line per leftover. All fixable by `reapContainers`. */
export async function diagnoseContainers(
  dirs: ContainerHostDirs,
  live: Set<string>,
): Promise<string[]> {
  const found = await containerLeftovers(dirs, live);
  return [
    ...found.containers.map((c) => `container ${c.name} has no running job`),
    ...found.networks.map((n) => `network ${n.name} has no running job`),
    ...found.dirs.map((d) => `job dir ${d.path} has no running job`),
  ];
}

/** A local check's network (./local-check.ts): labelled with the role, or (older) by its name. */
const CHECK_NETWORK = /^sf-chk-[0-9a-f]{12}-net$/;

/**
 * A `sandbox` runner's check containers (ADR 0501, fifth review): each local check runs in a
 * foreground `docker run --rm` beside an egress proxy on a network of its own, removed in a
 * `finally`. A runner that dies mid-check leaves all three. This removes every container carrying
 * the job label with role `check` or `egress`, and every check network, whose job is not in
 * `running`. At start-up `running` is empty: the runner that started them is gone, so all go.
 * Returns the job ids.
 */
export async function reapCheckContainers(
  runtime: ContainerRuntime,
  running: Set<string>,
): Promise<string[]> {
  const reaped = new Set<string>();
  for (const c of await runtime.containers(JOB_LABEL)) {
    const jobId = c.labels[JOB_LABEL];
    const role = c.labels[ROLE_LABEL];
    if (!jobId || running.has(jobId) || (role !== "check" && role !== "egress")) continue;
    await runtime.remove(c.name).catch(() => {});
    reaped.add(jobId);
  }
  for (const n of await runtime.networks(JOB_LABEL)) {
    const jobId = n.labels[JOB_LABEL];
    if (!jobId || running.has(jobId)) continue;
    if (n.labels[ROLE_LABEL] !== "check" && !CHECK_NETWORK.test(n.name)) continue;
    await runtime.removeNetwork(n.name).catch(() => {});
    reaped.add(jobId);
  }
  return [...reaped];
}
