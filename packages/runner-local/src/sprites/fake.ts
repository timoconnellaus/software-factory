// Test support: a fake Sprites API (ADR 0480) on localhost, answering the endpoints `spritesApi`
// uses with the same shapes and framing: bearer auth, create/get/list/destroy, the network policy,
// and exec over a WebSocket, without a TTY (stream-prefixed binary frames, stdin until EOF, an exit
// frame) and with one (raw bytes, `session_info`, `resize`, `exit`, reattach by session id).
//
// Each sprite is a directory: a sprite path `/a/b` is `<root>/<sprite>/a/b`. The runner's fixed
// scripts (`scripts.ts`) run for real with every absolute path argument mapped there, so the
// upload, the pull, the sha check and the result bundle are the real thing over real git. The TTY's
// entry script runs for real too (it loads the credential file, deletes it, sets the environment),
// up to the harness's launch script, which a stub replaces: it records the environment, and the
// test's `fakeClaude` stands in for Claude from there. Only the toolchain install is recorded
// instead of run, and `ps` answers from the sprite's process table. Not used at runtime.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, normalize } from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  LAUNCH_RECORD,
  type LaunchRecord,
  type StatusLine,
} from "@software-factory/harness-claude";
import type { FakeSession } from "../testing.ts";
import type { EgressRule } from "./api.ts";
import { STREAM } from "./api.ts";
import { scriptName } from "./scripts.ts";
import { runTtyBridge, type TtyBridgeConfig } from "./tty-bridge.ts";
import { acceptWebSocket, type ServerSocket } from "./ws-server.ts";

export interface FakeTty {
  id: string;
  argv: string[];
  sprite: FakeSprite;
  /** Output to the terminal (kept for a reattach). */
  write(data: string | Buffer): void;
  onInput(fn: (data: Buffer) => void): void;
  exit(code: number): void;
  sizes: Array<{ cols: number; rows: number }>;
  exited: boolean;
  /** The socket the terminal is on now (a reattach replaces it). */
  socket: ServerSocket | null;
  /** What reads the terminal's input. */
  inputs: Array<(data: Buffer) => void>;
  /** The environment the real entry script handed the launch script (null: no entry script). */
  env: Record<string, string> | null;
}

export interface FakeSprite {
  id: string;
  name: string;
  /** The sprite's filesystem root on this machine. */
  root: string;
  egress: EgressRule[];
  processes: Map<number, string>;
  provisioned: string[][];
  ttys: FakeTty[];
  /** Every exec's argv, in order. */
  execs: string[][];
  /** The `config` it was created with (its size). */
  config: Record<string, unknown> | null;
  createdAt: string;
}

export interface FakeSpritesOptions {
  token?: string;
  /** The test's command for a TTY exec (the agent's session). */
  onTty?: (tty: FakeTty, map: (path: string) => string) => void;
  /** What `ps -p <pid>` prints (default: the sprite's process table). */
  ps?: (sprite: FakeSprite, pid: number) => string | null;
  /** Changes what the policy GET returns (any shape: the client must refuse what it can't read). */
  egressView?: (sprite: FakeSprite) => unknown[];
  /** Changes what the sprite GET returns. */
  infoView?: (sprite: FakeSprite) => Record<string, unknown>;
}

