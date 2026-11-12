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
import { constants } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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
      // Streamed with a cap: a check that prints gigabytes keeps only its tail (ADR 0501).
      keepTail: OUTPUT_MAX,
    });
    const output = `${r.stdout}${r.stderr}`;
    return {
      exitCode: timedOut || stop.signal.aborted ? null : r.code,
      timedOut,
      output: output.length > OUTPUT_MAX ? output.slice(-OUTPUT_MAX) : output,
      isolation: "container",
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // `--rm` removes it when it exits; a killed CLI leaves it running.
    if (stop.signal.aborted) await runtime.remove(spec.name).catch(() => {});
  }
}
