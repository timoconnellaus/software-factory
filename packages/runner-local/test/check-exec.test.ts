// The project's checks for a container job run in a fresh container, never on the host (ADR 0501).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContainerRuntime,
  type ContainerSpec,
  checkSpec,
  copyStoreForCheck,
  dockerBytes,
  dockerRunArgs,
  execInCheckContainer,
  limitText,
} from "../src/container/index.ts";
import { type Exec, nodeExec } from "../src/exec.ts";

const agent: ContainerSpec = {
  name: "sf-job-1-agent",
  image: "sha256:abc",
  user: "501:20",
  workdir: "/w/repo",
  entrypoint: "/bin/sh",
  command: ["/run/launch.sh"],
  env: { HOME: "/w/home", HTTPS_PROXY: "http://egress:3128", NO_PROXY: "localhost" },
  envFile: "/secrets/sf-job-1.env",
  mounts: [{ source: "/w/repo", target: "/w/repo", readOnly: false }],
  tmpfs: { "/tmp": "rw" },
  network: "sf-job-1-net",
  networkAlias: "agent",
  labels: { "software-factory.job": "job_1", "software-factory.role": "agent" },
  pidsLimit: 4096,
  interactive: true,
  detachKeys: "ctrl-^",
};

const runtime = (removed: string[], oomKilled = false) =>
  ({
    runArgv: (spec: ContainerSpec) => ["docker", ...dockerRunArgs({ ...spec, interactive: true })],
    remove: async (name: string) => {
      removed.push(name);
    },
    inspect: async () => ({ State: { OOMKilled: oomKilled, ExitCode: 137 } }),
  }) as unknown as ContainerRuntime;

/** A `docker run` that answers as the wrapper does, with the cgroup line it prints. */
const answering =
  (code: number, line: { pids?: string; mem?: string; tmp?: string }, calls: string[][] = []) =>
  async (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    const marker = args.at(-1) ?? "";
    return {
      stdout: "RUN v4\n",
      stderr: `Error: boom\n\n${marker} pids=[${line.pids ?? "max 0 "}] mem=[${line.mem ?? "low 0 high 0 max 0 oom 0 oom_kill 0 "}] tmp=[${line.tmp ?? "tmpfs 1048576 1024 1047552 1% /tmp"}]\n`,
      code,
    };
  };

