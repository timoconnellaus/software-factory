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
// A check stopped by one of the container's limits is told apart from a failure in the code under
// check (fifth review follow-up): the memory limit (`docker inspect`'s OOMKilled, or the cgroup's
// `oom_kill` count), the pids limit (the cgroup's `pids.events` max) and a full /tmp tmpfs. Each is
// reported as the limit it hit (`limit`), which goes to a person, never to a fix round. The cgroup
// counts are read by a few lines of shell after the check's own shell exits, in the same container;
// the check could forge that line, which only sends its own failure to a person.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecResult as CheckExecResult } from "@software-factory/runner-contract";
import type { Exec } from "../exec.ts";
import { type ContainerRuntime, type ContainerSpec, dockerRunArgs } from "./runtime.ts";
import { JOB_LABEL, ROLE_LABEL } from "./spec.ts";

/** The output a check keeps in memory (the host keeps only the tail). */
const OUTPUT_MAX = 256_000;

/**
 * The check's shell, then one line on stderr with the container's cgroup counts and /tmp's free
 * space, then the check's own exit status. `$1` is the check's command, `$2` the line's marker.
 */
const LIMITS_WRAPPER = [
  '/bin/sh -c "$1"',
  "rc=$?",
  "p=$(cat /sys/fs/cgroup/pids.events 2>/dev/null | tr '\\n' ' ')",
  "m=$(cat /sys/fs/cgroup/memory.events 2>/dev/null | tr '\\n' ' ')",
  "d=$(df -Pk /tmp 2>/dev/null | tail -n 1)",
  `printf '\\n%s pids=[%s] mem=[%s] tmp=[%s]\\n' "$2" "$p" "$m" "$d" >&2`,
  "exit $rc",
].join("\n");

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

/** What the wrapper's line said, and the output without it. */
export function readLimitsLine(
  output: string,
  marker: string,
): {
  output: string;
  pidsMax: number;
  oomKills: number;
  tmp: { sizeKb: number; freeKb: number } | null;
} {
  let pidsMax = 0;
  let oomKills = 0;
  let tmp: { sizeKb: number; freeKb: number } | null = null;
  const line = new RegExp(
    `\\n?${marker} pids=\\[([^\\]]*)\\] mem=\\[([^\\]]*)\\] tmp=\\[([^\\]]*)\\]\\n?`,
  );
  const found = line.exec(output);
  if (!found) return { output, pidsMax, oomKills, tmp };
  pidsMax = Number(/(?:^|\s)max (\d+)/.exec(found[1] ?? "")?.[1] ?? 0);
  oomKills = Number(/(?:^|\s)oom_kill (\d+)/.exec(found[2] ?? "")?.[1] ?? 0);
  // df -Pk: filesystem, 1024-blocks, used, available, capacity, mounted on.
  const df = (found[3] ?? "").trim().split(/\s+/);
  const sizeKb = Number(df[1]);
  const freeKb = Number(df[3]);
  if (Number.isFinite(sizeKb) && Number.isFinite(freeKb) && sizeKb > 0) tmp = { sizeKb, freeKb };
  return {
    output: output.slice(0, found.index) + output.slice(found.index + found[0].length),
    pidsMax,
    oomKills,
    tmp,
  };
}

/**
 * Which of the container's limits stopped a failed check, said with the limit, or null when none
 * did (a failure of the code under check, for a fix round).
 */
export function limitHit(
  spec: Pick<ContainerSpec, "memory" | "pidsLimit" | "tmpfs">,
  seen: {
    oomKilled: boolean;
    oomKills: number;
    pidsMax: number;
    tmp: { sizeKb: number; freeKb: number } | null;
  },
): string | null {
  if (seen.oomKilled || seen.oomKills > 0) {
    const memory = dockerBytes(spec.memory);
    return `the check ran out of memory${memory ? ` (limit ${limitText(memory)})` : ""}`;
  }
  if (seen.pidsMax > 0) {
    return `the check ran out of processes (limit ${spec.pidsLimit} processes)`;
  }
  // Full: under 1% (or 1 MB) of /tmp left when the check's shell ended.
  if (seen.tmp && seen.tmp.freeKb <= Math.max(1024, seen.tmp.sizeKb / 100)) {
    return `the check filled its /tmp (limit ${limitText(seen.tmp.sizeKb * 1024)})`;
  }
  return null;
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
  // The check's shell inside the wrapper that reports which limit stopped it (see the top).
  const marker = `SF-LIMITS-${randomBytes(8).toString("hex")}`;
  const wrapped: ContainerSpec = {
    ...spec,
    command: ["-c", LIMITS_WRAPPER, "sf-check", command.run, marker],
  };
  const [bin = "docker"] = runtime.runArgv(wrapped);
  // Not `--rm`: the container is inspected after it exits (OOMKilled), then removed below.
  const args = dockerRunArgs(wrapped).filter((a) => a !== "-d" && a !== "--rm");
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
    const seen = readLimitsLine(`${r.stdout}${r.stderr}`, marker);
    const output = seen.output;
    const exitCode = timedOut || stop.signal.aborted ? null : r.code;
    const failed = exitCode !== 0 && !timedOut && !stop.signal.aborted;
    const oomKilled = failed
      ? !!(await runtime.inspect(spec.name).catch(() => null))?.State?.OOMKilled
      : false;
    const limit = failed ? limitHit(spec, { ...seen, oomKilled }) : null;
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
