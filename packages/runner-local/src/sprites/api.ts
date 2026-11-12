// A cloud sandbox per job (ADR 0480): the small interface the sprites runner needs from a sandbox
// provider, and Sprites (Fly.io, https://sprites.dev) over its HTTP and WebSocket API. Another
// provider would be a second implementation of `SandboxApi`; nothing else in the module names
// Sprites' endpoints.
//
// What this relies on (docs: https://docs.fly.io/sprites/, OpenAPI: https://api.sprites.dev/openapi.json,
// WebSocket spec: https://docs.fly.io/sprites/api/asyncapi.json, SDK: github.com/superfly/sprites-js):
// - `Authorization: Bearer <token>` on every call, the WebSocket upgrade included;
// - `POST /v1/sprites {name, config}`, `GET /v1/sprites/{name}`, `GET /v1/sprites?prefix=`,
//   `DELETE /v1/sprites/{name}`;
// - `POST|GET /v1/sprites/{name}/policy/network` with `{rules: [{domain, action}]}`: a DNS-based
//   egress allowlist enforced outside the sprite, which the sprite can't change;
// - `wss://…/v1/sprites/{name}/exec?cmd=…&stdin=true&env=K=V&dir=…`: without a TTY, binary frames
//   whose first byte is the stream (0 stdin, 1 stdout, 2 stderr, 3 exit with the code, 4 stdin
//   EOF); with `tty=true&rows=&cols=`, raw terminal bytes both ways, `{"type":"resize"}` from the
//   client, `{"type":"session_info"}` and `{"type":"exit","exit_code"}` from the server.
// Spec 36's live-check gate lists what of this must be confirmed against Sprites itself.
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { stat } from "node:fs/promises";

/** A sandbox as the provider reports it. */
export interface SandboxInfo {
  id: string;
  name: string;
  /** `running`, `warm` or `cold` on Sprites. */
  status: string;
  /** When it was created (ms since the epoch), when the provider says. */
  createdAt: number | null;
}

/** One egress rule: a host (`example.com`, `*.example.com`, `*`) allowed or denied. */
export interface EgressRule {
  domain: string;
  action: "allow" | "deny";
}

/** The size a sandbox is created with (sent explicitly, never the provider's default). */
export interface SandboxSize {
  cpus: number;
  memoryMb: number;
  storageGb: number;
}

export interface SandboxExecOptions {
  /** Bytes for the command's stdin, then EOF. */
  stdin?: Buffer | string;
  /** A file streamed as stdin, then EOF (an upload: never held in memory). */
  stdinFile?: string;
  /** Stdout streamed into this file instead of memory (a result bundle). */
  stdoutFile?: string;
  /** The most stdout bytes taken (in memory or the file); more fails the exec. Default 16 MiB. */
  maxStdout?: number;
  env?: Record<string, string>;
  dir?: string;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  code: number;
  /** Empty when `stdoutFile` was given. */
  stdout: Buffer;
  stderr: Buffer;
}

