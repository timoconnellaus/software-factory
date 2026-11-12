// What a container job's two containers look like (ADR 0430 §4, §5), the script the tmux pane runs,
// and the check that the running agent container is exactly that (§7).
//
// Every path the harness projected (settings, launch script, status file, home, temp) is mounted at
// the same absolute path it has on the host, so the launch script and the settings work unchanged
// inside, and paths the hooks report (the transcript) are valid on the host.
import { join } from "node:path";
import { PID_FILE, STATUS_FILE, shellQuote } from "@software-factory/harness-claude";
import { EGRESS_ALIAS, EGRESS_PORT, proxyEnv } from "./egress.ts";
import { EGRESS_SCRIPT } from "./image.ts";
import type { ContainerInspect, ContainerSpec, Mount } from "./runtime.ts";

/** The label every factory container and network carries: the job id. */
export const JOB_LABEL = "software-factory.job";
export const ROLE_LABEL = "software-factory.role";
export const CONTAINER_RECORD = "container.json";
export const CONTAINER_SCRIPT = "container.sh";
/** Docker's detach keys, moved off `ctrl-p ctrl-q` so a person attached through tmux can type them. */
export const DETACH_KEYS = "ctrl-^,ctrl-_";

/** The names of a job's containers and network (`sf-<jobId>` is also its tmux session). */
export function containerNames(name: string) {
  return { agent: name, proxy: `${name}-egress`, network: `${name}-net` };
}

