// The project's checks for a container job (ADR 0501 on top of ADR 0430). The host runs each check
// through the adapter's `exec`; for a container job that is a fresh container from the agent's own
// image, user and limits, with no network at all, no model credential and no terminal. Never a
// process on the host: the project's code under test stays inside the isolation the agent had.
//
// It sees only the clean tree the host made of the commit under check (mounted at the agent's work
// path, so paths look the same), a copy of the job's pnpm store made for this check alone (mounted
// where the agent's store was, so an offline install finds it; never the agent's own store, which
// the check could otherwise rewrite for the next session or check: third review) and a temporary
// HOME. Not the job repo, its git dir, the run dir or the agent's home: nothing the check
// runs can leave anything for the host's git or the next session (ADR 0501, amended 2026-11-12).
//
// The agent's container has stopped by then (its session ended), so this never shares it.
//
// A check the kernel killed for memory is told apart (fifth review follow-up, re-review): only from
// outside the container, from the Docker daemon's own record (`docker inspect`'s State.OOMKilled, set
// when any process in the container's cgroup was OOM-killed, not only its main one). Never from
// anything inside the container: the check can print anything and read its own command line, so a
// line it could write is no evidence. A hit is a failed check (the code under check may be the
// cause), reported with the limit (`limit`): it goes to a person, never to a fix round. The pids
// limit and a full /tmp are only visible from inside the container (its cgroup is gone when it
// exits, and on Docker Desktop the host can't read it): those stay ordinary failures, whose log
// shows the `fork` or `No space left on device` error.
import { constants } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecResult as CheckExecResult } from "@software-factory/runner-contract";
import type { Exec } from "../exec.ts";
import { type ContainerRuntime, type ContainerSpec, dockerRunArgs } from "./runtime.ts";
import { JOB_LABEL, ROLE_LABEL } from "./spec.ts";

/** The output a check keeps in memory (the host keeps only the tail). */
const OUTPUT_MAX = 256_000;

/** Docker's size syntax (`4g`, `4096m`, `size=1g`) in bytes; null when it isn't one. */
export function dockerBytes(size: string | undefined): number | null {
  const m = /(?:^|size=)(\d+(?:\.\d+)?)([bkmg]?)b?(?:,|$)/i.exec(size ?? "");
  if (!m) return null;
  const unit = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    (m[2] ?? "").toLowerCase() as "" | "b" | "k" | "m" | "g"
  ];
  return Math.round(Number(m[1]) * unit);
}

/** Bytes as a person reads a limit: `4 GB`, `1.5 GB`, `512 MB`. */
export function limitText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * What a check the runner's memory limit stopped is reported as (ADR 0501, amended 2026-11-13):
 * a failure, said with the limit, that names the code under check as a possible cause.
 */
export function limitHitText(kind: string, limit: string): string {
  return `the check hit the runner's ${kind} limit (${limit}). The code under check may be the cause; raise the limit in the runner's config or fix the code`;
}

/**
 * Whether the runner's memory limit stopped a failed check, from the Docker daemon's record
 * (`docker inspect`, read by the host after the container exited), or null when it didn't.
 */
export function memoryLimitHit(
  spec: Pick<ContainerSpec, "memory">,
  inspected: { State?: { OOMKilled?: boolean } } | null,
): string | null {
  if (!inspected?.State?.OOMKilled) return null;
  const memory = dockerBytes(spec.memory);
  return limitHitText("memory", memory ? limitText(memory) : "its container's");
}

let seq = 0;

/** What a check container mounts: the clean tree and, when the job has one, its pnpm store. */
export interface CheckTree {
  /** The host's clean copy of the commit under check. */
  dir: string;
  /** Where the agent's pnpm store is (and where the check sees its copy). */
  pnpmStore?: string;
  /** The check's own copy of it (default: the store itself, for a caller with no copy). */
  pnpmStoreCopy?: string;
}

/**
 * The check's own copy of the job's pnpm store, beside its tree (`<check dir>/store`): symlinks as
 * they are, files cloned where the filesystem can. Null when the job has no store.
 */
export async function copyStoreForCheck(store: string, treeDir: string): Promise<string | null> {
  if (!(await stat(store).catch(() => null))?.isDirectory()) return null;
  const copy = join(dirname(treeDir), "store");
  await cp(store, copy, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  return copy;
}

/**
 * A local job's check (ADR 0501, fourth review): an internal network of its own whose only way out
 * is a proxy with the job's allowlist, and a pnpm store of its own already beside its tree.
 */
export interface CheckEgress {
  network: string;
  /** The check's own store (`<check dir>/store`), mounted where it is; never copied. */
  store?: string;
}

/** The spec a check runs in: the agent's image and limits, the clean tree, nothing else. */
export function checkSpec(
  agent: ContainerSpec,
  run: string,
  n: number,
  tree: CheckTree,
  egress?: CheckEgress,
): ContainerSpec {
  const { envFile: _secret, networkAlias: _alias, detachKeys: _keys, ...rest } = agent;
  // No network at all, unless the check has an egress proxy of its own (a local job's check).
  const env = Object.fromEntries(
    Object.entries(agent.env).filter(
      ([k]) => !(egress ? /^HOME$/i : /^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY|HOME)$/i).test(k),
    ),
  );
  return {
    ...rest,
    name: `${agent.name}-check-${n}`,
    entrypoint: "/bin/sh",
    command: ["-c", run],
    mounts: [
      { source: tree.dir, target: agent.workdir, readOnly: false },
      ...(tree.pnpmStore
        ? [
            {
              source: tree.pnpmStoreCopy ?? tree.pnpmStore,
              target: tree.pnpmStore,
              readOnly: false,
            },
          ]
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
    network: egress?.network ?? "none",
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
  egress?: CheckEgress,
): Promise<CheckExecResult> {
  const copy = egress?.store
    ? egress.store
    : pnpmStore
      ? await copyStoreForCheck(pnpmStore, command.dir)
      : null;
  const store = egress?.store ?? pnpmStore;
  const spec = checkSpec(
    agent,
    command.run,
    ++seq,
    {
      dir: command.dir,
      ...(store && copy ? { pnpmStore: store, pnpmStoreCopy: copy } : {}),
    },
    egress,
  );
  const [bin = "docker"] = runtime.runArgv(spec);
  // Not `--rm`: the container is inspected after it exits (OOMKilled), then removed below. The
  // check's command is run as it is: nothing wraps it, and nothing it prints is read as a limit.
  const args = dockerRunArgs(spec).filter((a) => a !== "-d" && a !== "--rm");
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
      // Streamed with a cap: a check that prints gigabytes keeps only its tail (ADR 0501).
      keepTail: OUTPUT_MAX,
    });
    const output = `${r.stdout}${r.stderr}`;
    const exitCode = timedOut || stop.signal.aborted ? null : r.code;
    const failed = exitCode !== 0 && !timedOut && !stop.signal.aborted;
    // From outside only: the daemon's record of the exited container, never the check's output.
    const limit = failed
      ? memoryLimitHit(spec, await runtime.inspect(spec.name).catch(() => null))
      : null;
    return {
      exitCode,
      timedOut,
      output: output.length > OUTPUT_MAX ? output.slice(-OUTPUT_MAX) : output,
      isolation: "container",
      ...(limit ? { limit } : {}),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // Run without `--rm` (to be inspected), and a killed CLI leaves it running: removed either way.
    await runtime.remove(spec.name).catch(() => {});
  }
}
