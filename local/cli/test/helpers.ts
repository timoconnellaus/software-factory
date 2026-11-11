// A fake engine speaking `/cli/v1`, and a way to run `sf` against it with a scratch config dir.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationInfo } from "../src/api.ts";
import { type CliConfig, saveConfig } from "../src/config.ts";
import { type Io, main } from "../src/main.ts";

export const URL_ = "https://engine.test";
export const APP = "https://app.test";
export const NOW = Date.parse("2026-11-12T12:00:00Z");

export const wi = (n: number) => `wi_${String(n).padStart(32, "0")}`;
export const prj = (n: number) => `prj_${String(n).padStart(32, "0")}`;

export type Handler = (input: Record<string, unknown>) => unknown;
/** What a handler throws to answer with an error. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export interface Engine {
  fetch: typeof fetch;
  calls: { op: string; input: Record<string, unknown>; token: string | null }[];
}

export function engine(
  handlers: Record<string, Handler>,
  operations: Partial<OperationInfo>[] = [],
): Engine {
  const calls: Engine["calls"] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    const token = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1] ?? null;
    if (url.pathname === "/cli/v1/ops") {
      return Response.json({
        operations: operations.map((o) => ({
          description: "",
          risk: "read",
          actors: ["human"],
          permission: "member",
          gateKind: null,
          browserOnly: false,
          ...o,
        })),
      });
    }
    if (url.pathname !== "/cli/v1/call") return Response.json({ error: "nope" }, { status: 404 });
    const body = JSON.parse(String(init?.body)) as { op: string; input: Record<string, unknown> };
    calls.push({ op: body.op, input: body.input, token });
    const handler = handlers[body.op];
    if (!handler) {
      return Response.json({ error: `no ${body.op}`, code: "unknown_operation" }, { status: 404 });
    }
    try {
      const result = handler(body.input);
      if (result instanceof Reply) return Response.json(result.body, { status: result.status });
      return Response.json({ result });
    } catch (err) {
      if (err instanceof Reply) return Response.json(err.body, { status: err.status });
      throw err;
    }
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

export async function scratchHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sf-cli-"));
}

export const configPath = (home: string) => join(home, "software-factory", "cli.json");

export async function loggedIn(home: string, config: CliConfig = {}): Promise<void> {
  await saveConfig(configPath(home), {
    url: URL_,
    appUrl: APP,
    token: "sfc_token",
    tokenId: "clt_1",
    scope: "read",
    login: "tim",
    expiresAt: "2026-12-12T00:00:00Z",
    ...config,
  });
}

export async function sf(
  argv: string[],
  options: { home: string; fetch: typeof fetch; env?: NodeJS.ProcessEnv; stdin?: string },
) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const io: Io = {
    env: { HOME: options.home, XDG_CONFIG_HOME: options.home, ...options.env },
    fetch: options.fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    open: (u) => opened.push(u),
    readStdin: async () => options.stdin ?? "",
    readFile: async () => {
      throw new Error("no files in tests");
    },
    now: () => NOW,
    sleep: async () => {},
  };
  const code = await main(argv, io);
  return { code, out, err, opened, stdout: out.join("\n"), stderr: err.join("\n") };
}

export function item(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: wi(n),
    projectId: prj(1),
    orgId: "org_1",
    number: n,
    title: `Item ${n}`,
    kind: "change",
    stage: "build",
    status: "running",
    statusReason: null,
    size: "small",
    requesterUserId: "u_1",
    source: "app",
    branch: `factory/${n}-item`,
    prUrl: null,
    createdAt: "2026-11-12T10:00:00Z",
    updatedAt: "2026-11-12T11:00:00Z",
    ...extra,
  };
}

export function project(n: number, name: string, orgId = "org_1") {
  return {
    id: prj(n),
    orgId,
    name,
    slug: name.toLowerCase(),
    repo: { owner: "o", name: name.toLowerCase(), defaultBranch: "main" },
  };
}