describe("checks in a container (ADR 0501)", () => {
  it("runs the agent's image on the clean tree only, with no network, credential or terminal", () => {
    const spec = checkSpec(agent, "pnpm test", 1, { dir: "/t/tree-0", pnpmStore: "/w/pnpm-store" });
    expect(spec).toMatchObject({
      name: "sf-job-1-agent-check-1",
      image: "sha256:abc",
      user: "501:20",
      workdir: "/w/repo",
      command: ["-c", "pnpm test"],
      network: "none",
      interactive: false,
      labels: { "software-factory.job": "job_1", "software-factory.role": "check" },
    });
    // The clean tree at the work path, the pnpm store; never the job repo, its git dir or a home.
    expect(spec.mounts).toEqual([
      { source: "/t/tree-0", target: "/w/repo", readOnly: false },
      { source: "/w/pnpm-store", target: "/w/pnpm-store", readOnly: false },
    ]);
    expect(spec.envFile).toBeUndefined();
    expect(spec.env).toEqual({
      HOME: "/tmp",
      npm_config_store_dir: "/w/pnpm-store",
      CI: "1",
      FORCE_COLOR: "0",
    });
    const args = dockerRunArgs(spec);
    expect(args).not.toContain("--env-file");
    expect(args).not.toContain("-t");
  });

  it("gives each check its own copy of the job's pnpm store, never the agent's store itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "sf-check-store-"));
    try {
      const store = join(root, "pnpm-store");
      await mkdir(join(store, "v10"), { recursive: true });
      await writeFile(join(store, "v10", "index"), "agent's");
      const tree = join(root, "checks", "r0-0", "tree");
      await mkdir(tree, { recursive: true });
      const copy = await copyStoreForCheck(store, tree);
      expect(copy).toBe(join(root, "checks", "r0-0", "store"));
      expect(await readFile(join(copy ?? "", "v10", "index"), "utf8")).toBe("agent's");
      // The check's writes land in its copy; the agent's store is untouched.
      await writeFile(join(copy ?? "", "v10", "index"), "check's");
      expect(await readFile(join(store, "v10", "index"), "utf8")).toBe("agent's");
      const spec = checkSpec(agent, "pnpm install --offline", 1, {
        dir: tree,
        pnpmStore: store,
        pnpmStoreCopy: copy ?? "",
      });
      expect(spec.mounts).toContainEqual({ source: copy, target: store, readOnly: false });
      expect(await copyStoreForCheck(join(root, "none"), tree)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for the container in the foreground and reports its exit code and output", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (bin, args) => {
      calls.push([bin, ...args]);
      return { stdout: "2 passed\n", stderr: "", code: 0 };
    };
    const out = await execInCheckContainer(
      runtime([]),
      exec,
      agent,
      { run: "pnpm test", dir: "/t/tree-0", timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(out).toEqual({
      exitCode: 0,
      timedOut: false,
      output: "2 passed\n",
      isolation: "container",
    });
    // Not `--rm`: it is inspected after it exits, then removed.
    expect(calls[0]?.slice(0, 2)).toEqual(["docker", "run"]);
    expect(calls[0]).not.toContain("--rm");
    expect(calls[0]).not.toContain("-d");
    // The check's own command, inside the wrapper that reports the limits.
    expect(calls[0]?.at(-2)).toBe("pnpm test");
    expect(calls[0]?.join(" ")).toContain("--network none");
  });

  it("gives a local job's check its own network and proxy, and its store in place (fourth review)", () => {
    const spec = checkSpec(
      agent,
      "pnpm test",
      3,
      { dir: "/c/r0-1/tree", pnpmStore: "/c/r0-1/store", pnpmStoreCopy: "/c/r0-1/store" },
      { network: "sf-chk-1-net", store: "/c/r0-1/store" },
    );
    expect(spec.network).toBe("sf-chk-1-net");
    // Its only way out is its own egress proxy: the proxy variables stay, HOME doesn't.
    expect(spec.env).toMatchObject({ HTTPS_PROXY: "http://egress:3128", HOME: "/tmp" });
    expect(spec.mounts).toContainEqual({
      source: "/c/r0-1/store",
      target: "/c/r0-1/store",
      readOnly: false,
    });
    // Without one: no network at all, and no proxy.
    const offline = checkSpec(agent, "pnpm test", 4, { dir: "/c/r0-1/tree" });
    expect(offline.network).toBe("none");
    expect(offline.env.HTTPS_PROXY).toBeUndefined();
  });

  it("kills and removes a check that runs past its timeout", async () => {
    const removed: string[] = [];
    const exec: Exec = (_bin, _args, options) =>
      new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () =>
          resolve({ stdout: "", stderr: "killed", code: 1 }),
        );
      });
    const out = await execInCheckContainer(
      runtime(removed),
      exec,
      agent,
      { run: "sleep 100", dir: "/t/tree-0", timeoutMs: 50 },
      new AbortController().signal,
    );
    expect(out).toMatchObject({ exitCode: null, timedOut: true });
    expect(removed).toEqual([expect.stringMatching(/^sf-job-1-agent-check-\d+$/)]);
  });

  it("streams a check's output with a cap rather than buffering it all", async () => {
    let asked: Parameters<Exec>[2];
    const exec: Exec = async (_bin, _args, options) => {
      asked = options;
      return { stdout: "", stderr: "", code: 0 };
    };
    await execInCheckContainer(
      runtime([]),
      exec,
      agent,
      { run: "pnpm test", dir: "/t/tree-0", timeoutMs: 1_000 },
      new AbortController().signal,
    );
    expect(asked?.keepTail).toBeGreaterThan(0);
    // The real exec keeps only the tail of each stream, however much is printed.
    const big = await nodeExec(
      "/bin/sh",
      [
        "-c",
        "i=0; while [ $i -lt 2000 ]; do printf '%0100d\\n' $i; i=$((i+1)); done; echo END; exit 3",
      ],
      { keepTail: 1_000 },
    );
    expect(big.code).toBe(3);
    expect(big.stdout.length).toBeLessThanOrEqual(1_000);
    expect(big.stdout.endsWith("END\n")).toBe(true);
  });

  it("tells a check stopped by its memory, pids or /tmp limit from a failure, with the limit", async () => {
    const spec = { ...agent, memory: "4g", tmpfs: { "/tmp": "rw,exec,nosuid,size=1g" } };
    const run = (
      exitCode: number,
      line: Parameters<typeof answering>[1],
      oomKilled = false,
      removed: string[] = [],
    ) =>
      execInCheckContainer(
        runtime(removed, oomKilled),
        answering(exitCode, line),
        spec,
        { run: "pnpm test", dir: "/t/tree-0", timeoutMs: 5_000 },
        new AbortController().signal,
      );
    // Killed by the kernel for memory: docker inspect says so.
    const removed: string[] = [];
    const oom = await run(137, {}, true, removed);
    expect(oom).toMatchObject({
      exitCode: 137,
      limit: "the check ran out of memory (limit 4 GB)",
    });
    // The wrapper's line is not part of the check's output; the container is removed after.
    expect(oom.output).toBe("RUN v4\nError: boom\n");
    expect(removed).toHaveLength(1);
    // A test worker the kernel killed while the shell lived on: the cgroup's count says so.
    expect(await run(1, { mem: "low 0 high 0 max 3 oom 1 oom_kill 1 " })).toMatchObject({
      limit: "the check ran out of memory (limit 4 GB)",
    });
    expect(await run(1, { pids: "max 12 " })).toMatchObject({
      limit: "the check ran out of processes (limit 4096 processes)",
    });
    expect(await run(1, { tmp: "tmpfs 1048576 1048576 0 100% /tmp" })).toMatchObject({
      limit: "the check filled its /tmp (limit 1 GB)",
    });
    // An ordinary failure, and a pass that touched a limit, are neither.
    expect((await run(1, {})).limit).toBeUndefined();
    expect((await run(0, { pids: "max 3 " })).limit).toBeUndefined();
  });

  it("reads Docker's sizes and says them as a person would", () => {
    expect(dockerBytes("4g")).toBe(4 * 1024 ** 3);
    expect(dockerBytes("4096m")).toBe(4 * 1024 ** 3);
    expect(dockerBytes("rw,exec,nosuid,size=1g")).toBe(1024 ** 3);
    expect(dockerBytes(undefined)).toBeNull();
    expect(limitText(4 * 1024 ** 3)).toBe("4 GB");
    expect(limitText(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(limitText(512 * 1024 ** 2)).toBe("512 MB");
  });
});
