// Test support: a scripted `docker` for the container adapter's tests and the runner host's. It
// keeps images, networks and containers in memory, answers the CLI calls `dockerRuntime` makes, and
// records each one. When the job's tmux session "runs" `container.sh`, it starts the agent container
// from the job's container record, so `docker inspect` and `docker exec … ps` see what the runner
// asked for. `tamper` changes what inspect reports, for the launch check's tests. Every other
// command goes to `base` (a scripted tmux, then real git). Not used at runtime.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LAUNCH_RECORD, type LaunchRecord } from "@software-factory/harness-claude";
import type { Exec, ExecResult } from "../exec.ts";
import type { ContainerInspect, ContainerSpec } from "./runtime.ts";
import { CONTAINER_RECORD, CONTAINER_SCRIPT, type ContainerRecord } from "./spec.ts";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr: string, code = 1): ExecResult => ({ stdout: "", stderr, code });

/** What `docker inspect` says about a container started from `spec`. */
export function inspectFromSpec(
  spec: ContainerSpec,
  extraNetworks: string[] = [],
): ContainerInspect {
  return {
    Id: `id-${spec.name}`,
    Name: `/${spec.name}`,
    Image: spec.image,
    State: { Running: true, Status: "running" },
    Config: {
      User: spec.user,
      WorkingDir: spec.workdir,
      Entrypoint: [spec.entrypoint],
      Cmd: spec.command,
      Env: [
        ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ],
      Labels: spec.labels,
    },
    HostConfig: {
      Privileged: false,
      ReadonlyRootfs: true,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: spec.network,
      PortBindings: {},
      PublishAllPorts: false,
      Devices: [],
      PidMode: "",
      IpcMode: "private",
      UsernsMode: "",
      Binds: null,
      Mounts: spec.mounts.map((m) => ({
        Type: "bind",
        Source: m.source,
        Target: m.target,
        ...(m.readOnly ? { ReadOnly: true } : {}),
      })),
      Tmpfs: spec.tmpfs,
      Init: true,
      PidsLimit: spec.pidsLimit,
    },
    NetworkSettings: {
      Networks: Object.fromEntries([spec.network, ...extraNetworks].map((n) => [n, {}])),
    },
  };
}

/** Reads `docker run` arguments back into the spec fields the fake needs. */
function parseRun(args: string[]): {
  spec: Partial<ContainerSpec> & { name: string };
  interactive: boolean;
} {
  const spec: Partial<ContainerSpec> & { name: string } = {
    name: "",
    labels: {},
    env: {},
    mounts: [],
    tmpfs: {},
  };
  let interactive = false;
  let i = 1; // after "run"
  const next = () => args[++i] ?? "";
  for (; i < args.length; i++) {
    const a = args[i] ?? "";
    switch (a) {
      case "--rm":
      case "--init":
      case "--read-only":
        break;
      case "-d":
        interactive = false;
        break;
      case "-i":
      case "-t":
        interactive = true;
        break;
      case "--detach-keys":
      case "--cap-drop":
      case "--security-opt":
      case "--pids-limit":
      case "--cpus":
      case "--memory":
      case "--add-host":
      case "--network-alias":
        next();
        break;
      case "--name":
        spec.name = next();
        break;
      case "--label": {
        const [k = "", ...v] = next().split("=");
        (spec.labels as Record<string, string>)[k] = v.join("=");
        break;
      }
      case "--network":
        spec.network = next();
        break;
      case "--user":
        spec.user = next();
        break;
      case "--tmpfs": {
        const [path = "", ...opts] = next().split(":");
        (spec.tmpfs as Record<string, string>)[path] = opts.join(":");
        break;
      }
      case "--mount": {
        const fields = Object.fromEntries(
          next()
            .split(",")
            .map((f) => [f.split("=")[0], f.split("=").slice(1).join("=")]),
        );
        spec.mounts?.push({
          source: fields.src ?? "",
          target: fields.dst ?? "",
          readOnly: "readonly" in fields,
        });
        break;
      }
      case "-e": {
        const [k = "", ...v] = next().split("=");
        (spec.env as Record<string, string>)[k] = v.join("=");
        break;
      }
      case "--env-file":
        spec.envFile = next();
        break;
      case "-w":
        spec.workdir = next();
        break;
      case "--entrypoint":
        spec.entrypoint = next();
        break;
      default:
        spec.image = a;
        spec.command = args.slice(i + 1);
        i = args.length;
    }
  }
  return { spec, interactive };
}

interface FakeContainer {
  name: string;
  inspect: ContainerInspect;
  logs: string;
  /** The run dir of an agent container (for `ps`). */
  runDir?: string;
  /** What the credential env file held when it started. */
  envFile?: string;
}

export interface ScriptedDockerOptions {
  /** Everything that isn't `docker` (a scripted tmux, then real git). */
  base: Exec;
  /** The CLI name the runtime calls (default `docker`). */
  bin?: string;
  /** Changes what inspect reports for a container (launch check tests). */
  tamper?: (name: string, inspect: ContainerInspect) => void;
  /** The command line `ps` reports for the agent (default: the launch record's argv). */
  ps?: (record: LaunchRecord) => string | null;
  /** The Docker server isn't running. */
  down?: boolean;
  /** The image isn't built yet (a build adds it). */
  noImage?: boolean;
}