/** A container job's directories on the host (all under `<containersDir>/sf-<jobId>/`). */
export function jobDirs(containersDir: string, name: string) {
  const root = join(containersDir, name);
  return {
    root,
    work: join(root, "work"),
    gitDir: join(root, "git"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    /** The harness puts pnpm's store next to the run's temp dir (`harnessEnv`). */
    pnpmStore: join(root, "pnpm-store"),
    egressLog: join(root, "egress.log"),
  };
}

/** The credential's env file: outside every mount, 0600, gone once the agent is up. */
export function secretsFile(containersDir: string, name: string): string {
  return join(containersDir, ".secrets", `${name}.env`);
}

/** What the runner records about a container job, next to the launch record. */
export interface ContainerRecord {
  jobId: string;
  runtime: string;
  imageTag: string;
  agent: ContainerSpec;
  proxy: ContainerSpec;
  allow: string[];
  /** The job repo, for the check after the session. */
  repo: { work: string; gitDir: string; dotGit: string; configHash: string };
}

export function agentMounts(input: {
  work: string;
  gitDir: string;
  runDir: string;
  home: string;
  tmp: string;
  pnpmStore: string;
  attachmentsDir?: string;
  extra?: Mount[];
}): Mount[] {
  const rw = (p: string): Mount => ({ source: p, target: p, readOnly: false });
  const ro = (p: string): Mount => ({ source: p, target: p, readOnly: true });
  return [
    rw(input.work),
    // The working tree's pointer to its git dir, and the factory's Claude config: never the agent's.
    ro(join(input.work, ".git")),
    ro(join(input.work, ".claude")),
    rw(input.gitDir),
    ro(join(input.gitDir, "config")),
    ro(join(input.gitDir, "hooks")),
    ro(join(input.gitDir, "info")),
    ro(join(input.gitDir, "objects", "info")),
    // Settings, launch script, git identity, status hook: read only, except what the run reports.
    ro(input.runDir),
    rw(join(input.runDir, STATUS_FILE)),
    rw(join(input.runDir, PID_FILE)),
    rw(input.home),
    rw(input.tmp),
    rw(input.pnpmStore),
    ...(input.attachmentsDir ? [ro(input.attachmentsDir)] : []),
    ...(input.extra ?? []),
  ];
}

export interface AgentSpecInput {
  name: string;
  image: string;
  user: string;
  work: string;
  home: string;
  launchScript: string;
  mounts: Mount[];
  network: string;
  jobId: string;
  envFile: string;
  pidsLimit?: number;
  cpus?: number;
  memory?: string;
}

export function agentSpec(input: AgentSpecInput): ContainerSpec {
  return {
    name: input.name,
    image: input.image,
    user: input.user,
    workdir: input.work,
    entrypoint: "/bin/sh",
    command: [input.launchScript],
    env: {
      HOME: input.home,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      ...proxyEnv(),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      // The job repo belongs to the host user; the container's uid may map differently.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      SOFTWARE_FACTORY_ISOLATION: "container",
    },
    envFile: input.envFile,
    mounts: input.mounts,
    tmpfs: { "/tmp": "rw,exec,nosuid,size=4g" },
    network: input.network,
    labels: { [JOB_LABEL]: input.jobId, [ROLE_LABEL]: "agent" },
    pidsLimit: input.pidsLimit ?? 4096,
    ...(input.cpus ? { cpus: input.cpus } : {}),
    ...(input.memory ? { memory: input.memory } : {}),
    interactive: true,
    detachKeys: DETACH_KEYS,
  };
}

export function proxySpec(input: {
  name: string;
  image: string;
  jobId: string;
  allow: string[];
  addHosts?: string[];
}): ContainerSpec {
  return {
    name: input.name,
    image: input.image,
    user: "65534:65534",
    workdir: "/",
    entrypoint: "node",
    command: [EGRESS_SCRIPT, "--port", String(EGRESS_PORT), "--allow", input.allow.join(",")],
    env: {},
    mounts: [],
    tmpfs: {},
    // The default bridge has a route out; the job network is connected after start (alias `egress`).
    network: "bridge",
    labels: { [JOB_LABEL]: input.jobId, [ROLE_LABEL]: "egress" },
    pidsLimit: 256,
    memory: "256m",
    ...(input.addHosts?.length ? { addHosts: input.addHosts } : {}),
    interactive: false,
  };
}

/** The alias the proxy gets on the job network. */
export const PROXY_ALIAS = EGRESS_ALIAS;

/** The script the job's tmux pane runs: the container, attached to the pane, as the agent. */
export function containerScript(jobId: string, argv: string[]): string {
  return [
    "#!/bin/sh",
    `# Written by the software factory runner for job ${jobId}: Claude Code in a container (ADR 0430).`,
    "# The harness's own launch script runs inside it. The runner checks the live process and this",
    `# container against launch.json and ${CONTAINER_RECORD} before it sends the prompt.`,
    `exec ${argv.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

const mountKey = (m: { source: string; target: string; readOnly: boolean }) =>
  `${m.source} -> ${m.target}${m.readOnly ? " (ro)" : ""}`;

/**
 * What differs between a running container and its spec: image, user, entrypoint and command,
 * privileges, network, ports, devices, mounts, tmpfs, environment. Empty when it is exactly as
 * the runner started it.
 */
export function containerProblems(spec: ContainerSpec, inspect: ContainerInspect | null): string[] {
  if (!inspect) return [`container ${spec.name} isn't running`];
  const problems: string[] = [];
  const host = inspect.HostConfig ?? {};
  const config = inspect.Config ?? {};
  if (inspect.State && inspect.State.Running === false) {
    problems.push(`container ${spec.name} isn't running`);
  }
  if (inspect.Image !== spec.image) {
    problems.push(`image ${inspect.Image ?? "?"}, expected ${spec.image}`);
  }
  if (config.User !== spec.user) problems.push(`user ${config.User ?? "?"}, expected ${spec.user}`);
  if (config.WorkingDir !== spec.workdir) {
    problems.push(`working dir ${config.WorkingDir ?? "?"}, expected ${spec.workdir}`);
  }
  const entry = [...(config.Entrypoint ?? []), ...(config.Cmd ?? [])];
  const expected = [spec.entrypoint, ...spec.command];
  if (entry.join("\0") !== expected.join("\0")) {
    problems.push(`command \`${entry.join(" ")}\`, expected \`${expected.join(" ")}\``);
  }
  if (host.Privileged) problems.push("privileged");
  if (!host.ReadonlyRootfs) problems.push("the root filesystem is writable");
  if (!(host.CapDrop ?? []).map((c) => c.toUpperCase()).includes("ALL")) {
    problems.push("capabilities not dropped");
  }
  if ((host.CapAdd ?? []).length > 0)
    problems.push(`capabilities added: ${host.CapAdd?.join(", ")}`);
  if (!(host.SecurityOpt ?? []).some((o) => /^no-new-privileges(:true|=true)?$/.test(o))) {
    problems.push("no-new-privileges not set");
  }
  if (host.NetworkMode !== spec.network) {
    problems.push(`network ${host.NetworkMode ?? "?"}, expected ${spec.network}`);
  }
  const networks = Object.keys(inspect.NetworkSettings?.Networks ?? {});
  if (!sameSet(networks, [spec.network])) {
    problems.push(`on networks ${networks.join(", ") || "none"}, expected only ${spec.network}`);
  }
  if (host.PublishAllPorts || Object.keys(host.PortBindings ?? {}).length > 0) {
    problems.push("ports are published");
  }
  if ((host.Devices ?? []).length > 0) problems.push("devices are mapped");
  for (const [what, mode] of [
    ["pid", host.PidMode],
    ["ipc", host.IpcMode],
    ["user namespace", host.UsernsMode],
  ] as const) {
    if (mode === "host") problems.push(`shares the host's ${what} namespace`);
  }
  if ((host.Binds ?? []).length > 0) problems.push(`unexpected binds: ${host.Binds?.join(", ")}`);
  const mounts = (host.Mounts ?? []).map((m) => {
    if (m.Type !== "bind") problems.push(`a ${m.Type ?? "?"} mount at ${m.Target ?? "?"}`);
    return mountKey({ source: m.Source ?? "", target: m.Target ?? "", readOnly: !!m.ReadOnly });
  });
  const want = spec.mounts.map(mountKey);
  if (!sameSet(mounts, want)) {
    const extra = mounts.filter((m) => !want.includes(m));
    const missing = want.filter((m) => !mounts.includes(m));
    problems.push(
      `mounts differ${extra.length ? `; unexpected: ${extra.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    );
  }
  const tmpfs = Object.keys(host.Tmpfs ?? {});
  if (!sameSet(tmpfs, Object.keys(spec.tmpfs))) {
    problems.push(
      `tmpfs at ${tmpfs.join(", ") || "none"}, expected ${Object.keys(spec.tmpfs).join(", ")}`,
    );
  }
  const env = new Set(config.Env ?? []);
  for (const [k, v] of Object.entries(spec.env)) {
    if (!env.has(`${k}=${v}`)) problems.push(`environment ${k} isn't ${v}`);
  }
  return problems;
}
