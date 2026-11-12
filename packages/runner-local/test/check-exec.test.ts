// The project's checks for a container job run in a fresh container, never on the host (ADR 0451).
import { describe, expect, it } from "vitest";
import {
  type ContainerRuntime,
  type ContainerSpec,
  checkSpec,
  dockerRunArgs,
  execInCheckContainer,
} from "../src/container/index.ts";
import type { Exec } from "../src/exec.ts";

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

describe("checks in a container (ADR 0451)", () => {
  it("runs the agent's image and mounts with no network, no credential and no terminal", () => {
    const spec = checkSpec(agent, "pnpm test", 1);
    expect(spec).toMatchObject({
      name: "sf-job-1-agent-check-1",
      image: "sha256:abc",
      user: "501:20",
      workdir: "/w/repo",
      command: ["-c", "pnpm test"],
      network: "none",
      interactive: false,
      mounts: agent.mounts,
      labels: { "software-factory.job": "job_1", "software-factory.role": "check" },
    });
    expect(spec.envFile).toBeUndefined();
    expect(spec.env).toEqual({ HOME: "/w/home", CI: "1", FORCE_COLOR: "0" });
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
      { run: "pnpm test", timeoutMs: 5_000 },
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
      { run: "sleep 100", timeoutMs: 50 },
      new AbortController().signal,
    );
    expect(out).toMatchObject({ exitCode: null, timedOut: true });
    expect(removed).toEqual([expect.stringMatching(/^sf-job-1-agent-check-\d+$/)]);
  });
});
