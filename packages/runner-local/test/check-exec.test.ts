// The project's checks for a container job run in a fresh container, never on the host (ADR 0501).
import { describe, expect, it } from "vitest";
import {
  type ContainerRuntime,
  type ContainerSpec,
  checkSpec,
  dockerRunArgs,
  execInCheckContainer,
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

const runtime = (removed: string[]) =>
  ({
    runArgv: (spec: ContainerSpec) => ["docker", ...dockerRunArgs({ ...spec, interactive: true })],
    remove: async (name: string) => {
      removed.push(name);
    },
  }) as unknown as ContainerRuntime;

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
    expect(out).toEqual({ exitCode: 0, timedOut: false, output: "2 passed\n" });
    expect(calls[0]?.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
    expect(calls[0]).not.toContain("-d");
    expect(calls[0]?.join(" ")).toContain("--network none");
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
});
