// The container runtime behind a container job (ADR 0430): a small interface, and Docker over its
// CLI. The same calls work on Docker Desktop and OrbStack on the Mac and Docker Engine on Linux.
// Another runtime (Apple's `container` CLI) would be a second implementation of this interface;
// nothing else in the module names Docker.
import { type Exec, type ExecResult, nodeExec } from "../exec.ts";

/** One bind mount, at its absolute path inside the container. */
export interface Mount {
  source: string;
  target: string;
  readOnly: boolean;
}

/** Everything a container is started with. The record the launch check compares against. */
export interface ContainerSpec {
  name: string;
  /** The image id (`sha256:…`), never a tag that could move. */
  image: string;
  /** `uid:gid`. */
  user: string;
  workdir: string;
  entrypoint: string;
  command: string[];
  /** Non-secret environment, in the argv. Secrets come from `envFile`. */
  env: Record<string, string>;
  /** A file of `KEY=value` lines, read by the CLI at start (the model credential). */
  envFile?: string;
  mounts: Mount[];
  /** tmpfs mounts: path → options. */
  tmpfs: Record<string, string>;
  network: string;
  /** The container's name on `network`, besides its own. */
  networkAlias?: string;
  labels: Record<string, string>;
  pidsLimit: number;
  cpus?: number;
  /** Docker's memory syntax (`8g`). */
  memory?: string;
  /** `name:ip` entries (`host.docker.internal:host-gateway`); tests only. */
  addHosts?: string[];
  /** Attached to a terminal (`-i -t`, the agent) or detached (`-d`, the proxy). */
  interactive: boolean;
  /** The terminal keys that detach the CLI; set so ordinary keys reach the agent. */
  detachKeys?: string;
}

