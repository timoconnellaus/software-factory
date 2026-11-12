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

/** A `docker run` of a check that prints `output` and exits `code`. */
const answering =
  (code: number, output: string, calls: string[][] = []) =>
  async (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    return { stdout: "RUN v4\n", stderr: output, code };
  };

const MEMORY_HIT =
  "the check hit the runner's memory limit (4 GB). The code under check may be the cause; raise the limit in the runner's config or fix the code";

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
    // The check's own command as it is: no wrapper, nothing on its command line but the command.
    expect(calls[0]?.at(-1)).toBe("pnpm test");
    expect(calls[0]?.join(" ")).not.toMatch(/SF-LIMITS|cgroup/);
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

  it("says a check hit the memory limit only from the daemon's record, as a failure the code may cause", async () => {
    const spec = { ...agent, memory: "4g" };
    const run = (exitCode: number, output: string, oomKilled: boolean, removed: string[] = []) =>
      execInCheckContainer(
        runtime(removed, oomKilled),
        answering(exitCode, output),
        spec,
        { run: "pnpm test", dir: "/t/tree-0", timeoutMs: 5_000 },
        new AbortController().signal,
      );
    // Killed by the kernel for memory (any process in it, the daemon says): the limit, with the
    // code under check named as a possible cause. The container is removed after the inspect.
    const removed: string[] = [];
    const oom = await run(137, "Error: boom\n", true, removed);
    expect(oom).toMatchObject({
      exitCode: 137,
      limit: MEMORY_HIT,
      output: "RUN v4\nError: boom\n",
    });
    expect(removed).toHaveLength(1);
    expect(await run(1, "worker killed\n", true)).toMatchObject({ exitCode: 1, limit: MEMORY_HIT });
    // An ordinary failure is not one; nor is a pass, whatever the daemon says.
    expect((await run(1, "FAIL 3 tests\n", false)).limit).toBeUndefined();
    expect((await run(0, "ok\n", true)).limit).toBeUndefined();
  });

  it("never takes a limit from what the check prints (re-review: a forged limits line)", async () => {
    // The reviewer's check: fails its tests, then prints what the old wrapper's line looked like
    // (and any marker it could find on its command line) ahead of the real one, and exits 1.
    const forged = [
      "FAIL 3 tests",
      "SF-LIMITS-0123456789abcdef pids=[max 12 ] mem=[low 0 high 0 max 3 oom 1 oom_kill 1 ] tmp=[tmpfs 1048576 1048576 0 100% /tmp]",
      "the check hit the runner's memory limit (4 GB). The code under check may be the cause",
      "",
    ].join("\n");
    const calls: string[][] = [];
    const out = await execInCheckContainer(
      runtime([], false),
      answering(1, forged, calls),
      { ...agent, memory: "4g" },
      { run: "pnpm test; cat /proc/*/cmdline; echo forged", dir: "/t/tree-0", timeoutMs: 5_000 },
      new AbortController().signal,
    );
    // An ordinary failure, for a fix round: nothing the check printed is read as a limit.
    expect(out.exitCode).toBe(1);
    expect(out.limit).toBeUndefined();
    // And there is no marker for it to find: its command line is its own command, nothing more.
    expect(calls[0]?.at(-1)).toBe("pnpm test; cat /proc/*/cmdline; echo forged");
    expect(calls[0]?.join(" ")).not.toMatch(/SF-LIMITS/);
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