export function scriptedDocker(options: ScriptedDockerOptions) {
  const bin = options.bin ?? "docker";
  const images = new Map<string, string>();
  const networks = new Map<string, { internal: boolean; labels: Record<string, string> }>();
  const containers = new Map<string, FakeContainer>();
  const calls: string[][] = [];
  /** Each container's env file as it started, kept after the container is removed. */
  const envFiles = new Map<string, string>();
  let builds = 0;

  const labelsOf = (labels: Record<string, string> | null | undefined) =>
    Object.entries(labels ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(",");

  function start(spec: ContainerSpec, runDir?: string) {
    const inspect = inspectFromSpec(spec);
    options.tamper?.(spec.name, inspect);
    let envFile: string | undefined;
    if (spec.envFile) {
      try {
        envFile = readFileSync(spec.envFile, "utf8");
        envFiles.set(spec.name, envFile);
      } catch {
        envFile = undefined;
      }
    }
    containers.set(spec.name, {
      name: spec.name,
      inspect,
      logs: spec.entrypoint === "node" ? `${JSON.stringify({ listening: 3128 })}\n` : "",
      ...(runDir ? { runDir } : {}),
      ...(envFile !== undefined ? { envFile } : {}),
    });
  }

  async function docker(args: string[]): Promise<ExecResult> {
    calls.push(args);
    if (options.down)
      return fail("Cannot connect to the Docker daemon. Is the docker daemon running?");
    const [verb, sub] = args;
    if (verb === "version") return ok("29.2.1\n");
    if (verb === "image" && sub === "inspect") {
      const id = images.get(args.at(-1) ?? "");
      return id ? ok(`${id}\n`) : fail("Error: No such image");
    }
    if (verb === "build") {
      const tag = args[args.indexOf("--tag") + 1] ?? "";
      builds++;
      images.set(tag, `sha256:${"b".repeat(60)}${String(builds).padStart(4, "0")}`);
      return ok();
    }
    if (verb === "network") {
      if (sub === "create") {
        const name = args.at(-1) ?? "";
        if (networks.has(name)) return fail(`network with name ${name} already exists`);
        const labels: Record<string, string> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--label") {
            const [k = "", ...v] = (args[i + 1] ?? "").split("=");
            labels[k] = v.join("=");
          }
        }
        networks.set(name, { internal: args.includes("--internal"), labels });
        return ok();
      }
      if (sub === "rm") {
        return networks.delete(args.at(-1) ?? "") ? ok() : fail("Error: No such network");
      }
      if (sub === "connect") {
        const container = containers.get(args.at(-1) ?? "");
        const network = args.at(-2) ?? "";
        if (!container || !networks.has(network)) return fail("Error: No such container");
        const nets = container.inspect.NetworkSettings?.Networks ?? {};
        nets[network] = {};
        return ok();
      }
      if (sub === "ls") {
        return ok(
          [...networks.entries()]
            .filter(([, n]) => Object.keys(n.labels).length > 0)
            .map(([name, n]) => `${name}\t${labelsOf(n.labels)}\n`)
            .join(""),
        );
      }
    }
    if (verb === "run") {
      const { spec } = parseRun(args);
      if (containers.has(spec.name))
        return fail(`Conflict. The container name "/${spec.name}" is already in use`);
      start(spec as ContainerSpec);
      return ok(`id-${spec.name}\n`);
    }
    if (verb === "rm") {
      const name = args.at(-1) ?? "";
      return containers.delete(name) ? ok() : fail(`Error: No such container: ${name}`);
    }
    if (verb === "container" && sub === "inspect") {
      const c = containers.get(args.at(-1) ?? "");
      return c ? ok(JSON.stringify([c.inspect])) : fail("Error: No such object");
    }
    if (verb === "logs") {
      const c = containers.get(args.at(-1) ?? "");
      return c ? ok(c.logs) : fail("Error: No such container");
    }
    if (verb === "exec") {
      const c = containers.get(args[1] ?? "");
      if (!c) return fail("Error: No such container");
      if (args[2] === "ps" && c.runDir) {
        const record = JSON.parse(
          readFileSync(join(c.runDir, LAUNCH_RECORD), "utf8"),
        ) as LaunchRecord;
        const line = options.ps ? options.ps(record) : record.argv.join(" ");
        return line === null ? fail("", 1) : ok(`${line}\n`);
      }
      return fail(`unscripted exec ${args.slice(2).join(" ")}`);
    }
    if (verb === "ps") {
      return ok(
        [...containers.values()]
          .map(
            (c) =>
              `${c.name}\t${c.inspect.State?.Running ? "running" : "exited"}\t${labelsOf(c.inspect.Config?.Labels)}\n`,
          )
          .join(""),
      );
    }
    return fail(`unscripted docker ${args.join(" ")}`);
  }

  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === bin) return docker(args);
    // The job's tmux pane runs container.sh: that starts the agent container.
    if (cmd === "tmux" && args.includes("new-session")) {
      const command = args.find((a) => a.startsWith("exec /bin/sh")) ?? "";
      const script = /exec \/bin\/sh '?([^']+?)'?$/.exec(command)?.[1];
      if (script && basename(script) === CONTAINER_SCRIPT) {
        const runDir = dirname(script);
        const record = JSON.parse(
          readFileSync(join(runDir, CONTAINER_RECORD), "utf8"),
        ) as ContainerRecord;
        if (!options.down) start(record.agent, runDir);
      }
    }
    return options.base(cmd, args, opts);
  };

  if (!options.noImage) {
    // Any tag resolves until a test says otherwise: an image the host already has.
    const has = images.has.bind(images);
    images.has = (k) => has(k) || k.startsWith("software-factory-agent:");
    const get = images.get.bind(images);
    images.get = (k) =>
      get(k) ?? (k.startsWith("software-factory-agent:") ? `sha256:${"a".repeat(64)}` : undefined);
  }

  return {
    exec,
    calls,
    images,
    networks,
    containers,
    get builds() {
      return builds;
    },
    /** The agent container's environment file contents when it started. */
    envFileOf: (name: string) => envFiles.get(name),
  };
}
