// The container runtime a container job runs in (ADR 0661): Docker over its CLI. The same calls work
// on Docker Desktop and OrbStack on the Mac and Docker Engine on Linux. Nothing else in the module
// names Docker, so another runtime (Apple's `container`, a remote sandbox) is a second implementation
// of `ContainerRuntime`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Exec, type ExecResult, nodeExec } from "../exec.ts";

/** One bind mount, at the same absolute path inside the container as on the host unless `target`. */
export interface Mount {
  path: string;
  readOnly: boolean;
  target?: string;
}

/** Everything a job's container is started with. */
export interface ContainerSpec {
  name: string;
  /** The image id (`sha256:…`), never a tag that could move. */
  image: string;
  /** `uid:gid`: the runner's own, so the files it writes are the host user's. */
  user: string;
  workdir: string;
  /** Run with `/bin/sh`: the harness's launch script. */
  script: string;
  env: Record<string, string>;
  mounts: Mount[];
  labels: Record<string, string>;
}

export interface ListedContainer {
  name: string;
  labels: Record<string, string>;
}

export interface ContainerRuntime {
  readonly kind: string;
  /** The CLI, as an absolute path when one was found (the service's PATH may not have it). */
  readonly bin: string;
  /** The server's version; throws when the server can't be reached. */
  version(): Promise<string>;
  /** The id of a local image, or null when there is none. */
  imageId(ref: string): Promise<string | null>;
  /** Builds `tag` from a Dockerfile's text, with no build context. */
  build(dockerfile: string, tag: string): Promise<void>;
  /**
   * The argv (CLI first) that runs `spec` in the foreground of whatever runs it: with a terminal
   * (`tty`, the tmux pane) or on pipes (a stream-json session).
   */
  runArgv(spec: ContainerSpec, tty: boolean): string[];
  exec(container: string, argv: string[]): Promise<ExecResult>;
  /** Kills and removes. Gone is fine. */
  remove(container: string): Promise<void>;
  /** Containers (running or not) carrying `label` (`key=value`). */
  containers(label: string): Promise<ListedContainer[]>;
}

export class ContainerRuntimeError extends Error {
  override name = "ContainerRuntimeError";
}

/** Docker's detach keys, moved off `ctrl-p ctrl-q` so a person attached through tmux can type them. */
export const DETACH_KEYS = "ctrl-^,ctrl-_";

const GONE = /no such container|not found/i;

/** Where the `docker` CLI usually is when the runner's service PATH doesn't have it. */
export function findDocker(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  const candidates = [
    ...(env.PATH ?? "").split(":").filter(Boolean),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".orbstack", "bin"),
    "/Applications/Docker.app/Contents/Resources/bin",
    "/usr/bin",
  ].map((dir) => join(dir, "docker"));
  return candidates.find((p) => existsSync(p)) ?? "docker";
}

/** `--mount` takes CSV: refuse what it can't carry rather than quote it. */
function mountArg(m: Mount): string {
  const target = m.target ?? m.path;
  for (const path of [m.path, target]) {
    if (/[,"'\n]/.test(path)) {
      throw new ContainerRuntimeError(`can't mount a path with , or quotes: ${path}`);
    }
  }
  return `type=bind,src=${m.path},dst=${target}${m.readOnly ? ",readonly" : ""}`;
}

/**
 * `docker run` arguments for a spec (without the CLI itself): removed when it exits, the runner's
 * user, a read-only root with a tmpfs `/tmp`, every capability dropped, no new privileges, an init
 * that reaps, and only the mounts the spec names. The network is Docker's default bridge.
 */
export function dockerRunArgs(spec: ContainerSpec, tty: boolean): string[] {
  const args = ["run", "--rm", "-i"];
  if (tty) args.push("-t", "--detach-keys", DETACH_KEYS);
  args.push("--name", spec.name);
  for (const [k, v] of Object.entries(spec.labels)) args.push("--label", `${k}=${v}`);
  args.push(
    "--init",
    "--user",
    spec.user,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,size=4g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "4096",
  );
  for (const m of spec.mounts) args.push("--mount", mountArg(m));
  for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
  args.push("-w", spec.workdir, "--entrypoint", "/bin/sh", spec.image, spec.script);
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
  const bin = options.bin ?? findDocker();
  const call = (args: string[], timeoutMs = 60_000) => exec(bin, args, { timeoutMs });

  return {
    kind: "docker",
    bin,
    async version() {
      const r = await call(["version", "--format", "{{.Server.Version}}"], 20_000);
      const v = r.stdout.trim();
      if (r.code !== 0 || !v) {
        throw new ContainerRuntimeError(
          `Docker isn't running (start Docker Desktop or OrbStack): ${(r.stderr || r.stdout).trim().split("\n")[0] ?? ""}`,
        );
      }
      return v;
    },
    async imageId(ref) {
      const r = await call(["image", "inspect", "--format", "{{.Id}}", ref]);
      const id = r.stdout.trim();
      return r.code === 0 && id ? id : null;
    },
    build(dockerfile, tag) {
      // `docker build -` reads the Dockerfile from stdin with no context: the runner ships as one
      // bundled file, so there is no directory to build from.
      return new Promise((resolve, reject) => {
        const child = spawn(bin, ["build", "--quiet", "--tag", tag, "-"], {
          stdio: ["pipe", "ignore", "pipe"],
          timeout: 30 * 60_000,
        });
        let stderr = "";
        child.stderr.on("data", (c: Buffer) => {
          stderr = (stderr + c.toString("utf8")).slice(-4_000);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new ContainerRuntimeError(`docker build exited ${code}: ${stderr.trim()}`)),
        );
        child.stdin.end(dockerfile);
      });
    },
    runArgv: (spec, tty) => [bin, ...dockerRunArgs(spec, tty)],
    exec: (container, argv) => call(["exec", container, ...argv], 20_000),
    async remove(container) {
      const r = await call(["rm", "-f", container]);
      if (r.code !== 0 && !GONE.test(r.stderr)) {
        throw new ContainerRuntimeError(`docker rm -f ${container} exited ${r.code}: ${r.stderr}`);
      }
    },
    async containers(label) {
      const r = await call([
        "ps",
        "-a",
        "--filter",
        `label=${label}`,
        "--format",
        "{{.Names}}\t{{.Labels}}",
      ]);
      if (r.code !== 0) {
        throw new ContainerRuntimeError(`docker ps exited ${r.code}: ${r.stderr.trim()}`);
      }
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