export interface SandboxApi {
  readonly kind: string;
  /** Who the token belongs to, or a provider error (for `doctor`): lists at most one sandbox. */
  check(): Promise<void>;
  create(name: string, size: SandboxSize): Promise<SandboxInfo>;
  /** Null when there is none. */
  get(name: string): Promise<SandboxInfo | null>;
  list(prefix: string): Promise<SandboxInfo[]>;
  /** Gone is fine; anything else throws. */
  destroy(name: string): Promise<void>;
  setEgress(name: string, rules: EgressRule[]): Promise<void>;
  /**
   * The rules in force. Throws on any rule it doesn't recognise (an `include`, a CIDR, an unknown
   * action), so a check against it fails closed.
   */
  getEgress(name: string): Promise<EgressRule[]>;
  /** Runs a command without a TTY and collects its output. */
  exec(name: string, argv: string[], options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** The URL a terminal bridge opens to run `argv` with a TTY (the token is added from a file). */
  ttyUrl(
    name: string,
    argv: string[],
    options: { cols: number; rows: number; dir?: string },
  ): string;
}

export class SandboxApiError extends Error {
  override name = "SandboxApiError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Non-TTY exec frames: the first byte of each binary message. */
export const STREAM = { stdin: 0, stdout: 1, stderr: 2, exit: 3, stdinEof: 4 } as const;

export const SPRITES_API_URL = "https://api.sprites.dev";

/** How long the agent may run with no terminal attached (the bridge reattaches well before). */
export const MAX_RUN_AFTER_DISCONNECT = "10m";

/** The bits of Node 24's WebSocket the client uses (a fake in tests is the real one on localhost). */
type WebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export interface SpritesApiOptions {
  /** Default `https://api.sprites.dev`. */
  apiUrl?: string;
  token: string;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
}

const wsUrl = (http: string) => http.replace(/^http/, "ws");

/** The exec URL for argv (new command): `cmd` repeated, `path` the program. */
export function execUrl(
  apiUrl: string,
  name: string,
  argv: string[],
  params: Record<string, string | string[] | undefined>,
): string {
  const url = new URL(`${wsUrl(apiUrl)}/v1/sprites/${encodeURIComponent(name)}/exec`);
  for (const arg of argv) url.searchParams.append("cmd", arg);
  if (argv[0]) url.searchParams.set("path", argv[0]);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
  }
  return url.toString();
}

const DOMAIN = /^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/;

/**
 * Reads a policy's rules strictly: only `{domain, action}` with a host name (or `*`) and `allow` or
 * `deny`, and no other keys. Anything else throws (fail closed).
 */
export function parseEgressRules(raw: unknown): EgressRule[] {
  const rules = (raw as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(rules)) throw new SandboxApiError("the network policy has no rules list");
  return rules.map((r, i) => {
    const rule = r as Record<string, unknown>;
    const keys = rule && typeof rule === "object" ? Object.keys(rule).sort().join(",") : "";
    if (
      keys !== "action,domain" ||
      typeof rule.domain !== "string" ||
      !DOMAIN.test(rule.domain.toLowerCase()) ||
      (rule.action !== "allow" && rule.action !== "deny")
    ) {
      throw new SandboxApiError(
        `the network policy has a rule the runner doesn't understand (#${i}): ${JSON.stringify(r).slice(0, 200)}`,
      );
    }
    return { domain: rule.domain.toLowerCase(), action: rule.action };
  });
}

/** Sprites over its API. */
export function spritesApi(options: SpritesApiOptions): SandboxApi {
  const apiUrl = (options.apiUrl ?? SPRITES_API_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const WS = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const auth = { authorization: `Bearer ${options.token}` };

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return doFetch(`${apiUrl}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function must(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await call(method, path, body);
    const text = await res.text();
    if (!res.ok) {
      throw new SandboxApiError(
        `Sprites ${method} ${path.split("?")[0]} answered ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const info = (raw: unknown): SandboxInfo => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const created = typeof r.created_at === "string" ? Date.parse(r.created_at) : Number.NaN;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      status: String(r.status ?? ""),
      createdAt: Number.isFinite(created) ? created : null,
    };
  };
  const sprite = (name: string) => `/v1/sprites/${encodeURIComponent(name)}`;

  return {
    kind: "sprites",
    async check() {
      await must("GET", "/v1/sprites?max_results=1");
    },
    async create(name, size) {
      const made = info(
        await must("POST", "/v1/sprites", {
          name,
          // Sent explicitly (spec 36's gate checks the server honours it).
          config: { cpus: size.cpus, ram_mb: size.memoryMb, storage_gb: size.storageGb },
        }),
      );
      if (made.name && made.name !== name) {
        throw new SandboxApiError(`Sprites made ${made.name}, not ${name}`);
      }
      return made;
    },
    async get(name) {
      const res = await call("GET", sprite(name));
      if (res.status === 404) return null;
      const text = await res.text();
      if (!res.ok) {
        throw new SandboxApiError(`Sprites GET sprite answered ${res.status}: ${text}`, res.status);
      }
      return info(JSON.parse(text));
    },
    async list(prefix) {
      const out: SandboxInfo[] = [];
      let token: string | undefined;
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({ prefix, max_results: "500" });
        if (token) q.set("continuation_token", token);
        const r = (await must("GET", `/v1/sprites?${q}`)) as {
          sprites?: unknown[];
          has_more?: boolean;
          next_continuation_token?: string;
        } | null;
        for (const s of r?.sprites ?? []) {
          const one = info(s);
          // Filter here too: a prefix the server ignored must not reap someone else's sprite.
          if (one.name.startsWith(prefix)) out.push(one);
        }
        if (!r?.has_more || !r.next_continuation_token) break;
        token = r.next_continuation_token;
      }
      return out;
    },
    async destroy(name) {
      const res = await call("DELETE", sprite(name));
      if (!res.ok && res.status !== 404) {
        throw new SandboxApiError(
          `Sprites DELETE sprite answered ${res.status}: ${(await res.text()).slice(0, 300)}`,
          res.status,
        );
      }
    },
    async setEgress(name, rules) {
      await must("POST", `${sprite(name)}/policy/network`, { rules });
    },
    async getEgress(name) {
      return parseEgressRules(await must("GET", `${sprite(name)}/policy/network`));
    },
    exec(name, argv, execOptions = {}) {
      const env = Object.entries(execOptions.env ?? {}).map(([k, v]) => `${k}=${v}`);
      const url = execUrl(apiUrl, name, argv, {
        stdin: "true",
        ...(env.length ? { env } : {}),
        ...(execOptions.dir ? { dir: execOptions.dir } : {}),
      });
      const maxStdout = execOptions.maxStdout ?? 16 << 20;
      return new Promise<SandboxExecResult>((resolve, reject) => {
        const ws = new WS(url, { headers: auth });
        ws.binaryType = "arraybuffer";
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let file: WriteStream | null = execOptions.stdoutFile
          ? createWriteStream(execOptions.stdoutFile, { mode: 0o600 })
          : null;
        let code: number | null = null;
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          const done = () => {
            if (err) reject(err);
            else if (code === null) {
              reject(new SandboxApiError(`exec ${argv[0]} in ${name} ended with no exit code`));
            } else {
              resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
            }
          };
          if (file) {
            const f = file;
            file = null;
            f.end(done);
          } else done();
        };
        const timer = setTimeout(
          () => finish(new SandboxApiError(`exec ${argv[0]} timed out`)),
          execOptions.timeoutMs ?? 120_000,
        );
        const sendStdin = async () => {
          const frame = (chunk: Buffer) => Buffer.concat([Buffer.from([STREAM.stdin]), chunk]);
          // Backpressure: wait while the socket holds more than 8 MiB unsent.
          const drain = async () => {
            while (ws.bufferedAmount > 8 << 20 && !settled) {
              await new Promise((r) => setTimeout(r, 20));
            }
          };
          if (execOptions.stdinFile) {
            for await (const chunk of createReadStream(execOptions.stdinFile, {
              highWaterMark: 1 << 20,
            })) {
              if (settled) return;
              ws.send(frame(chunk as Buffer));
              await drain();
            }
          } else if (execOptions.stdin !== undefined) {
            const input = Buffer.isBuffer(execOptions.stdin)
              ? execOptions.stdin
              : Buffer.from(execOptions.stdin);
            for (let i = 0; i < input.length; i += 1 << 20) {
              ws.send(frame(input.subarray(i, i + (1 << 20))));
              await drain();
            }
          }
          if (!settled) ws.send(Buffer.from([STREAM.stdinEof]));
        };
        ws.addEventListener("open", () => {
          sendStdin().catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
        });
        ws.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            try {
              const msg = JSON.parse(event.data) as { type?: string; exit_code?: number };
              if (msg.type === "exit" && typeof msg.exit_code === "number") {
                code = msg.exit_code;
                finish();
              }
            } catch {}
            return;
          }
          const data = Buffer.from(event.data as ArrayBuffer);
          if (data.length === 0) return;
          const payload = data.subarray(1);
          if (data[0] === STREAM.stdout) {
            stdoutBytes += payload.length;
            if (stdoutBytes > maxStdout) {
              finish(new SandboxApiError(`exec ${argv[0]} wrote over ${maxStdout} bytes`));
              return;
            }
            if (file) file.write(payload);
            else stdout.push(payload);
          } else if (data[0] === STREAM.stderr) {
            stderrBytes += payload.length;
            if (stderrBytes <= 1 << 20) stderr.push(payload);
          } else if (data[0] === STREAM.exit) {
            code = payload.length > 0 ? (payload[0] ?? 0) : 0;
            finish();
          }
        });
        ws.addEventListener("error", (event) => {
          const message = (event as unknown as { message?: string }).message ?? "WebSocket error";
          finish(new SandboxApiError(`exec ${argv[0]} in ${name}: ${message}`));
        });
        ws.addEventListener("close", (event) => {
          // No exit frame is never a success, whatever the close code: a truncated upload or
          // result must not look fine.
          if (code === null) {
            finish(
              new SandboxApiError(
                `exec ${argv[0]} in ${name} closed ${event.code} with no exit code${event.reason ? `: ${event.reason}` : ""}`,
              ),
            );
          }
        });
      });
    },
    ttyUrl(name, argv, ttyOptions) {
      return execUrl(apiUrl, name, argv, {
        stdin: "true",
        tty: "true",
        cols: String(ttyOptions.cols),
        rows: String(ttyOptions.rows),
        ...(ttyOptions.dir ? { dir: ttyOptions.dir } : {}),
        // The agent stops if the host's bridge is gone this long (it gives up reattaching before).
        max_run_after_disconnect: MAX_RUN_AFTER_DISCONNECT,
      });
    },
  };
}

/** A file's size, for the upload cap. */
export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