/** The parts of `docker inspect` the launch check reads. */
export interface ContainerInspect {
  Id?: string;
  Name?: string;
  Image?: string;
  State?: { Running?: boolean; Status?: string; OOMKilled?: boolean; ExitCode?: number };
  Config?: {
    User?: string;
    WorkingDir?: string;
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    Env?: string[] | null;
    Labels?: Record<string, string> | null;
  };
  HostConfig?: {
    Privileged?: boolean;
    ReadonlyRootfs?: boolean;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    SecurityOpt?: string[] | null;
    NetworkMode?: string;
    PortBindings?: Record<string, unknown> | null;
    PublishAllPorts?: boolean;
    Devices?: unknown[] | null;
    PidMode?: string;
    IpcMode?: string;
    UsernsMode?: string;
    Binds?: string[] | null;
    Mounts?: Array<{ Type?: string; Source?: string; Target?: string; ReadOnly?: boolean }> | null;
    Tmpfs?: Record<string, string> | null;
    Init?: boolean | null;
    PidsLimit?: number | null;
  };
  NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

export interface ListedContainer {
  name: string;
  labels: Record<string, string>;
  running: boolean;
}

export interface ContainerRuntime {
  readonly kind: string;
  /** The CLI's absolute path (or name on PATH). */
  readonly bin: string;
  /** The server's version; throws when the server can't be reached. */
  version(): Promise<string>;
  /** The id of a local image, or null when there is none. */
  imageId(ref: string): Promise<string | null>;
  build(input: { context: string; tag: string; timeoutMs?: number }): Promise<void>;
  createNetwork(
    name: string,
    options: { internal: boolean; labels: Record<string, string> },
  ): Promise<void>;
  /** Gone is fine. */
  removeNetwork(name: string): Promise<void>;
  connect(network: string, container: string, alias?: string): Promise<void>;
  /** Starts a detached container. */
  start(spec: ContainerSpec): Promise<void>;
  /** The full argv (CLI first) that runs `spec` attached to the terminal it is run in. */
  runArgv(spec: ContainerSpec): string[];
  exec(container: string, argv: string[]): Promise<ExecResult>;
  inspect(container: string): Promise<ContainerInspect | null>;
  logs(container: string): Promise<string>;
  /** Kills and removes. Gone is fine. */
  remove(container: string): Promise<void>;
  /** Containers (running or not) carrying `label`. */
  containers(label: string): Promise<ListedContainer[]>;
  /** Networks carrying `label`. */
  networks(label: string): Promise<Array<{ name: string; labels: Record<string, string> }>>;
}

export class ContainerRuntimeError extends Error {
  override name = "ContainerRuntimeError";
}

const GONE = /no such (container|network|object)|not found|is not connected/i;

/** `--mount` takes CSV: refuse what it can't carry rather than quote it. */
function mountArg(m: Mount): string {
  for (const path of [m.source, m.target]) {
    if (/[,"'\n]/.test(path))
      throw new ContainerRuntimeError(`can't mount a path with , or quotes: ${path}`);
  }
  return `type=bind,src=${m.source},dst=${m.target}${m.readOnly ? ",readonly" : ""}`;
}

/** `docker run` arguments for a spec (without the CLI itself). */
export function dockerRunArgs(spec: ContainerSpec): string[] {
  const args = ["run", "--rm"];
  if (spec.interactive) {
    args.push("-i", "-t");
    if (spec.detachKeys) args.push("--detach-keys", spec.detachKeys);
  } else {
    args.push("-d");
  }
  args.push("--name", spec.name);
  for (const [k, v] of Object.entries(spec.labels)) args.push("--label", `${k}=${v}`);
  args.push(
    "--init",
    "--network",
    spec.network,
    ...(spec.networkAlias ? ["--network-alias", spec.networkAlias] : []),
    "--user",
    spec.user,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(spec.pidsLimit),
  );
  if (spec.cpus) args.push("--cpus", String(spec.cpus));
  if (spec.memory) args.push("--memory", spec.memory);
  for (const host of spec.addHosts ?? []) args.push("--add-host", host);
  for (const [path, options] of Object.entries(spec.tmpfs)) {
    args.push("--tmpfs", options ? `${path}:${options}` : path);
  }
  for (const m of spec.mounts) args.push("--mount", mountArg(m));
  for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
  if (spec.envFile) args.push("--env-file", spec.envFile);
  args.push("-w", spec.workdir, "--entrypoint", spec.entrypoint, spec.image, ...spec.command);
  return args;
}

function parseLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export function dockerRuntime(options: { exec?: Exec; bin?: string } = {}): ContainerRuntime {
  const exec = options.exec ?? nodeExec;
  const bin = options.bin ?? "docker";
  const call = (args: string[], timeoutMs = 60_000) => exec(bin, args, { timeoutMs });
  async function must(args: string[], timeoutMs?: number): Promise<string> {
    const r = await call(args, timeoutMs);
    if (r.code !== 0) {
      throw new ContainerRuntimeError(`docker ${args[0]} exited ${r.code}: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }
  async function quiet(args: string[]): Promise<void> {
    const r = await call(args);
    if (r.code !== 0 && !GONE.test(r.stderr)) {
      throw new ContainerRuntimeError(
        `docker ${args.join(" ")} exited ${r.code}: ${r.stderr.trim()}`,
      );
    }
  }

  return {
    kind: "docker",
    bin,
    async version() {
      const r = await call(["version", "--format", "{{.Server.Version}}"], 20_000);
      const v = r.stdout.trim();
      if (r.code !== 0 || !v) {
        throw new ContainerRuntimeError(
          `the Docker server isn't reachable: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`,
        );
      }
      return v;
    },
    async imageId(ref) {
      const r = await call(["image", "inspect", "--format", "{{.Id}}", ref]);
      const id = r.stdout.trim();
      return r.code === 0 && id ? id : null;
    },
    async build({ context, tag, timeoutMs }) {
      await must(["build", "--quiet", "--tag", tag, context], timeoutMs ?? 30 * 60_000);
    },
    async createNetwork(name, { internal, labels }) {
      await must([
        "network",
        "create",
        ...(internal ? ["--internal"] : []),
        ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        name,
      ]);
    },
    removeNetwork: (name) => quiet(["network", "rm", name]),
    async connect(network, container, alias) {
      await must(["network", "connect", ...(alias ? ["--alias", alias] : []), network, container]);
    },
    async start(spec) {
      await must(dockerRunArgs({ ...spec, interactive: false }), 120_000);
    },
    runArgv: (spec) => [bin, ...dockerRunArgs({ ...spec, interactive: true })],
    exec: (container, argv) => call(["exec", container, ...argv], 20_000),
    async inspect(container) {
      const r = await call(["container", "inspect", container]);
      if (r.code !== 0) return null;
      try {
        const [first] = JSON.parse(r.stdout) as ContainerInspect[];
        return first ?? null;
      } catch {
        return null;
      }
    },
    async logs(container) {
      const r = await call(["logs", container]);
      return r.code === 0 ? `${r.stdout}${r.stderr}` : "";
    },
    remove: (container) => quiet(["rm", "-f", container]),
    async containers(label) {
      const r = await call([
        "ps",
        "-a",
        "--filter",
        `label=${label}`,
        "--format",
        "{{.Names}}\t{{.State}}\t{{.Labels}}",
      ]);
      if (r.code !== 0)
        throw new ContainerRuntimeError(`docker ps exited ${r.code}: ${r.stderr.trim()}`);
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name = "", state = "", labels = ""] = line.split("\t");
          return { name, running: state === "running", labels: parseLabels(labels) };
        });
    },
    async networks(label) {
      const r = await call([
        "network",
        "ls",
        "--filter",
        `label=${label}`,
        "--format",
        "{{.Name}}\t{{.Labels}}",
      ]);
      if (r.code !== 0)
        throw new ContainerRuntimeError(`docker network ls exited ${r.code}: ${r.stderr.trim()}`);
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name = "", labels = ""] = line.split("\t");
          return { name, labels: parseLabels(labels) };
        });
    },
  };
}