export async function fakeSpritesApi(root: string, options: FakeSpritesOptions = {}) {
  const token = options.token ?? "org/0001/tok/the-owners-sprites-token";
  const sprites = new Map<string, FakeSprite>();
  const calls: string[] = [];
  const ttys = new Map<string, FakeTty>();
  /** The entry scripts' process groups, killed when their terminal ends. */
  const children = new Map<FakeTty, ChildProcess>();
  const killTty = (tty: FakeTty) => {
    const child = children.get(tty);
    children.delete(tty);
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  };

  const mapFor = (sprite: FakeSprite) => (path: string) => {
    if (!path.startsWith("/")) return path;
    return join(sprite.root, normalize(path));
  };
  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const view = (s: FakeSprite) =>
    options.infoView?.(s) ?? {
      id: s.id,
      name: s.name,
      organization: "personal",
      status: "running",
      url: `https://${s.name}-0001.sprites.app`,
      created_at: s.createdAt,
    };
  const authed = (req: IncomingMessage) => req.headers.authorization === `Bearer ${token}`;
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = "";
      req.on("data", (c) => {
        text += c;
      });
      req.on("end", () => resolve(text));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    if (!authed(req)) return json(res, 401, { error: "unauthorized" });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "v1" || parts[1] !== "sprites") return json(res, 404, { error: "not found" });
    const name = parts[2];
    if (!name) {
      if (req.method === "GET") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const list = [...sprites.values()].filter((s) => s.name.startsWith(prefix)).map(view);
        return json(res, 200, { sprites: list, has_more: false });
      }
      if (req.method === "POST") {
        const input = JSON.parse((await body(req)) || "{}") as {
          name?: string;
          config?: Record<string, unknown>;
        };
        if (!input.name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.name)) {
          return json(res, 400, { error: "invalid name" });
        }
        if (sprites.has(input.name)) return json(res, 409, { error: "already exists" });
        const sprite: FakeSprite = {
          id: `sprite-${randomUUID()}`,
          name: input.name,
          root: join(root, input.name),
          egress: [],
          processes: new Map(),
          provisioned: [],
          ttys: [],
          execs: [],
          config: input.config ?? null,
          createdAt: new Date().toISOString(),
        };
        mkdirSync(sprite.root, { recursive: true });
        sprites.set(sprite.name, sprite);
        return json(res, 201, view(sprite));
      }
      return json(res, 405, {});
    }
    const sprite = sprites.get(name);
    if (!sprite) return json(res, 404, { error: "sprite not found" });
    if (parts.length === 3) {
      if (req.method === "GET") return json(res, 200, view(sprite));
      if (req.method === "DELETE") {
        sprites.delete(name);
        for (const t of sprite.ttys) {
          t.exited = true;
          killTty(t);
          t.socket?.close(1011, "sprite destroyed");
        }
        rmSync(sprite.root, { recursive: true, force: true });
        res.writeHead(204).end();
        return;
      }
    }
    if (parts[3] === "policy" && parts[4] === "network") {
      if (req.method === "GET") {
        return json(res, 200, { rules: options.egressView?.(sprite) ?? sprite.egress });
      }
      if (req.method === "POST") {
        const input = JSON.parse((await body(req)) || "{}") as { rules?: EgressRule[] };
        sprite.egress = input.rules ?? [];
        return json(res, 200, { rules: sprite.egress });
      }
    }
    return json(res, 404, { error: "not found" });
  });

  /** A non-TTY exec: the scripts for real (paths mapped), `ps` from the table. */
  async function runExec(
    sprite: FakeSprite,
    argv: string[],
    env: Record<string, string>,
    dir: string | null,
    stdin: Buffer,
  ): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    sprite.execs.push(argv);
    const map = mapFor(sprite);
    if (argv[0] === "ps") {
      const pid = Number(argv[argv.indexOf("-p") + 1]);
      const line = options.ps ? options.ps(sprite, pid) : (sprite.processes.get(pid) ?? null);
      return line === null
        ? { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
        : { code: 0, stdout: Buffer.from(`${line}\n`), stderr: Buffer.alloc(0) };
    }
    if (argv[0] !== "sh" || argv[1] !== "-c" || !argv[2]) {
      return { code: 127, stdout: Buffer.alloc(0), stderr: Buffer.from(`unscripted: ${argv[0]}`) };
    }
    const script = argv[2];
    const args = argv.slice(4);
    if (scriptName(script) === "provision") {
      sprite.provisioned.push(args);
      const prefix = map(args[1] ?? "/opt/software-factory");
      mkdirSync(join(prefix, "bin"), { recursive: true });
      return {
        code: 0,
        stdout: Buffer.from(`provisioned: claude ${args[0]}, node v24\n`),
        stderr: Buffer.alloc(0),
      };
    }
    const mapped = args.map((a) => (a === "/" ? sprite.root : map(a)));
    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", script, "sf", ...mapped], {
        cwd: dir && existsSync(map(dir)) ? map(dir) : sprite.root,
        env: { ...process.env, ...env, SF_SUDO: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
      child.on("close", (code) =>
        resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
      );
    });
  }

  /** Upgraded sockets: `closeAllConnections` doesn't know them. */
  const upgraded = new Set<import("node:stream").Duplex>();
  server.on("upgrade", (req, socket) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`WS ${url.pathname}`);
    if (!authed(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const sprite = sprites.get(parts[2] ?? "");
    if (!sprite || parts[3] !== "exec") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const ws = acceptWebSocket(req, socket);
    const argv = url.searchParams.getAll("cmd");
    const env = Object.fromEntries(
      url.searchParams.getAll("env").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    const sessionId = parts[4];
    if (sessionId) {
      // Reattach: the session's terminal moves to this socket.
      const tty = ttys.get(sessionId);
      if (!tty || tty.exited) {
        ws.close(1011, "no such session");
        return;
      }
      bindTty(tty, ws);
      return;
    }
    if (url.searchParams.get("tty") === "true") {
      const tty: FakeTty = {
        id: String(ttys.size + 1),
        argv,
        sprite,
        sizes: [],
        exited: false,
        socket: null,
        inputs: [],
        env: null,
        write(data) {
          this.socket?.send(Buffer.from(data));
        },
        onInput(fn) {
          this.inputs.push(fn);
        },
        exit(code) {
          if (this.exited) return;
          this.exited = true;
          killTty(this);
          this.socket?.send(JSON.stringify({ type: "exit", exit_code: code }));
          this.socket?.close(1000);
        },
      };
      ttys.set(tty.id, tty);
      sprite.ttys.push(tty);
      bindTty(tty, ws);
      void runEntry(sprite, tty).then(
        () => options.onTty?.(tty, mapFor(sprite)),
        (err) => {
          tty.write(`fake sprite: ${err instanceof Error ? err.message : err}\r\n`);
          tty.exit(1);
        },
      );
      return;
    }
    const stdin: Buffer[] = [];
    let started = false;
    ws.onMessage((data, binary) => {
      if (!binary || started) return;
      if (data[0] === STREAM.stdin) stdin.push(data.subarray(1));
      if (data[0] === STREAM.stdinEof) {
        started = true;
        void runExec(sprite, argv, env, url.searchParams.get("dir"), Buffer.concat(stdin)).then(
          (r) => {
            for (let i = 0; i < r.stdout.length; i += 64 * 1024) {
              ws.send(
                Buffer.concat([Buffer.from([STREAM.stdout]), r.stdout.subarray(i, i + 64 * 1024)]),
              );
            }
            if (r.stderr.length) ws.send(Buffer.concat([Buffer.from([STREAM.stderr]), r.stderr]));
            ws.send(Buffer.from([STREAM.exit, r.code & 0xff]));
            setTimeout(() => ws.close(1000), 20);
          },
        );
      }
    });
  });

  /**
   * Runs the TTY's entry script for real (its path arguments mapped), with a stub in place of the
   * harness's launch script that records the environment it was handed and then waits.
   */
  async function runEntry(sprite: FakeSprite, tty: FakeTty): Promise<void> {
    const map = mapFor(sprite);
    const entry = tty.argv[1] ? map(tty.argv[1]) : "";
    if (!entry || !existsSync(entry) || scriptName(readFileSync(entry, "utf8")) !== "entry") return;
    const fake = join(sprite.root, ".fake");
    mkdirSync(fake, { recursive: true });
    const dump = join(fake, `env-${tty.id}`);
    const stub = join(fake, "launch-stub.sh");
    writeFileSync(
      stub,
      `#!/bin/sh
env > "$SF_FAKE_ENV_DUMP.tmp" && mv "$SF_FAKE_ENV_DUMP.tmp" "$SF_FAKE_ENV_DUMP"
exec sleep 600
`,
    );
    const args = tty.argv.slice(2).map((a, i) => (i === 1 ? stub : a.startsWith("/") ? map(a) : a));
    const child = spawn("sh", [entry, ...args], {
      cwd: sprite.root,
      env: { ...process.env, SF_FAKE_ENV_DUMP: dump },
      stdio: "ignore",
      detached: true,
    });
    children.set(tty, child);
    let exited: number | null = null;
    child.on("exit", (code) => {
      exited = code ?? 1;
    });
    for (let i = 0; i < 250 && !existsSync(dump); i++) {
      if (exited !== null) throw new Error(`the entry script exited ${exited}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!existsSync(dump)) throw new Error("the entry script never reached the launch script");
    tty.env = Object.fromEntries(
      readFileSync(dump, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  }

  function bindTty(tty: FakeTty, ws: ServerSocket) {
    tty.socket?.close(1000);
    tty.socket = ws;
    ws.send(
      JSON.stringify({ type: "session_info", session_id: tty.id, tty: true, is_owner: true }),
    );
    ws.onMessage((data, binary) => {
      if (tty.socket !== ws) return;
      if (!binary) {
        try {
          const msg = JSON.parse(data.toString()) as {
            type?: string;
            cols?: number;
            rows?: number;
          };
          if (msg.type === "resize") tty.sizes.push({ cols: msg.cols ?? 0, rows: msg.rows ?? 0 });
        } catch {}
        return;
      }
      for (const fn of tty.inputs) fn(data);
    });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    sprites,
    calls,
    /** Drops a terminal's socket without ending its command (a network blip). */
    drop(spriteName: string) {
      for (const t of sprites.get(spriteName)?.ttys ?? []) t.socket?.close(1006);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const tty of [...children.keys()]) killTty(tty);
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface FakeClaudeOptions {
  pid?: number;
  /** What `ps` shows for the process (default: the launch record's argv). */
  command?: (record: LaunchRecord) => string;
  /** No SessionStart (Claude never comes up). */
  noSessionStart?: boolean;
  /**
   * What the agent does after the first prompt is submitted, in the sprite: `map` turns a sprite
   * path into this machine's, `append` writes a status line, `git` runs git in the sprite's repo.
   */
  onPrompt?: (agent: FakeAgent) => unknown;
  /** Every credential the real entry script loaded into Claude's environment. */
  credentials?: string[];
}

export interface FakeAgent {
  /** The sprite's working tree, on this machine. */
  work: string;
  map: (path: string) => string;
  append: (line: Partial<StatusLine>) => void;
  git: (...args: string[]) => string;
  record: LaunchRecord;
  tty: FakeTty;
  /** What was typed and submitted, in order. */
  submitted: string[];
}

/**
 * Stands in for Claude in the sprite, as `scriptedTmux` does on the host: the TTY's command is the
 * entry script; it reads the credential file (and deletes it, as the script does), records the
 * launch's pid and process, writes the hook's SessionStart, and on a submitted prompt writes
 * UserPromptSubmit and lets the test's agent work in the sprite's repo.
 */
export function fakeClaude(options: FakeClaudeOptions = {}) {
  return (tty: FakeTty, map: (path: string) => string) => {
    // The entry script's arguments: the credential file, then the launch script.
    const launchScript = tty.argv[3] ?? "";
    const credential = tty.env?.CLAUDE_CODE_OAUTH_TOKEN ?? tty.env?.ANTHROPIC_API_KEY;
    if (credential) options.credentials?.push(credential);
    const runDir = dirname(launchScript);
    const record = JSON.parse(
      readFileSync(map(join(runDir, LAUNCH_RECORD)), "utf8"),
    ) as LaunchRecord;
    const pid = options.pid ?? 4242;
    tty.sprite.processes.set(
      pid,
      options.command ? options.command(record) : record.argv.join(" "),
    );
    writeFileSync(map(record.pidFile), `${pid}\n`);
    const statusFile = map(join(runDir, "status.jsonl"));
    const append = (line: Partial<StatusLine>) =>
      appendFileSync(statusFile, `${JSON.stringify({ time: Date.now(), ...line })}\n`);
    if (!options.noSessionStart) append({ event: "SessionStart", reason: "startup" });
    tty.write("Claude Code (fake, in a sprite)\r\n");
    const gitDir = (() => {
      const dotGit = readFileSync(map(join(record.worktree, ".git")), "utf8");
      return map(/^gitdir: (.+)$/m.exec(dotGit)?.[1]?.trim() ?? "");
    })();
    const work = map(record.worktree);
    const agent: FakeAgent = {
      work,
      map,
      append,
      record,
      tty,
      submitted: [],
      git: (...args) => agentGit(work, gitDir, args),
    };
    let typed = "";
    tty.onInput((data) => {
      for (const ch of data.toString("utf8")) {
        if (ch === "\r") {
          if (!typed) continue;
          agent.submitted.push(typed);
          typed = "";
          append({ event: "UserPromptSubmit" });
          if (agent.submitted.length === 1 && options.onPrompt) {
            void Promise.resolve(options.onPrompt(agent));
          }
        } else if (ch >= " ") {
          typed += ch;
          tty.write(ch);
        }
      }
    });
  };
}

function agentGit(work: string, gitDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: work,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "agent",
      GIT_AUTHOR_EMAIL: "agent@x.invalid",
      GIT_COMMITTER_NAME: "agent",
      GIT_COMMITTER_EMAIL: "agent@x.invalid",
    },
  }).trim();
}

/**
 * `scriptedTmux`'s `spawn` for a sprite job: the pane runs the real bridge in-process (its config
 * from the pane's `sprite.sh`), with what tmux would type going to its stdin and its output kept as
 * the pane's screen.
 */
export function bridgeSpawn() {
  return (session: FakeSession, script: string) => {
    const text = readFileSync(script, "utf8");
    const config = /'?([^'\s]+sprite-tty\.json)'?\s*$/m.exec(text)?.[1] ?? "";
    const stdin = new PassThrough();
    const stdout = Object.assign(
      new Writable({
        write(chunk, _enc, done) {
          session.screen = `${session.screen}${chunk.toString()}`.slice(-4_000);
          done();
        },
      }),
      { columns: 120, rows: 40 },
    );
    void runTtyBridge(JSON.parse(readFileSync(config, "utf8")) as TtyBridgeConfig, {
      stdin,
      stdout,
      backoffMs: 20,
    })
      .catch(() => 1)
      .then(() => {
        session.dead = true;
      });
    return { write: (data: string) => void stdin.write(data) };
  };
}
