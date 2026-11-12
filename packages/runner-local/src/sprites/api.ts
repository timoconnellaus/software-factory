// A cloud sandbox per job (ADR 0460): the small interface the sprites runner needs from a sandbox
// provider, and Sprites (Fly.io, https://sprites.dev) over its HTTP and WebSocket API. Another
// provider would be a second implementation of `SandboxApi`; nothing else in the module names
// Sprites' endpoints.
//
// What this relies on (docs: https://docs.fly.io/sprites/, OpenAPI: https://api.sprites.dev/openapi.json,
// WebSocket spec: https://docs.fly.io/sprites/api/asyncapi.json, SDK: github.com/superfly/sprites-js):
// - `Authorization: Bearer <token>` on every call, the WebSocket upgrade included;
// - `POST /v1/sprites {name}`, `GET /v1/sprites/{name}`, `GET /v1/sprites?prefix=`,
//   `DELETE /v1/sprites/{name}`;
// - `POST|GET /v1/sprites/{name}/policy/network` with `{rules: [{domain, action}]}`: a DNS-based
//   egress allowlist enforced outside the sprite, which the sprite can't change;
// - `wss://…/v1/sprites/{name}/exec?cmd=…&stdin=true&env=K=V&dir=…`: without a TTY, binary frames
//   whose first byte is the stream (0 stdin, 1 stdout, 2 stderr, 3 exit with the code, 4 stdin
//   EOF); with `tty=true&rows=&cols=`, raw terminal bytes both ways, `{"type":"resize"}` from the
//   client, `{"type":"session_info"}` and `{"type":"exit","exit_code"}` from the server.

/** A sandbox as the provider reports it. */
export interface SandboxInfo {
  id: string;
  name: string;
  /** `running`, `warm` or `cold` on Sprites. */
  status: string;
}

/** One egress rule: a host (`example.com`, `*.example.com`) allowed or denied. */
export interface EgressRule {
  domain: string;
  action: "allow" | "deny";
}

export interface SandboxExecOptions {
  /** Bytes for the command's stdin, then EOF. */
  stdin?: Buffer | string;
  env?: Record<string, string>;
  dir?: string;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** How a terminal (the job's tmux pane) connects to a command in the sandbox with a TTY. */
export interface SandboxTty {
  url: string;
  /** Sent on the upgrade; holds the provider token, so it is never written to disk or argv. */
  headers?: Record<string, string>;
}

export interface SandboxApi {
  readonly kind: string;
  /** Who the token belongs to, or a provider error (for `doctor`): lists at most one sandbox. */
  check(): Promise<void>;
  create(name: string): Promise<SandboxInfo>;
  /** Null when there is none. */
  get(name: string): Promise<SandboxInfo | null>;
  list(prefix: string): Promise<SandboxInfo[]>;
  /** Gone is fine. */
  destroy(name: string): Promise<void>;
  setEgress(name: string, rules: EgressRule[]): Promise<void>;
  /** The rules in force, or null when the provider doesn't say. */
  getEgress(name: string): Promise<EgressRule[] | null>;
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

/** Sprites over its API. */
export function spritesApi(options: SpritesApiOptions): SandboxApi {
  const apiUrl = (options.apiUrl ?? SPRITES_API_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const WS = options.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
  const auth = { authorization: `Bearer ${options.token}` };

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await doFetch(`${apiUrl}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res;
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
    return { id: String(r.id ?? ""), name: String(r.name ?? ""), status: String(r.status ?? "") };
  };
  const sprite = (name: string) => `/v1/sprites/${encodeURIComponent(name)}`;

  return {
    kind: "sprites",
    async check() {
      await must("GET", "/v1/sprites?max_results=1");
    },
    async create(name) {
      return info(await must("POST", "/v1/sprites", { name }));
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
      const r = (await must("GET", `${sprite(name)}/policy/network`)) as {
        rules?: Array<Record<string, unknown>>;
      } | null;
      if (!r?.rules) return null;
      return r.rules
        .filter((x) => typeof x.domain === "string")
        .map((x) => ({
          domain: String(x.domain),
          action: x.action === "deny" ? "deny" : "allow",
        }));
    },
    exec(name, argv, execOptions = {}) {
      const env = Object.entries(execOptions.env ?? {}).map(([k, v]) => `${k}=${v}`);
      const url = execUrl(apiUrl, name, argv, {
        stdin: "true",
        ...(env.length ? { env } : {}),
        ...(execOptions.dir ? { dir: execOptions.dir } : {}),
      });
      return new Promise<SandboxExecResult>((resolve, reject) => {
        const ws = new WS(url, { headers: auth });
        ws.binaryType = "arraybuffer";
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let code: number | null = null;
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            ws.close();
          } catch {}
          if (err) reject(err);
          else
            resolve({
              code: code ?? 1,
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
            });
        };
        const timer = setTimeout(
          () => finish(new SandboxApiError(`exec ${argv[0]} timed out`)),
          execOptions.timeoutMs ?? 120_000,
        );
        ws.addEventListener("open", () => {
          const input =
            execOptions.stdin === undefined
              ? Buffer.alloc(0)
              : Buffer.isBuffer(execOptions.stdin)
                ? execOptions.stdin
                : Buffer.from(execOptions.stdin);
          // Frames of at most 1 MiB, then EOF.
          for (let i = 0; i < input.length; i += 1 << 20) {
            ws.send(Buffer.concat([Buffer.from([STREAM.stdin]), input.subarray(i, i + (1 << 20))]));
          }
          ws.send(Buffer.from([STREAM.stdinEof]));
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
          if (data[0] === STREAM.stdout) stdout.push(payload);
          else if (data[0] === STREAM.stderr) stderr.push(payload);
          else if (data[0] === STREAM.exit) {
            code = payload.length > 0 ? (payload[0] ?? 0) : 0;
            finish();
          }
        });
        ws.addEventListener("error", (event) => {
          const message = (event as unknown as { message?: string }).message ?? "WebSocket error";
          finish(new SandboxApiError(`exec ${argv[0]} in ${name}: ${message}`));
        });
        ws.addEventListener("close", (event) => {
          if (code === null && !settled) {
            // No exit frame: 1000 is a clean exit (the SDK reads it as 0), anything else failed.
            if (event.code === 1000) code = 0;
            else {
              finish(
                new SandboxApiError(
                  `exec ${argv[0]} in ${name} closed ${event.code}${event.reason ? `: ${event.reason}` : ""}`,
                ),
              );
              return;
            }
          }
          finish();
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
        // The agent stops if the host's bridge is gone this long (it reattaches before then).
        max_run_after_disconnect: "10m",
      });
    },
  };
}
